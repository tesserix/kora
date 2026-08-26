package billing

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Order states. `created` is a promise to pay, nothing more: no entitlement
// exists until the gateway says the money moved.
const (
	// Gateway status vocabulary. These are the values a `gateway` reports back
	// from FetchOrder, and every provider maps ITS OWN wire values into them.
	//
	// They happen to be Cashfree's literal API strings, because Cashfree was
	// the first provider and the reconcile switch was written against its
	// responses directly. That is history, not a contract with Cashfree: a
	// second provider (kora#478) has no reason to speak Cashfree's dialect, so
	// the names are stated here as KORA's vocabulary and each client is
	// responsible for translating into it. Anything a provider reports that is
	// neither of these is "still in flight" and reconcile leaves the order
	// alone — which is the safe default, since the webhook is what settles.
	GatewayPaid    = "PAID"
	GatewayExpired = "EXPIRED"

	OrderCreated = "created"
	OrderPaid    = "paid"
	OrderFailed  = "failed"
	OrderExpired = "expired"
)

// ErrOrderNotFound is returned for an order that does not exist OR belongs to
// somebody else. One error for both, deliberately: the caller must not be able
// to probe which order ids are real.
var ErrOrderNotFound = errors.New("billing: order not found")

// ErrAmountMismatch means the gateway settled a different amount than the one
// Kora priced. The order is NOT granted; it is left for a human, because
// silently granting the pack would let a tampered checkout buy at any price.
var ErrAmountMismatch = errors.New("billing: settled amount does not match the order")

// Order is one purchase attempt with its price frozen at creation time.
type Order struct {
	ID               uuid.UUID  `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID           uuid.UUID  `json:"-"`
	PackCode         string     `json:"pack_code"`
	BasePaise        int        `json:"base_paise"`
	PlatformFeePaise int        `json:"platform_fee_paise"`
	GSTPaise         int        `gorm:"column:gst_paise" json:"gst_paise"`
	TotalPaise       int        `json:"total_paise"`
	Currency         string     `json:"currency"`
	Status           string     `json:"status"`
	CFOrderID        *string    `gorm:"column:cf_order_id" json:"-"`
	CFPaymentID      *string    `gorm:"column:cf_payment_id" json:"-"`
	PaymentSessionID *string    `json:"payment_session_id,omitempty"`
	InvoiceNumber    *string    `json:"invoice_number,omitempty"`
	PaidAt           *time.Time `json:"paid_at,omitempty"`
	// CheckoutURL is derived, never stored: it is only meaningful while the
	// session is live, and a persisted copy would outlive it.
	CheckoutURL string    `gorm:"-" json:"checkout_url,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (Order) TableName() string { return "ai_payment_orders" }

// gateway is the slice of Cashfree the order service needs, so tests can
// settle an order without a live gateway.
type gateway interface {
	CreateOrder(ctx context.Context, orderID string, breakdown PriceBreakdown, customerID, phone, email, note string) (CreatedOrder, error)
	FetchOrder(ctx context.Context, orderID string) (OrderStatus, error)
}

// Orders owns the purchase lifecycle: price, register with the gateway,
// settle, grant.
type Orders struct {
	db      *gorm.DB
	gateway gateway
	now     func() time.Time
}

// NewOrders builds the order service.
func NewOrders(db *gorm.DB, gw gateway) Orders {
	return Orders{db: db, gateway: gw, now: time.Now}
}

// Create prices pack, stores the order, and registers it with the gateway.
//
// The row is written BEFORE the gateway call. An order the gateway knows about
// but Kora does not is money taken for nothing; an order Kora knows about but
// the gateway does not is a row that expires harmlessly.
func (o Orders) Create(ctx context.Context, userID uuid.UUID, packCode, phone, email string) (Order, error) {
	pack, err := PackByCode(packCode)
	if err != nil {
		return Order{}, err
	}
	price := Price(pack)
	order := Order{
		UserID:           userID,
		PackCode:         pack.Code,
		BasePaise:        price.BasePaise,
		PlatformFeePaise: price.PlatformFeePaise,
		GSTPaise:         price.GSTPaise,
		TotalPaise:       price.TotalPaise,
		Currency:         "INR",
		Status:           OrderCreated,
	}
	if err := o.db.WithContext(ctx).Create(&order).Error; err != nil {
		return Order{}, fmt.Errorf("billing: create order: %w", err)
	}

	created, err := o.gateway.CreateOrder(
		ctx, order.ID.String(), price, userID.String(), phone, email,
		fmt.Sprintf("Kora %s top-up", pack.Name))
	if err != nil {
		// Mark it failed rather than deleting it: a failed attempt is part of
		// the user's payment history, and the id may still show up in a late
		// gateway callback.
		o.db.WithContext(ctx).Model(&Order{}).
			Where("id = ?", order.ID).
			Updates(map[string]any{"status": OrderFailed, "updated_at": o.now().UTC()})
		return Order{}, fmt.Errorf("billing: register order with gateway: %w", err)
	}

	updates := map[string]any{
		"cf_order_id":        created.CFOrderID,
		"payment_session_id": created.PaymentSessionID,
		"updated_at":         o.now().UTC(),
	}
	if err := o.db.WithContext(ctx).Model(&Order{}).
		Where("id = ?", order.ID).
		Clauses(clause.Returning{}).
		Updates(updates).Error; err != nil {
		return Order{}, fmt.Errorf("billing: attach gateway session: %w", err)
	}
	order.CFOrderID = &created.CFOrderID
	order.PaymentSessionID = &created.PaymentSessionID
	order.CheckoutURL = created.CheckoutURL
	return order, nil
}

// Get returns one of userID's orders.
func (o Orders) Get(ctx context.Context, userID, orderID uuid.UUID) (Order, error) {
	var order Order
	err := o.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", orderID, userID).
		First(&order).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Order{}, ErrOrderNotFound
	}
	if err != nil {
		return Order{}, fmt.Errorf("billing: get order: %w", err)
	}
	return order, nil
}

