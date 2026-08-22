package billing

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/user"
)

const testWebhookSecret = "test-cashfree-secret"

// purchaseRouter mounts the purchase routes as production does, authenticated
// as userID.
func purchaseRouter(t *testing.T, db *gorm.DB, userID uuid.UUID, gw gateway, now time.Time) *gin.Engine {
	t.Helper()
	var firebaseUID string
	require.NoError(t, db.Raw("SELECT firebase_uid FROM users WHERE id = ?", userID).Scan(&firebaseUID).Error)

	meter := NewMeter(db)
	meter.now = func() time.Time { return now }
	orders := Orders{db: db, gateway: gw, now: func() time.Time { return now }}
	handler := PurchaseHandler{
		orders: orders, meter: meter, secretKey: testWebhookSecret,
		now: func() time.Time { return now },
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/webhooks/cashfree", handler.Webhook)

	v1 := router.Group("/v1")
	v1.Use(func(c *gin.Context) {
		c.Set("uid", firebaseUID)
		c.Next()
	})
	v1.Use(user.ResolveMiddleware(user.NewRepository(db)))
	v1.GET("/ai/packs", handler.Packs)
	v1.POST("/ai/orders", handler.CreateOrder)
	v1.GET("/ai/orders", handler.Orders)
	v1.GET("/ai/orders/:id", handler.Order)
	v1.GET("/ai/usage", NewHandler(meter).UsageStatus)
	return router
}

func postJSON(t *testing.T, router *gin.Engine, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(encoded))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func TestPacksEndpointItemisesEveryPrice(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	router := purchaseRouter(t, db, userID, &fakeGateway{}, time.Now())

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/ai/packs", nil))
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			Packs []packView `json:"packs"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Len(t, body.Data.Packs, len(Packs()))

	first := body.Data.Packs[0]
	require.Equal(t, "spark", first.Code)
	require.Equal(t, 5_000, first.Price.BasePaise)
	require.Equal(t, 6_018, first.Price.TotalPaise)
	require.Equal(t, "50.00", first.BaseRupees)
	require.Equal(t, "60.18", first.TotalRupees, "the client never recomputes GST")
	require.Equal(t, 1800, first.Price.GSTRateBasisPoints)
}

func TestCreateOrderEndpointOpensACheckoutSession(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	cleanupOrders(t, db, userID)
	gw := &fakeGateway{}
	router := purchaseRouter(t, db, userID, gw, time.Now())

	w := postJSON(t, router, "/v1/ai/orders", gin.H{"pack_code": "spark", "phone": "9999999999"})
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data Order `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, OrderCreated, body.Data.Status)
	require.Equal(t, 6_018, body.Data.TotalPaise)
	require.NotNil(t, body.Data.PaymentSessionID)
	require.Equal(t, 6_018, gw.chargedPaise)
}

func TestCreateOrderEndpointRejectsAPackThatIsNotForSale(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	cleanupOrders(t, db, userID)
	router := purchaseRouter(t, db, userID, &fakeGateway{}, time.Now())

	require.Equal(t, http.StatusBadRequest,
		postJSON(t, router, "/v1/ai/orders", gin.H{"pack_code": "free-everything", "phone": "9999999999"}).Code)
	require.Equal(t, http.StatusBadRequest,
		postJSON(t, router, "/v1/ai/orders", gin.H{"pack_code": "spark"}).Code)
}

// The webhook is the only unauthenticated write in the app. An unsigned one
// must grant nothing.
func TestWebhookRefusesAnUnsignedDelivery(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	cleanupOrders(t, db, userID)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	router := purchaseRouter(t, db, userID, &fakeGateway{}, now)

	created := postJSON(t, router, "/v1/ai/orders", gin.H{"pack_code": "spark", "phone": "9999999999"})
	require.Equal(t, http.StatusOK, created.Code)
	var body struct {
		Data Order `json:"data"`
	}
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &body))

	payload := []byte(fmt.Sprintf(
		`{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{"order":{"order_id":%q},"payment":{"cf_payment_id":"p1","payment_status":"SUCCESS","payment_amount":60.18}}}`,
		body.Data.ID))

	req := httptest.NewRequest(http.MethodPost, "/webhooks/cashfree", bytes.NewReader(payload))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	require.Equal(t, http.StatusUnauthorized, w.Code)

	var count int64
	require.NoError(t, db.Model(&Entitlement{}).Where("order_id = ?", body.Data.ID).Count(&count).Error)
	require.Zero(t, count, "an unsigned webhook grants nothing")
}

