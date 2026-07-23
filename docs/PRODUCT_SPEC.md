# Kora — Product Specification

Build a modern AI-powered nutrition tracking mobile application for iOS and Android.

The goal is **NOT** to build another calorie tracker.

The goal is to create **the easiest nutrition tracking experience ever built.**

Users should be able to track nutrition using:

- Food photos
- Natural language chat
- Voice
- Barcode scanning
- Manual editing

Everything should feel **conversational** rather than data entry.

---

## Core Features

### 1. AI Photo Logging

User opens camera and takes a photo. AI detects:

- Foods
- Ingredients
- Estimated portion sizes
- Cooking methods
- Confidence level

**If confidence > 90%**, show:

> **Grilled chicken breast**
> **Steamed rice**
> **Broccoli**
>
> 620 kcal
> 48g protein
>
> Log?

**If confidence is low**, ask intelligent follow-up questions:

- "Was this full fat yoghurt?"
- "Was this grilled or fried?"
- "Approximately how many tablespoons of rice?"

**Never hallucinate nutrition.** Use USDA / OpenFoodFacts / Australian Food database.

---

### 2. Chat Logging

Users can simply type:

- "I had 2 eggs"
- "Large flat white"
- "Chicken biryani"
- "I ate half the pizza"
- "Protein shake"

AI understands context and should ask only when necessary:

- "What milk?"
- "Large or medium?"
- "Restaurant or homemade?"

Everything logs automatically.

---

### 3. Voice Logging

User taps the microphone:

> "I had grilled salmon and vegetables."

Speech converts to a food log. No extra work.

---

### 4. Personal Food Memory

The AI should learn the user.

**Example:** Every Monday → protein smoothie. Eventually:

> "Looks like your usual breakfast."

One tap to log.

Remember:

- Favourite meals
- Restaurants
- Recipes
- Coffee order
- Supplements
- Snacks
- Frequently eaten foods

---

### 5. Custom Recipes

Users can:

- Photograph a meal, **or**
- Paste a recipe, **or**
- Import a URL

AI calculates: Calories, Protein, Carbs, Fat, Fibre, Servings.

Recipe becomes reusable.

---

### 6. Restaurant Mode

Search restaurants — Nandos, Subway, McDonalds, KFC, Chipotle.

AI imports nutrition automatically. If unavailable, estimate using visual analysis.

---

### 7. Daily Dashboard

Instead of numbers only, show coaching.

| Metric | Value |
|---|---|
| Protein | 142 / 160g |
| Calories | 1850 / 2200 |
| Fibre | 18 / 30g |
| Water | 2.3L |
| Sleep | 7h |

Also: Weight trend, Steps, Exercise, Streak.

---

### 8. AI Coach

Acts like a nutritionist:

- "You need another 35g protein."
- "You've eaten enough calories."
- "Your fibre has been low for four days."
- "Weight trend is improving."
- "Try replacing chips with potatoes."

**Never shame users. Always supportive.**

---

### 9. Weight Tracking

Track: Weight, Body fat, Muscle mass, Waist, Photos.

Generate charts and predict trends:

> "If current trend continues you'll reach 75kg in 6 weeks."

---

### 10. Smart Insights

Weekly report:

- Average calories
- Protein consistency
- Most common meals
- Restaurant spending
- Cheat meal frequency
- Highest protein day
- Lowest fibre day
- Longest fasting period
- Best sleep day

---

### 11. Supplement Tracking

Protein, Creatine, Fish oil, Vitamin D, Magnesium, Collagen, Custom supplements.

Daily reminders.

---

### 12. Water Tracking

Quick add: 250ml, 500ml, 750ml, 1L.

Voice: "I drank a bottle of water."

---

### 13. Fasting Mode

Track: Start fasting, End fasting, Duration, Intermittent fasting schedules.

---

### 14. Barcode Scanner

Instant nutrition lookup. Save favourites.

---

### 15. Health Integration

Apple Health, Google Fit, Garmin, Fitbit, Whoop, Oura.

Automatically import: Weight, Steps, Calories, Heart rate, Sleep, Workouts.

---

### 16. Goals

Fat loss, Muscle gain, Maintenance, Diabetes, High protein, Low carb, Mediterranean, Custom macros.

---

### 17. AI Meal Planner

Generate meals based on: Budget, Cuisine, Calories, Protein, Time, Ingredients available.

Can generate shopping lists.

---

### 18. Social Features

Optional. Share: Weight milestone, Protein streak, Workout streak, Recipe.

**No calorie shaming.**

---

### 19. Gamification

XP, Levels, Badges, Weekly challenges, Consistency score.

---

### 20. Privacy

- Users own their data.
- Delete account.
- Export all data.
- End-to-end encrypted images.

---

## AI Personality

The AI should behave like an experienced nutrition coach:

- Friendly
- Motivating
- Evidence based
- Never judgemental
- Never make medical claims.

---

## Design

- Minimal.
- Apple Human Interface inspired.
- Very few buttons.
- Everything conversational.
- Large meal photos.
- Beautiful charts.
- Dark mode.
- Fast.

---

## Tech Stack

**Frontend**
- React Native + Expo

**Backend**
- Go
- Gin
- PostgreSQL
- Redis
- Object Storage

**Authentication**
- Firebase Auth

**AI**
- Gemini 2.5 Flash for image understanding
- Gemini Flash Lite for chat
- Optional GPT-5 mini fallback

**Nutrition Database**
- USDA
- OpenFoodFacts
- Australian Food Database

---

## Future Features

- Grocery receipt scanning
- Pantry inventory
- Blood glucose integration
- CGM support
- AI grocery shopping
- AI meal photo timeline
- Family meal sharing
- Restaurant recommendations
- Food allergy detection
- Voice-first mode
- Smart wearable widgets
- Apple Watch app
- Dynamic calorie adjustment based on activity
- AI-generated recipes from fridge ingredients
- AI health reports for doctors
