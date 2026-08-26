package billing

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// fakeGateway stands in for Cashfree. It records what it was asked to charge,
// which is the assertion that matters most here: the gateway must be asked for
// the itemised total, never the base price.
type fakeGateway struct {
	createErr    error
	chargedPaise int
	sentOrderID  string
	status       OrderStatus
	statusErr    error
	fetches      int
}

func (g *fakeGateway) CreateOrder(
	_ context.Context, orderID string, breakdown PriceBreakdown, _, _, _, _ string,
) (CreatedOrder, error) {
	if g.createErr != nil {
		return CreatedOrder{}, g.createErr
	}
	g.chargedPaise = breakdown.TotalPaise
	g.sentOrderID = orderID
	return CreatedOrder{
		CFOrderID:        "cf-" + orderID[:8],
		PaymentSessionID: "session-" + orderID[:8],
		CheckoutURL:      "https://payments-test.cashfree.com/order/#session-" + orderID[:8],
	}, nil
}

func (g *fakeGateway) FetchOrder(_ context.Context, _ string) (OrderStatus, error) {
	g.fetches++
	return g.status, g.statusErr
}

func newOrders(t *testing.T, db *gorm.DB, gw gateway, now time.Time) Orders {
	t.Helper()
	return Orders{db: db, gateway: gw, now: func() time.Time { return now }}
}

func cleanupOrders(t *testing.T, db *gorm.DB, userID uuid.UUID) {
	t.Helper()
	t.Cleanup(func() { db.Exec("DELETE FROM ai_payment_orders WHERE user_id = ?", userID) })
}

func TestCreateStoresTheFrozenPriceAndChargesTheTotal(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	cleanupOrders(t, db, userID)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	gw := &fakeGateway{}
	orders := newOrders(t, db, gw, now)

	order, err := orders.Create(context.Background(), userID, "spark", "9999999999", "a@b.dev")
	require.NoError(t, err)

	require.Equal(t, OrderCreated, order.Status)
	require.Equal(t, 5_000, order.BasePaise)
	require.Equal(t, 100, order.PlatformFeePaise)
	require.Equal(t, 918, order.GSTPaise)
	require.Equal(t, 6_018, order.TotalPaise)
	require.Equal(t, 6_018, gw.chargedPaise, "the gateway collects the itemised total")
	require.Equal(t, order.ID.String(), gw.sentOrderID, "Kora's id is the gateway's order id")
	require.NotNil(t, order.PaymentSessionID)
	require.Nil(t, order.InvoiceNumber, "an unpaid order has no invoice")

	stored, err := orders.Get(context.Background(), userID, order.ID)
	require.NoError(t, err)
	require.Equal(t, order.TotalPaise, stored.TotalPaise)
	require.NotNil(t, stored.PaymentSessionID)
}

func TestCreateRejectsAnUnknownPack(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	cleanupOrders(t, db, userID)
	orders := newOrders(t, db, &fakeGateway{}, time.Now())

	_, err := orders.Create(context.Background(), userID, "free-everything", "9999999999", "")
	require.Error(t, err)
}

// A gateway failure must leave a durable failed row, not a phantom order the
// user could later be charged against.
func TestCreateMarksTheOrderFailedWhenTheGatewayRefuses(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	cleanupOrders(t, db, userID)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	orders := newOrders(t, db, &fakeGateway{createErr: errors.New("gateway down")}, now)

	_, err := orders.Create(context.Background(), userID, "spark", "9999999999", "")
	require.Error(t, err)

	stored, err := orders.List(context.Background(), userID, 10)
	require.NoError(t, err)
	require.Len(t, stored, 1)
	require.Equal(t, OrderFailed, stored[0].Status)
}

func TestSettleGrantsTheEntitlementAndIssuesAnInvoice(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	cleanupOrders(t, db, userID)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	orders := newOrders(t, db, &fakeGateway{}, now)

	order, err := orders.Create(context.Background(), userID, "spark", "9999999999", "")
	require.NoError(t, err)
	require.NoError(t, orders.Settle(context.Background(), order.ID, "pay-1", order.TotalPaise))

	settled, err := orders.Get(context.Background(), userID, order.ID)
	require.NoError(t, err)
	require.Equal(t, OrderPaid, settled.Status)
	require.NotNil(t, settled.PaidAt)
	require.NotNil(t, settled.InvoiceNumber)
	require.Contains(t, *settled.InvoiceNumber, "KORA/26-27/", "the invoice serial names its financial year")

	var count int64
	require.NoError(t, db.Model(&Entitlement{}).Where("order_id = ?", order.ID).Count(&count).Error)
	require.EqualValues(t, 1, count, "paying grants the pack")
}

// Webhooks are delivered at least once. The second delivery of one success
// must not grant a second pack.
func TestSettleIsIdempotentAcrossRedeliveries(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	cleanupOrders(t, db, userID)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	orders := newOrders(t, db, &fakeGateway{}, now)

	order, err := orders.Create(context.Background(), userID, "steady", "9999999999", "")
	require.NoError(t, err)
	require.NoError(t, orders.Settle(context.Background(), order.ID, "pay-1", order.TotalPaise))
	first, err := orders.Get(context.Background(), userID, order.ID)
	require.NoError(t, err)

	require.NoError(t, orders.Settle(context.Background(), order.ID, "pay-1", order.TotalPaise))
	second, err := orders.Get(context.Background(), userID, order.ID)
	require.NoError(t, err)

	require.Equal(t, *first.InvoiceNumber, *second.InvoiceNumber, "one payment, one invoice")
	require.True(t, first.PaidAt.Equal(*second.PaidAt), "a redelivery is not a second payment")

	var count int64
	require.NoError(t, db.Model(&Entitlement{}).Where("order_id = ?", order.ID).Count(&count).Error)
	require.EqualValues(t, 1, count, "one payment grants one entitlement")
}