func TestWebhookSettlesASignedPaymentAndLiftsTheLimit(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	cleanupOrders(t, db, userID)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	router := purchaseRouter(t, db, userID, &fakeGateway{}, now)

	// The user is out of free requests: this is the state that sends them to
	// the checkout in the first place.
	exhaustFreeWindows(t, db, userID, now)
	blocked := httptest.NewRecorder()
	router.ServeHTTP(blocked, httptest.NewRequest(http.MethodGet, "/v1/ai/usage", nil))
	var before struct {
		Data QuotaStatus `json:"data"`
	}
	require.NoError(t, json.Unmarshal(blocked.Body.Bytes(), &before))
	require.True(t, before.Data.Blocked, "the dashboard says AI is unavailable")
	require.False(t, before.Data.TopUp.Active)

	created := postJSON(t, router, "/v1/ai/orders", gin.H{"pack_code": "spark", "phone": "9999999999"})
	var body struct {
		Data Order `json:"data"`
	}
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &body))

	payload := []byte(fmt.Sprintf(
		`{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{"order":{"order_id":%q},"payment":{"cf_payment_id":"p1","payment_status":"SUCCESS","payment_amount":60.18}}}`,
		body.Data.ID))
	ts := now.Format(time.RFC3339)
	req := httptest.NewRequest(http.MethodPost, "/webhooks/cashfree", bytes.NewReader(payload))
	req.Header.Set("x-webhook-timestamp", ts)
	req.Header.Set("x-webhook-signature", sign(t, testWebhookSecret, ts, payload))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	after := httptest.NewRecorder()
	router.ServeHTTP(after, httptest.NewRequest(http.MethodGet, "/v1/ai/usage", nil))
	var status struct {
		Data QuotaStatus `json:"data"`
	}
	require.NoError(t, json.Unmarshal(after.Body.Bytes(), &status))
	require.True(t, status.Data.TopUp.Active, "the dashboard shows the purchased pack")
	require.Equal(t, 25, status.Data.TopUp.Remaining)
	require.Equal(t, 10, status.Data.TopUp.DailyRemaining, "today's share of the pack")
	require.False(t, status.Data.Blocked, "paying lifts the limit")
	require.NotNil(t, status.Data.TopUp.ExpiresAt)
}

// A payment webhook for somebody else's order must not be usable to fish for
// order ids, and one for an unknown order must not 500 into a retry loop.
func TestWebhookAnswers200ForAnOrderItCannotSettle(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	router := purchaseRouter(t, db, userID, &fakeGateway{}, now)

	payload := []byte(fmt.Sprintf(
		`{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{"order":{"order_id":%q},"payment":{"cf_payment_id":"p1","payment_status":"SUCCESS","payment_amount":60.18}}}`,
		uuid.New()))
	ts := now.Format(time.RFC3339)
	req := httptest.NewRequest(http.MethodPost, "/webhooks/cashfree", bytes.NewReader(payload))
	req.Header.Set("x-webhook-timestamp", ts)
	req.Header.Set("x-webhook-signature", sign(t, testWebhookSecret, ts, payload))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"handled":false`)
}

// A failed payment is understood, not retried.
func TestWebhookAcknowledgesAFailedPayment(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	cleanupOrders(t, db, userID)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	router := purchaseRouter(t, db, userID, &fakeGateway{}, now)

	created := postJSON(t, router, "/v1/ai/orders", gin.H{"pack_code": "spark", "phone": "9999999999"})
	var body struct {
		Data Order `json:"data"`
	}
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &body))

	payload := []byte(fmt.Sprintf(
		`{"type":"PAYMENT_FAILED_WEBHOOK","data":{"order":{"order_id":%q},"payment":{"payment_status":"FAILED"}}}`,
		body.Data.ID))
	ts := now.Format(time.RFC3339)
	req := httptest.NewRequest(http.MethodPost, "/webhooks/cashfree", bytes.NewReader(payload))
	req.Header.Set("x-webhook-timestamp", ts)
	req.Header.Set("x-webhook-signature", sign(t, testWebhookSecret, ts, payload))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	stored, err := Orders{db: db, now: time.Now}.Get(context.Background(), userID, body.Data.ID)
	require.NoError(t, err)
	require.Equal(t, OrderCreated, stored.Status, "a failed payment leaves the order unpaid")
}

func TestOrderEndpointHidesAnotherUsersOrder(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db)
	stranger := seedUser(t, db)
	cleanupOrders(t, db, owner)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)

	ownerRouter := purchaseRouter(t, db, owner, &fakeGateway{}, now)
	created := postJSON(t, ownerRouter, "/v1/ai/orders", gin.H{"pack_code": "spark", "phone": "9999999999"})
	var body struct {
		Data Order `json:"data"`
	}
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &body))

	strangerRouter := purchaseRouter(t, db, stranger, &fakeGateway{}, now)
	w := httptest.NewRecorder()
	strangerRouter.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/ai/orders/"+body.Data.ID.String(), nil))
	require.Equal(t, http.StatusNotFound, w.Code)

	w = httptest.NewRecorder()
	strangerRouter.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/ai/orders/not-a-uuid", nil))
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestOrdersEndpointListsThePurchaseHistory(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	cleanupOrders(t, db, userID)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	router := purchaseRouter(t, db, userID, &fakeGateway{}, now)

	require.Equal(t, http.StatusOK,
		postJSON(t, router, "/v1/ai/orders", gin.H{"pack_code": "spark", "phone": "9999999999"}).Code)

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/ai/orders", nil))
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			Orders []Order `json:"orders"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Len(t, body.Data.Orders, 1)
	require.Equal(t, "spark", body.Data.Orders[0].PackCode)
}
