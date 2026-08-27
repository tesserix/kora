package billing

import (
	"errors"
	"time"
)

// Shared payment-gateway vocabulary.
//
// These lived in cashfree.go while Cashfree was the only gateway. They are
// declared here because they are the ORDER SERVICE's vocabulary, not any one
// provider's: `gateway` in order.go is written against them, and Stripe
// already implements that interface (kora#478). Cashfree was removed in
// kora#479 — the owner's decision is that a future rail may be Stripe or an
// alternative, but never Cashfree — so leaving the shared types in a
// provider's file would have made the abstraction impossible to keep.

// webhookTimestampTolerance bounds how old a webhook may be.
//
// A signature alone proves authorship, not freshness: without this, a captured
// success callback could be replayed indefinitely.
const webhookTimestampTolerance = 5 * time.Minute

// ErrInvalidSignature means a webhook did not come from the payment gateway,
// or was replayed outside the tolerance window. It is never surfaced to the
// caller in detail — the endpoint answers 401 and says nothing more.
var ErrInvalidSignature = errors.New("billing: invalid webhook signature")

// CreatedOrder is what a gateway returns when an order is opened.
//
// The checkout URL is built SERVER-side and carried here. An app assembling
// gateway URLs itself would need to know which gateway it was talking to, and
// a mismatch there sends real customers to the test gateway.
type CreatedOrder struct {
	// CFOrderID is the gateway's own order identifier. The name is Cashfree's
	// and outlived it: it maps to the `cf_order_id` column, and renaming the
	// field without the column would trade one mismatch for another. kora#487
	// has to restructure this table anyway (nullable order_id, a unique App
	// Store transaction id, and a CHECK that exactly one provenance is set),
	// so the rename belongs there, with the migration.
	CFOrderID        string
	PaymentSessionID string
	CheckoutURL      string
}

// OrderStatus is the gateway's own view of an order, fetched server-side
// rather than trusting the client's return-URL landing — which a user can
// forge simply by opening the deep link.
type OrderStatus struct {
	Status string
	// CFOrderID carries the same historical name as CreatedOrder's; see there.
	CFOrderID   string
	AmountPaise int
}
