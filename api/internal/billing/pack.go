package billing

import (
	"fmt"
	"time"
)

// Money in this package is ALWAYS integer paise. Rupee floats do not survive
// arithmetic that has to reconcile against a payment gateway's own totals:
// 18% of 5100 paise is exactly 918 paise, whereas 0.18*51.00 is 9.179999...
// and rounds differently depending on where it is rounded. The API renders
// rupees for display only, from these integers.
const (
	// gstRateBasisPoints is India's 18% GST on online information and database
	// access services (SAC 998434). Applied to the taxable value, which
	// includes the platform fee: the fee is part of the consideration for the
	// supply, not a separate non-taxable pass-through.
	gstRateBasisPoints = 1800
	// platformFeeBasisPoints is Kora's 2% platform fee. It is charged ON TOP of
	// the pack price so the advertised price ("₹50 of usage") is the amount of
	// usage the user actually receives, and the fee is a visible line on the
	// invoice rather than a silent shave off the grant.
	platformFeeBasisPoints = 200

	// packValidity is how long a purchased top-up lasts. Fixed rather than
	// aligned to the calendar month: a pack bought on the 30th would otherwise
	// be worth a day.
	packValidity = 30 * 24 * time.Hour
)

// Pack is one purchasable AI top-up.
//
// Grant and DailyCap are BOTH enforced. Grant alone would let a user spend a
// month of allowance in an afternoon and then experience the rest of the month
// as an outage; DailyCap alone would be an unbounded subscription. Together
// they mean "this many extra requests, at most this many a day".
type Pack struct {
	Code string `json:"code"`
	Name string `json:"name"`
	// BasePaise is the price BEFORE platform fee and GST — the number the
	// product talks in ("from ₹50").
	BasePaise int `json:"base_paise"`
	// Grant is the number of extra provider-backed requests bought. Zero means
	// unlimited, which only the top pack has.
	Grant int `json:"grant"`
	// DailyCap is the most of those requests usable in one UTC day, on top of
	// the free daily window. Zero means uncapped within the grant.
	DailyCap  int    `json:"daily_cap"`
	Unlimited bool   `json:"unlimited"`
	Summary   string `json:"summary"`
}

// packs is the catalogue, cheapest first. Prices span the ₹50–₹1050 range the
// product sells, and ₹ per request decreases with size while staying above the
// list-price proxy cost of a request (see ai.EstimateCostUSD): a pack that
// undercuts the proxy would make the monthly cost cap, not the pack, the thing
// that stops a heavy user — which is exactly the state they paid to leave.
var packs = []Pack{
	{
		Code:      "spark",
		Name:      "Spark",
		BasePaise: 5_000,
		Grant:     25,
		DailyCap:  10,
		Summary:   "25 extra requests, up to 10 a day",
	},
	{
		Code:      "steady",
		Name:      "Steady",
		BasePaise: 15_000,
		Grant:     85,
		DailyCap:  20,
		Summary:   "85 extra requests, up to 20 a day",
	},
	{
		Code:      "strong",
		Name:      "Strong",
		BasePaise: 35_000,
		Grant:     210,
		DailyCap:  40,
		Summary:   "210 extra requests, up to 40 a day",
	},
	{
		Code:      "boundless",
		Name:      "Boundless",
		BasePaise: 105_000,
		Unlimited: true,
		Summary:   "Unlimited requests for 30 days",
	},
}

// Packs returns the catalogue.
func Packs() []Pack {
	out := make([]Pack, len(packs))
	copy(out, packs)
	return out
}

// PackByCode looks a pack up. An unknown code is an error rather than a zero
// pack: it reaches this package from a request body.
func PackByCode(code string) (Pack, error) {
	for _, p := range packs {
		if p.Code == code {
			return p, nil
		}
	}
	return Pack{}, fmt.Errorf("billing: unknown pack %q", code)
}

// PriceBreakdown is what the user is charged, itemised. Every field is paise,
// and TotalPaise is the only number the gateway is ever asked to collect.
type PriceBreakdown struct {
	BasePaise        int `json:"base_paise"`
	PlatformFeePaise int `json:"platform_fee_paise"`
	// TaxablePaise is base + platform fee, the value GST is computed on.
	TaxablePaise int `json:"taxable_paise"`
	GSTPaise     int `json:"gst_paise"`
	TotalPaise   int `json:"total_paise"`
	// Rates are echoed so a client renders "GST (18%)" without hardcoding a
	// number that would silently go stale if the statutory rate changed.
	GSTRateBasisPoints         int `json:"gst_rate_basis_points"`
	PlatformFeeRateBasisPoints int `json:"platform_fee_rate_basis_points"`
}

// Price itemises what pack costs.
//
// Both derived amounts round HALF UP, and GST is computed on the already
// rounded taxable value rather than on base and fee separately — computing it
// twice and adding leaves totals that differ by a paisa from the invoice.
func Price(pack Pack) PriceBreakdown {
	fee := roundedBasisPoints(pack.BasePaise, platformFeeBasisPoints)
	taxable := pack.BasePaise + fee
	gst := roundedBasisPoints(taxable, gstRateBasisPoints)
	return PriceBreakdown{
		BasePaise:                  pack.BasePaise,
		PlatformFeePaise:           fee,
		TaxablePaise:               taxable,
		GSTPaise:                   gst,
		TotalPaise:                 taxable + gst,
		GSTRateBasisPoints:         gstRateBasisPoints,
		PlatformFeeRateBasisPoints: platformFeeBasisPoints,
	}
}

// roundedBasisPoints returns amount * bp / 10000, rounded half up, in integer
// arithmetic throughout so no float ever touches a chargeable amount.
func roundedBasisPoints(amount, bp int) int {
	return (amount*bp + 5_000) / 10_000
}

// Rupees renders paise for display. Presentation only — never charged.
func Rupees(paise int) string {
	return fmt.Sprintf("%d.%02d", paise/100, paise%100)
}
