package billing

import (
	"context"
	"fmt"
)

// Caps are the fixed ceilings governing every AI call (kora#485).
//
// Exported as a value rather than as loose constants because an operator
// cannot read meter.go. globalMonthlyCostCapUSD in particular is a kill switch
// on the entire product's AI: once estate spend crosses it, WithinBudget
// refuses every user. The first symptom of that is "AI stopped working for
// everyone", and without this the explanation is a constant in a Go file.
//
// READ ONLY, deliberately. Changing a cap from a console is a
// turn-the-product-off lever and needs the §8.3 apparatus — a named
// capability, confirmation semantics, reason codes — that Kora has not built.
// Exposing the read without the write is the whole point of #485's split.
type Caps struct {
	PerUserMonthlyCostUSD  float64 `json:"per_user_monthly_cost_usd"`
	GlobalMonthlyCostUSD   float64 `json:"global_monthly_cost_usd"`
	PerUserDailyRequests   int     `json:"per_user_daily_requests"`
	PerUserWeeklyRequests  int     `json:"per_user_weekly_requests"`
	PerUserMonthlyRequests int     `json:"per_user_monthly_requests"`
}

// CapsInEffect reports the ceilings this binary is actually enforcing.
//
// Reads the same constants WithinBudget compares against, so the reported
// ceiling and the enforced one cannot drift apart.
func CapsInEffect() Caps {
	return Caps{
		PerUserMonthlyCostUSD:  perUserMonthlyCostCapUSD,
		GlobalMonthlyCostUSD:   globalMonthlyCostCapUSD,
		PerUserDailyRequests:   perUserDailyRequestCap,
		PerUserWeeklyRequests:  perUserWeeklyRequestCap,
		PerUserMonthlyRequests: perUserMonthlyRequestCap,
	}
}

// GlobalMonthSpendUSD is estate-wide estimated AI spend for the calendar month
// the cap is measured over.
//
// Uses quotaWindowsAt — the SAME window WithinBudget derives monthStart from —
// rather than computing its own month boundary. A display that answered "how
// close are we?" over a different window than the one being enforced would be
// worse than no display at all: it would read reassuring at the moment the
// kill switch fired.
func (m Meter) GlobalMonthSpendUSD(ctx context.Context) (float64, error) {
	windows := quotaWindowsAt(m.now())
	monthStart := windows[2].start

	var total float64
	if err := m.db.WithContext(ctx).
		Model(&Event{}).
		Where("created_at >= ?", monthStart).
		Select("COALESCE(SUM(cost_usd_est), 0)").
		Scan(&total).Error; err != nil {
		return 0, fmt.Errorf("billing: global month spend: %w", err)
	}
	return total, nil
}

// usdCents converts dollars to whole cents for transport.
//
// The health probe carries map[string]int64, and a budget rendered in truncated
// DOLLARS would show a $500 cap and a $0 spend right up until the cap fired.
// Cents keep the figure legible at the magnitudes this product actually spends.
func usdCents(usd float64) int64 { return int64(usd*100 + 0.5) }

// CostCurrency is the ISO-4217 code the AI caps are denominated in.
//
// The caps are USD because the provider bills in USD, while Kora's own billing
// is in paise and the Stripe account is Australian. Three currencies in one
// product's money paths is exactly why the contract requires the code to
// travel WITH the amount rather than live in a field name (#485).
const CostCurrency = "USD"

// MoneyAmount is integer minor units plus an explicit ISO-4217 code.
//
// Declared here rather than imported from platformadmin so the dependency
// direction holds: the admin surface adapts billing, never the reverse.
type MoneyAmount struct {
	Amount   int64
	Currency string
}

// RequestCapMetrics are the NON-money quota ceilings, for the health surface's
// int64 metric map. Request counts carry no currency, so they belong there.
func RequestCapMetrics() map[string]int64 {
	caps := CapsInEffect()
	return map[string]int64{
		"per_user_daily_requests_cap":   int64(caps.PerUserDailyRequests),
		"per_user_weekly_requests_cap":  int64(caps.PerUserWeeklyRequests),
		"per_user_monthly_requests_cap": int64(caps.PerUserMonthlyRequests),
	}
}

// BudgetMoney renders the cost caps and current estate spend as §4.2 money
// values — integer minor units with an explicit currency (#485).
//
// Headroom is included rather than left for the reader to subtract: the
// operator's question is "how close are we?", and a surface answering it with
// two numbers to subtract answers it less well.
func (m Meter) BudgetMoney(ctx context.Context) (map[string]MoneyAmount, error) {
	spend, err := m.GlobalMonthSpendUSD(ctx)
	if err != nil {
		return nil, err
	}
	caps := CapsInEffect()
	headroom := caps.GlobalMonthlyCostUSD - spend
	if headroom < 0 {
		headroom = 0
	}
	usd := func(v float64) MoneyAmount {
		return MoneyAmount{Amount: usdCents(v), Currency: CostCurrency}
	}
	return map[string]MoneyAmount{
		"global_month_spend":    usd(spend),
		"global_month_cap":      usd(caps.GlobalMonthlyCostUSD),
		"global_month_headroom": usd(headroom),
		"per_user_month_cap":    usd(caps.PerUserMonthlyCostUSD),
	}, nil
}
