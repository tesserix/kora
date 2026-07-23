# Kora — UI Kit

A high-fidelity, click-through prototype of **Kora**, Tesserix's AI-first nutrition coach. Built entirely from the Tesserix design-system primitives (`window.TesserixDesignSystem_275930`) on the locked **Iris** theme (custom OKLCH, hue 285).

## Run it
Open `index.html`. The floating control at the bottom toggles:
- **Appearance** — Light / Dark
- **Capture flow** — Photo + Chat / Chat only

## Flow
Onboarding (pick a goal) → **Get started** → Home dashboard. The center **✦ button** opens AI Capture: tap the viewfinder (or the camera/send button) to watch Otto detect items, then **Add to diary** logs them to dinner and returns home. Tap any logged meal (Home or Diary) to open the editable meal sheet.

## Files
- `index.html` — phone frame + interactive mount + variation tweaks.
- `KoraApp.jsx` — app root: state, tab nav, capture flow, meal sheet.
- `Chrome.jsx` — StatusBar, TabBar, FoodTile, Sheet, ScreenHeader.
- `Onboarding.jsx` — goal setup entry screen.
- `HomeScreen.jsx` — calorie ring, macros, today's meals, Otto nudge.
- `CaptureScreen.jsx` — AI capture: dark glass chat + photo/voice/barcode/type composer.
- `CoachScreen.jsx` — Otto as nutrition coach: focus cards + conversation.
- `InsightsScreen.jsx` — weekly report: Otto's take + charts + insight rows.
- `PlannerScreen.jsx` — AI meal planner: constraint chips → day plan + shopping list.
- `RestaurantScreen.jsx` — restaurant mode: chain search, AI-matched nutrition.
- `DiaryScreen.jsx` — week strip + day timeline.
- `ProgressScreen.jsx` — weight trend chart + stat grid.
- `AddonsScreen.jsx` — add-ons hub (steps, water, weight, sleep, meds, fasting).
- `MealDetail.jsx` — editable meal sheet.

## Notes
- Food imagery uses soft single-hue tinted tiles with a Lucide glyph as placeholders — drop in real photography for production.
- Screens compose DS primitives (Button, Card, CircularProgress, Progress, Badge, Stat, Avatar, Icon, Switch, Callout); no primitives are re-implemented here.
