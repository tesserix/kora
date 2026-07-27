package memory

import (
	"context"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/tesserix/kora/api/internal/foodlog"
)

const (
	windowDays       = 90
	recentsLimit     = 20
	frequentMinCount = 2
	frequentLimit    = 20
)

type LogSource interface {
	ListForUserSince(ctx context.Context, userID uuid.UUID, since time.Time) ([]foodlog.FoodLog, error)
}

type Service struct{ logs LogSource }

func NewService(logs LogSource) Service { return Service{logs: logs} }

func (s Service) Build(ctx context.Context, userID uuid.UUID, now time.Time, loc *time.Location) (Memory, error) {
	since := now.Add(-windowDays * 24 * time.Hour)
	logs, err := s.logs.ListForUserSince(ctx, userID, since)
	if err != nil {
		return Memory{}, err
	}
	return Memory{
		Recents:    recents(logs),
		Frequent:   frequent(logs),
		UsualMeals: usualMeals(logs, loc), // implemented in Task 4
	}, nil
}

func foodFrom(l foodlog.FoodLog) Food {
	return Food{
		FoodItemID: l.FoodItemID.String(), Name: l.Description, MealSlot: l.MealSlot,
		Grams: l.QuantityGrams, Kcal: l.Kcal, ProteinG: l.ProteinG, CarbsG: l.CarbsG,
		FatG: l.FatG, FiberG: l.FiberG, LastLoggedAt: l.LoggedAt,
	}
}

// recents: one entry per food item, represented by its most-recent log.
func recents(logs []foodlog.FoodLog) []Food {
	latest := map[string]foodlog.FoodLog{}
	for _, l := range logs { // logs arrive oldest-first, so last write wins = most recent
		latest[l.FoodItemID.String()] = l
	}
	out := make([]Food, 0, len(latest))
	for _, l := range latest {
		out = append(out, foodFrom(l))
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].LastLoggedAt.Equal(out[j].LastLoggedAt) {
			return out[i].LastLoggedAt.After(out[j].LastLoggedAt)
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > recentsLimit {
		out = out[:recentsLimit]
	}
	return out
}

// frequent: foods logged >= frequentMinCount times, ranked count → recency → name,
// carrying the user's mode portion (tie-break: most-recent occurrence of the mode).
func frequent(logs []foodlog.FoodLog) []Food {
	type agg struct {
		count    int
		last     foodlog.FoodLog
		portions map[float64]int
		portLast map[float64]time.Time
	}
	m := map[string]*agg{}
	for _, l := range logs {
		k := l.FoodItemID.String()
		a := m[k]
		if a == nil {
			a = &agg{portions: map[float64]int{}, portLast: map[float64]time.Time{}}
			m[k] = a
		}
		a.count++
		a.last = l // oldest-first → ends on most recent
		a.portions[l.QuantityGrams]++
		if l.LoggedAt.After(a.portLast[l.QuantityGrams]) {
			a.portLast[l.QuantityGrams] = l.LoggedAt
		}
	}
	out := make([]Food, 0, len(m))
	for _, a := range m {
		if a.count < frequentMinCount {
			continue
		}
		f := foodFrom(a.last)
		f.Count = a.count
		f.Grams = modePortion(a.portions, a.portLast)
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		if !out[i].LastLoggedAt.Equal(out[j].LastLoggedAt) {
			return out[i].LastLoggedAt.After(out[j].LastLoggedAt)
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > frequentLimit {
		out = out[:frequentLimit]
	}
	return out
}

// modePortion returns the most-common grams; ties broken by most-recent use, then larger grams.
func modePortion(counts map[float64]int, last map[float64]time.Time) float64 {
	best := 0.0
	bestN := -1
	for g, n := range counts {
		if n > bestN ||
			(n == bestN && last[g].After(last[best])) ||
			(n == bestN && last[g].Equal(last[best]) && g > best) {
			best, bestN = g, n
		}
	}
	return best
}

// usualMeals is implemented in Task 4. This stub keeps the package compiling
// and its tests runnable until then.
func usualMeals(_ []foodlog.FoodLog, _ *time.Location) []Meal { return nil }
