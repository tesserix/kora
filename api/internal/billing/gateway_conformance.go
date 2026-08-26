package billing

// Compile-time proof that both providers satisfy the seam. If a provider
// drifts, this fails at build time rather than at the first payment.
var (
	_ gateway = (*CashfreeClient)(nil)
	_ gateway = (*StripeClient)(nil)
)
