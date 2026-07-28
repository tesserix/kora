// Package memory derives one-tap re-log suggestions from a user's food-log history.
package memory

import "time"

type Food struct {
	FoodItemID   string    `json:"food_item_id"`
	Name         string    `json:"name"`
	MealSlot     string    `json:"meal_slot"`
	Grams        float64   `json:"grams"`
	Kcal         float64   `json:"kcal"`
	ProteinG     float64   `json:"protein_g"`
	CarbsG       float64   `json:"carbs_g"`
	FatG         float64   `json:"fat_g"`
	FiberG       float64   `json:"fiber_g"`
	Count        int       `json:"count"`
	LastLoggedAt time.Time `json:"last_logged_at"`
}

type Meal struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	MealSlot     string    `json:"meal_slot"`
	Items        []Food    `json:"items"`
	Kcal         float64   `json:"kcal"`
	ProteinG     float64   `json:"protein_g"`
	CarbsG       float64   `json:"carbs_g"`
	FatG         float64   `json:"fat_g"`
	FiberG       float64   `json:"fiber_g"`
	Count        int       `json:"count"`
	LastLoggedAt time.Time `json:"last_logged_at"`
}

type Memory struct {
	Recents    []Food `json:"recents"`
	Frequent   []Food `json:"frequent"`
	UsualMeals []Meal `json:"usual_meals"`
}
