package billing

// Compile-time proof that the provider satisfies the seam. If it drifts, this
// fails at build time rather than at the first payment.
//
// One entry, not zero: Cashfree was removed in kora#479 and Stripe is what
// remains. The assertion is kept rather than deleted because the seam is the
// point — a future rail is meant to slot in here and be checked the same way.
var _ gateway = (*StripeClient)(nil)