// List returns userID's orders, newest first.
func (o Orders) List(ctx context.Context, userID uuid.UUID, limit int) ([]Order, error) {
	var rows []Order
	if err := o.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("created_at DESC").
		Limit(limit).
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("billing: list orders: %w", err)
	}
	return rows, nil
}

// Settle marks an order paid and grants its entitlement, in ONE transaction.
// Either the user has both a receipt and the usage they bought, or neither.
//
// It is idempotent by design: webhooks are delivered at least once, and a
// second delivery of the same success must be a no-op rather than a second
// grant. Both the status guard here and the unique order_id on ai_entitlements
// enforce that — the constraint is what holds if two deliveries race.
func (o Orders) Settle(ctx context.Context, orderID uuid.UUID, paymentID string, paidPaise int) error {
	err := o.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var order Order
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", orderID).
			First(&order).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrOrderNotFound
		}
		if err != nil {
			return err
		}
		if order.Status == OrderPaid {
			return nil
		}
		// The amount is checked against what Kora priced, not against what the
		// client claimed. A checkout that settles for less buys nothing.
		if paidPaise != order.TotalPaise {
			return ErrAmountMismatch
		}
		pack, err := PackByCode(order.PackCode)
		if err != nil {
			return err
		}

		now := o.now().UTC()
		invoice, err := nextInvoiceNumber(tx, now)
		if err != nil {
			return err
		}
		if err := tx.Model(&Order{}).
			Where("id = ?", order.ID).
			Updates(map[string]any{
				"status":         OrderPaid,
				"cf_payment_id":  paymentID,
				"paid_at":        now,
				"invoice_number": invoice,
				"updated_at":     now,
			}).Error; err != nil {
			return err
		}
		return grantEntitlement(tx, order.UserID, order.ID, pack, now)
	})
	if errors.Is(err, ErrOrderNotFound) || errors.Is(err, ErrAmountMismatch) {
		return err
	}
	if err != nil {
		return fmt.Errorf("billing: settle order: %w", err)
	}
	return nil
}

// Reconcile asks the gateway what really happened to an order and settles it
// if it was paid.
//
// This is the safety net for the webhook, not a substitute for it: a delivery
// can be lost, and a user who has paid must not have to wait for a retry. It
// asks the GATEWAY rather than believing the client — the app calls this when
// the user returns from checkout, and that return is trivially forgeable.
func (o Orders) Reconcile(ctx context.Context, userID, orderID uuid.UUID) (Order, error) {
	order, err := o.Get(ctx, userID, orderID)
	if err != nil {
		return Order{}, err
	}
	if order.Status == OrderPaid {
		return order, nil
	}

	status, err := o.gateway.FetchOrder(ctx, order.ID.String())
	if err != nil {
		return Order{}, fmt.Errorf("billing: reconcile order: %w", err)
	}
	switch status.Status {
	case GatewayPaid:
		if err := o.Settle(ctx, order.ID, "", status.AmountPaise); err != nil {
			return Order{}, err
		}
	case GatewayExpired:
		if err := o.db.WithContext(ctx).Model(&Order{}).
			Where("id = ? AND status = ?", order.ID, OrderCreated).
			Updates(map[string]any{"status": OrderExpired, "updated_at": o.now().UTC()}).Error; err != nil {
			return Order{}, fmt.Errorf("billing: expire order: %w", err)
		}
	}
	return o.Get(ctx, userID, orderID)
}

// nextInvoiceNumber allocates a consecutive serial within the Indian financial
// year (April to March), which is the year a GST invoice series belongs to.
func nextInvoiceNumber(tx *gorm.DB, now time.Time) (string, error) {
	var serial int64
	if err := tx.Raw("SELECT nextval('ai_invoice_serial')").Scan(&serial).Error; err != nil {
		return "", fmt.Errorf("allocate invoice serial: %w", err)
	}
	return fmt.Sprintf("KORA/%s/%06d", financialYear(now), serial), nil
}

// financialYear renders the Indian FY containing t, e.g. "26-27" for any date
// from 1 April 2026 to 31 March 2027.
func financialYear(t time.Time) string {
	u := t.UTC()
	start := u.Year()
	if u.Month() < time.April {
		start--
	}
	return fmt.Sprintf("%02d-%02d", start%100, (start+1)%100)
}
