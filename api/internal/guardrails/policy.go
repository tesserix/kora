// Package guardrails implements the Protective policy that gates
// user-facing coach/insight nudges before they are shown. It is a pure
// function of a candidate Nudge and the caller's computed risk Signals —
// it does not compute signals from logging history itself; that is the
// responsibility of the consumer (coach/insights).
package guardrails

// Risk thresholds for the Protective posture. Any one of these firing is
// treated as an ED-risk signal.
const (
	// riskDeficitPct is the avg daily deficit vs target (0..1) over the
	// last 7 days at or above which risk fires.
	riskDeficitPct = 0.30

	// riskAvgIntakeKcal is the avg daily intake (kcal) over the last 7
	// days at or below which risk fires. A zero value means "no data"
	// and must not itself count as risk — see AtRisk.
	riskAvgIntakeKcal = 1200

	// riskLogsPerDay is the avg food logs/day over the last 7 days at or
	// above which risk fires (obsessive-logging proxy).
	riskLogsPerDay = 12

	// riskFastingStreakDays is the consecutive fasting-day streak at or
	// above which risk fires.
	riskFastingStreakDays = 3
)

// softenedText is the fixed positive reframe returned for Soften
// decisions in this first slice of the policy.
const softenedText = "Nice work today — you're on track."

// SoftenedTitle is the neutral title paired with softenedText. A Soften
// decision must replace the candidate's title as well as its text:
// keeping the original would render a contradiction such as
// "Fibre is low" above "Nice work today — you're on track."
const SoftenedTitle = "Today"

// supportReason and allow/soften reasons are short human-readable strings
// set on Decision.Reason to explain which branch fired.
const (
	reasonSuppressRestrictiveUnderRisk = "restrictive nudge suppressed: ED-risk signal present"
	reasonAllowUnderRisk               = "supportive nudge allowed despite ED-risk signal"
	reasonSoftenNoRisk                 = "restrictive nudge softened to positive reframe"
	reasonAllowNoRisk                  = "nudge allowed: no ED-risk signal, not restrictive"
)

// Nudge is a candidate coach/insight message before it is shown.
type Nudge struct {
	Title       string
	Text        string
	Restrictive bool // true if it steers toward eating less / stopping (e.g. "you've eaten enough")
}

// Signals are per-user risk signals, computed by the caller from logging
// history. The zero value represents "no data available" and must not be
// mistaken for a risk-triggering measurement.
type Signals struct {
	RecentDeficitPct  float64 // avg daily deficit vs target over last 7d, 0..1
	AvgIntakeKcal     float64 // avg daily intake last 7d
	LogsPerDay        float64 // avg food logs/day last 7d (obsessive-logging proxy)
	FastingStreakDays int
}

// Action is the outcome of evaluating a Nudge against Signals.
type Action string

const (
	Allow    Action = "allow"    // shown as-is
	Soften   Action = "soften"   // reframed positively
	Suppress Action = "suppress" // not shown; ShowSupport may be set
)

// Decision is the result of applying the Protective policy to a Nudge.
type Decision struct {
	Action Action
	// Title is the safe title to show: SoftenedTitle for Soften, the
	// original for Allow, "" for Suppress. It is sanitised in lockstep
	// with Text so the two can never contradict each other.
	Title       string
	Text        string // the safe text to show (reframed for Soften; original for Allow; "" for Suppress)
	ShowSupport bool   // surface a supportive resource instead
	Reason      string
}

// Evaluate applies the Protective policy to a candidate nudge given a
// user's signals. Title and Text are sanitised together so they can never
// contradict:
//
//   - risk + restrictive  -> Suppress, ShowSupport=true, Title="", Text=""
//   - risk + not restrictive -> Allow, original title and text
//   - no risk + restrictive -> Soften, SoftenedTitle + fixed positive reframe
//   - no risk + not restrictive -> Allow, original title and text
func Evaluate(n Nudge, s Signals) Decision {
	risk := AtRisk(s)

	switch {
	case risk && n.Restrictive:
		return Decision{
			Action:      Suppress,
			Title:       "",
			Text:        "",
			ShowSupport: true,
			Reason:      reasonSuppressRestrictiveUnderRisk,
		}
	case risk && !n.Restrictive:
		return Decision{
			Action: Allow,
			Title:  n.Title,
			Text:   n.Text,
			Reason: reasonAllowUnderRisk,
		}
	case !risk && n.Restrictive:
		return Decision{
			Action: Soften,
			Title:  SoftenedTitle,
			Text:   softenedText,
			Reason: reasonSoftenNoRisk,
		}
	default:
		return Decision{
			Action: Allow,
			Title:  n.Title,
			Text:   n.Text,
			Reason: reasonAllowNoRisk,
		}
	}
}

// AtRisk reports whether any Protective risk threshold fires for s.
//
// AvgIntakeKcal is only treated as a risk signal when it is strictly
// positive AND at or below riskAvgIntakeKcal: the zero value of Signals
// means "no data", not "zero calories consumed", so it must not trigger
// risk on its own.
func AtRisk(s Signals) bool {
	if s.RecentDeficitPct >= riskDeficitPct {
		return true
	}
	if s.AvgIntakeKcal > 0 && s.AvgIntakeKcal <= riskAvgIntakeKcal {
		return true
	}
	if s.LogsPerDay >= riskLogsPerDay {
		return true
	}
	if s.FastingStreakDays >= riskFastingStreakDays {
		return true
	}
	return false
}