// A checkout that settles for a different amount than Kora priced must buy
// nothing at all.
func TestSettleRefusesAnAmountThatDoesNotMatchTheOrder(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	cleanupOrders(t, db, userID)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	orders := newOrders(t, db, &fakeGateway{}, now)

	order, err := orders.Create(context.Background(), userID, "boundless", "9999999999", "")
	require.NoError(t, err)

	require.ErrorIs(t, orders.Settle(context.Background(), order.ID, "pay-1", 100), ErrAmountMismatch)

	unpaid, err := orders.Get(context.Background(), userID, order.ID)
	require.NoError(t, err)
	require.Equal(t, OrderCreated, unpaid.Status)

	var count int64
	require.NoError(t, db.Model(&Entitlement{}).Where("order_id = ?", order.ID).Count(&count).Error)
	require.Zero(t, count, "an underpaid order grants nothing")
}

func TestSettleRejectsAnUnknownOrder(t *testing.T) {
	db := testDB(t)
	orders := newOrders(t, db, &fakeGateway{}, time.Now())
	require.ErrorIs(t, orders.Settle(context.Background(), uuid.New(), "pay-1", 6_018), ErrOrderNotFound)
}

// Another user's order id must be indistinguishable from one that never
// existed.
func TestGetHidesAnotherUsersOrder(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db)
	stranger := seedUser(t, db)
	cleanupOrders(t, db, owner)
	orders := newOrders(t, db, &fakeGateway{}, time.Now())

	order, err := orders.Create(context.Background(), owner, "spark", "9999999999", "")
	require.NoError(t, err)

	_, err = orders.Get(context.Background(), stranger, order.ID)
	require.ErrorIs(t, err, ErrOrderNotFound)
	_, err = orders.Get(context.Background(), stranger, uuid.New())
	require.ErrorIs(t, err, ErrOrderNotFound)
}

// The user's return from checkout is forgeable, so reconciliation asks the
// gateway and settles from ITS answer.
func TestReconcileSettlesFromTheGatewaysAnswer(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	cleanupOrders(t, db, userID)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	gw := &fakeGateway{}
	orders := newOrders(t, db, gw, now)

	order, err := orders.Create(context.Background(), userID, "spark", "9999999999", "")
	require.NoError(t, err)
	gw.status = OrderStatus{Status: "PAID", CFOrderID: "cf-1", AmountPaise: order.TotalPaise}

	settled, err := orders.Reconcile(context.Background(), userID, order.ID)
	require.NoError(t, err)
	require.Equal(t, OrderPaid, settled.Status)
	require.NotNil(t, settled.InvoiceNumber)

	// Already paid: no second gateway call, no second grant.
	before := gw.fetches
	again, err := orders.Reconcile(context.Background(), userID, order.ID)
	require.NoError(t, err)
	require.Equal(t, OrderPaid, again.Status)
	require.Equal(t, before, gw.fetches, "a paid order is not re-fetched")
}

func TestReconcileMarksAnExpiredOrderExpired(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	cleanupOrders(t, db, userID)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	gw := &fakeGateway{}
	orders := newOrders(t, db, gw, now)

	order, err := orders.Create(context.Background(), userID, "spark", "9999999999", "")
	require.NoError(t, err)
	gw.status = OrderStatus{Status: "EXPIRED"}

	out, err := orders.Reconcile(context.Background(), userID, order.ID)
	require.NoError(t, err)
	require.Equal(t, OrderExpired, out.Status)

	var count int64
	require.NoError(t, db.Model(&Entitlement{}).Where("order_id = ?", order.ID).Count(&count).Error)
	require.Zero(t, count)
}

func TestFinancialYearFollowsTheIndianAprilBoundary(t *testing.T) {
	require.Equal(t, "26-27", financialYear(time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)))
	require.Equal(t, "26-27", financialYear(time.Date(2027, 3, 31, 23, 59, 0, 0, time.UTC)))
	require.Equal(t, "25-26", financialYear(time.Date(2026, 3, 31, 23, 59, 0, 0, time.UTC)))
}


// TestCreateReturnsTheGatewaysCheckoutURL pins the contract kora#478 moved.
//
// CheckoutURL is now produced BY the provider and carried on CreatedOrder,
// rather than derived by the order service from a payment session id. Nothing
// asserted that it reaches the Order at all — verified by mutation: blanking
// the assignment in Orders.Create left the whole suite green, so the field the
// client needs in order to send anyone to a payment page was untested.
//
// It is `gorm:"-"`, so it exists only on the returned value: a persisted copy
// would outlive the session it describes.
func TestCreateReturnsTheGatewaysCheckoutURL(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	cleanupOrders(t, db, userID)
	gw := &fakeGateway{}
	orders := newOrders(t, db, gw, time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC))

	order, err := orders.Create(context.Background(), userID, "spark", "9999999999", "a@b.dev")
	require.NoError(t, err)

	require.NotEmpty(t, order.CheckoutURL, "the order must carry the URL the client sends the user to")
	require.Equal(t,
		"https://payments-test.cashfree.com/order/#session-"+order.ID.String()[:8],
		order.CheckoutURL,
		"the URL must be the provider's, not one reconstructed from the session id")
}
