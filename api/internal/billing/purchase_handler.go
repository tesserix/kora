package billing

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"encoding/json"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// maxWebhookBody bounds what an unauthenticated endpoint will read. The
// signature is computed over these bytes, so an unbounded read is both a
// memory risk and a way to make Kora hash megabytes on demand.
const maxWebhookBody = 64 << 10

// maxListedOrders caps the purchase history one request returns.
const maxListedOrders = 50

// PurchaseHandler exposes the paid top-up flow. It is mounted only when
// Cashfree is configured, so an environment with no gateway answers 404 rather
// than offering a checkout that cannot complete.
type PurchaseHandler struct {
	orders    Orders
	meter     Meter
	secretKey string
	now       func() time.Time
}

// NewPurchaseHandler builds the handler. secretKey is the Cashfree secret the
// webhook signature is verified with — the same credential used to call the
// gateway, which is how Cashfree signs.
func NewPurchaseHandler(orders Orders, meter Meter, secretKey string) PurchaseHandler {
	return PurchaseHandler{orders: orders, meter: meter, secretKey: secretKey, now: time.Now}
}

// packView is a pack with its price already itemised, so no client ever
// recomputes GST or a platform fee. There is exactly one implementation of
// this arithmetic and it lives in Go.
type packView struct {
	Pack
	Price PriceBreakdown `json:"price"`
	// Display strings are rendered here for the same reason: a client that
	// formats paise itself will eventually format them wrongly.
	BaseRupees  string `json:"base_rupees"`
	TotalRupees string `json:"total_rupees"`
}

// Packs lists what can be bought, priced.
func (h PurchaseHandler) Packs(c *gin.Context) {
	list := Packs()
	out := make([]packView, len(list))
	for i, pack := range list {
		price := Price(pack)
		out[i] = packView{
			Pack:        pack,
			Price:       price,
			BaseRupees:  Rupees(price.BasePaise),
			TotalRupees: Rupees(price.TotalPaise),
		}
	}
	httpx.OK(c, gin.H{"packs": out})
}

type createOrderRequest struct {
	PackCode string `json:"pack_code" binding:"required"`
	// Phone is required by Cashfree for a customer record. It is passed
	// through to the gateway and never stored by Kora: the payment processor
	// is the right custodian for it, and a copy here would be one more place
	// it could leak from.
	Phone string `json:"phone" binding:"required"`
	Email string `json:"email"`
}

// CreateOrder prices a pack and opens a checkout session for it.
func (h PurchaseHandler) CreateOrder(c *gin.Context) {
	userID, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	var req createOrderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_request", "pack_code and phone are required")
		return
	}
	if _, err := PackByCode(req.PackCode); err != nil {
		httpx.Error(c, http.StatusBadRequest, "unknown_pack", "that top-up is not for sale")
		return
	}

	order, err := h.orders.Create(c.Request.Context(), userID, req.PackCode, req.Phone, req.Email)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, order)
}

// Order returns one order's current state, reconciling with the gateway first
// so a user returning from checkout sees the truth rather than a stale row.
func (h PurchaseHandler) Order(c *gin.Context) {
	userID, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	orderID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "no such order")
		return
	}
	order, err := h.orders.Reconcile(c.Request.Context(), userID, orderID)
	if errors.Is(err, ErrOrderNotFound) {
		httpx.Error(c, http.StatusNotFound, "not_found", "no such order")
		return
	}
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, order)
}

// Orders lists the user's purchase history, which is also their invoice list.
func (h PurchaseHandler) Orders(c *gin.Context) {
	userID, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	rows, err := h.orders.List(c.Request.Context(), userID, maxListedOrders)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, gin.H{"orders": rows})
}

// Webhook settles an order from Cashfree's own notification.
//
// It is UNAUTHENTICATED in the Firebase sense — the caller is Cashfree, not a
// user — so the signature is the only thing standing between a stranger and a
// free unlimited pack. Every failure path answers without detail: a webhook
// endpoint that explains why it rejected something is an oracle.
func (h PurchaseHandler) Webhook(c *gin.Context) {
	raw, err := io.ReadAll(io.LimitReader(c.Request.Body, maxWebhookBody))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_request", "unreadable body")
		return
	}
	if err := VerifyWebhook(
		h.secretKey,
		c.GetHeader("x-webhook-timestamp"),
		c.GetHeader("x-webhook-signature"),
		raw,
		h.now(),
	); err != nil {
		slog.WarnContext(c.Request.Context(), "billing: rejected an unsigned or stale payment webhook")
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid signature")
		return
	}

	var event WebhookEvent
	if err := json.Unmarshal(raw, &event); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_request", "unreadable body")
		return
	}
	if !event.Succeeded() {
		// A failed payment needs no action: the order stays `created` and
		// expires. 200 so Cashfree stops retrying a delivery Kora understood.
		httpx.OK(c, gin.H{"handled": false})
		return
	}
	orderID, err := uuid.Parse(event.Data.Order.OrderID)
	if err != nil {
		httpx.OK(c, gin.H{"handled": false})
		return
	}

	err = h.orders.Settle(c.Request.Context(), orderID, event.PaymentID(), event.AmountPaise())
	switch {
	case errors.Is(err, ErrOrderNotFound):
		// Nothing to retry into existence.
		httpx.OK(c, gin.H{"handled": false})
	case errors.Is(err, ErrAmountMismatch):
		// Deliberately 200: retrying will not make the amounts agree, and this
		// needs a human, not a redelivery loop.
		slog.ErrorContext(c.Request.Context(), "billing: settled amount does not match the order",
			"order_id", orderID.String())
		httpx.OK(c, gin.H{"handled": false})
	case err != nil:
		// 500 so Cashfree retries: this is Kora's fault, and the user has paid.
		slog.ErrorContext(c.Request.Context(), "billing: failed to settle a paid order",
			"order_id", orderID.String(), "err", err)
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not settle the order")
	default:
		httpx.OK(c, gin.H{"handled": true})
	}
}
