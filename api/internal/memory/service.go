package memory

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"
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
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].FoodItemID < out[j].FoodItemID
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
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].FoodItemID < out[j].FoodItemID
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

const (
	usualMealMinDays = 3
	usualMealsLimit  = 12
)

// usualMeals groups logs into meal instances by (local calendar day, meal_slot),
// fingerprints each instance by its SET of food ids, and surfaces fingerprints that
// recur on >= usualMealMinDays distinct days. Single-food instances are excluded.
func usualMeals(logs []foodlog.FoodLog, loc *time.Location) []Meal {
	if loc == nil {
		loc = time.UTC
	}
	// 1. bucket logs into meal instances keyed by day|slot
	type inst struct {
		items map[string]foodlog.FoodLog // most-recent log per food id in this instance
		day   string
		slot  string
	}
	instances := map[string]*inst{}
	for _, l := range logs {
		day := l.LoggedAt.In(loc).Format("2006-01-02")
		key := day + "|" + l.MealSlot
		in := instances[key]
		if in == nil {
			in = &inst{items: map[string]foodlog.FoodLog{}, day: day, slot: l.MealSlot}
			instances[key] = in
		}
		in.items[l.FoodItemID.String()] = l
	}
	// 2. fingerprint each multi-food instance by sorted food-id set
	type sig struct {
		slot  string
		days  map[string]bool
		last  time.Time
		items map[string]foodlog.FoodLog // representative log per food id (most recent across days)
	}
	sigs := map[string]*sig{}
	for _, in := range instances {
		if len(in.items) < 2 {
			continue
		}
		ids := make([]string, 0, len(in.items))
		for id := range in.items {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		fp := in.slot + ":" + strings.Join(ids, ",")
		s := sigs[fp]
		if s == nil {
			s = &sig{slot: in.slot, days: map[string]bool{}, items: map[string]foodlog.FoodLog{}}
			sigs[fp] = s
		}
		s.days[in.day] = true
		for id, l := range in.items {
			if l.LoggedAt.After(s.items[id].LoggedAt) {
				s.items[id] = l
			}
			if l.LoggedAt.After(s.last) {
				s.last = l.LoggedAt
			}
		}
	}
	// 3. keep fingerprints seen on >= usualMealMinDays days; build Meal
	out := make([]Meal, 0, len(sigs))
	for fp, s := range sigs {
		if len(s.days) < usualMealMinDays {
			continue
		}
		items := make([]Food, 0, len(s.items))
		for _, l := range s.items {
			items = append(items, foodFrom(l))
		}
		// components sorted by kcal desc → name asc (stable, and used for the name)
		sort.Slice(items, func(i, j int) bool {
			if items[i].Kcal != items[j].Kcal {
				return items[i].Kcal > items[j].Kcal
			}
			return items[i].Name < items[j].Name
		})
		m := Meal{ID: hashFingerprint(fp), MealSlot: s.slot, Items: items, Count: len(s.days), LastLoggedAt: s.last}
		for _, it := range items {
			m.Kcal += it.Kcal
			m.ProteinG += it.ProteinG
			m.CarbsG += it.CarbsG
			m.FatG += it.FatG
			m.FiberG += it.FiberG
		}
		m.Name = mealName(items)
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		if !out[i].LastLoggedAt.Equal(out[j].LastLoggedAt) {
			return out[i].LastLoggedAt.After(out[j].LastLoggedAt)
		}
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].ID < out[j].ID
	})
	if len(out) > usualMealsLimit {
		out = out[:usualMealsLimit]
	}
	return out
}

func hashFingerprint(fp string) string {
	sum := sha1.Sum([]byte(fp))
	return hex.EncodeToString(sum[:])
}

// mealName joins component names: all if <=3, else first two + " +N more".
func mealName(items []Food) string {
	names := make([]string, 0, len(items))
	for _, it := range items {
		names = append(names, it.Name)
	}
	if len(names) <= 3 {
		return humanJoin(names)
	}
	return humanJoin(names[:2]) + " +" + strconv.Itoa(len(names)-2) + " more"
}

func humanJoin(n []string) string {
	switch len(n) {
	case 0:
		return ""
	case 1:
		return n[0]
	case 2:
		return n[0] + " & " + n[1]
	default:
		return strings.Join(n[:len(n)-1], ", ") + " & " + n[len(n)-1]
	}
}
