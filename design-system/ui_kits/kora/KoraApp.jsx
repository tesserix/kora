/* Kora — app root. Wires screens, tab nav, meal sheet, and the AI capture flow.
   Props (tweaks): captureMode "both"|"chat". Renders inside the phone screen area. */
const DS = window.TesserixDesignSystem_275930;

const INITIAL_MEALS = [
  { name: "Overnight oats & berries", meta: "Oats · blueberries · almond butter", kcal: 388, hue: 20, icon: "wheat", time: "7:40 AM",
    items: [{ name: "Rolled oats", grams: 60, kcal: 228, hue: 40, icon: "wheat" }, { name: "Blueberries", grams: 80, kcal: 46, hue: 280, icon: "cherry" }, { name: "Almond butter", grams: 16, kcal: 114, hue: 30, icon: "nut" }] },
  { name: "Chicken & quinoa bowl", meta: "Chicken · quinoa · avocado · greens", kcal: 512, hue: 45, icon: "salad", time: "12:55 PM" },
  { name: "Greek yogurt", meta: "Yogurt · honey", kcal: 152, hue: 220, icon: "milk", time: "3:30 PM" },
  { name: "Dinner", meta: "Tap to snap or ask Otto", kcal: null, hue: 285, icon: "utensils" },
];

function KoraApp({ captureMode = "both" }) {
  const { StatusBar, TabBar, Sheet, HomeScreen, DiaryScreen, ProgressScreen, AddonsScreen, CaptureScreen, CoachScreen, InsightsScreen, PlannerScreen, RestaurantScreen, Onboarding, MealDetailSheet } = window;
  const [onboarded, setOnboarded] = React.useState(false);
  const [tab, setTab] = React.useState("home");
  const [meals, setMeals] = React.useState(INITIAL_MEALS);
  const [sheetMeal, setSheetMeal] = React.useState(null);

  const eaten = meals.reduce((s, m) => s + (m.kcal || 0), 0);
  const data = { calorieGoal: 2000, macros: { p: 96 + Math.round(eaten*0), c: 148, f: 44 }, meals };

  const logDinner = (items) => {
    const kcal = items.reduce((s, i) => s + i.kcal, 0);
    setMeals((prev) => prev.map((m) => m.kcal == null ? { ...m, name: "Grilled chicken plate", meta: items.map(i=>i.name).join(" · "), kcal, time: "7:15 PM", icon: "drumstick", hue: 30, items } : m));
  };

  if (!onboarded) return <Onboarding onStart={() => setOnboarded(true)} />;

  const scroll = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, overflowY: "auto", WebkitOverflowScrolling: "touch" };

  return (
    <>
      {tab === "capture" ? (
        <CaptureScreen mode={captureMode} onNav={setTab} onLog={logDinner} />
      ) : tab === "coach" ? (
        <CoachScreen onNav={setTab} />
      ) : tab === "insights" ? (
        <InsightsScreen onNav={setTab} />
      ) : tab === "planner" ? (
        <PlannerScreen onNav={setTab} />
      ) : tab === "restaurant" ? (
        <RestaurantScreen onNav={setTab} />
      ) : (
        <>
          <div style={scroll}>
            <StatusBar />
            {tab === "home" && <HomeScreen data={data} onNav={setTab} onOpenMeal={setSheetMeal} />}
            {tab === "diary" && <DiaryScreen data={data} onOpenMeal={setSheetMeal} />}
            {tab === "progress" && <ProgressScreen onNav={setTab} />}
            {tab === "addons" && <AddonsScreen onNav={setTab} />}
          </div>
          <TabBar active={tab} onNav={setTab} />
        </>
      )}
      <Sheet open={!!sheetMeal} onClose={() => setSheetMeal(null)}>
        {sheetMeal && <MealDetailSheet meal={sheetMeal} onClose={() => setSheetMeal(null)} />}
      </Sheet>
    </>
  );
}
window.KoraApp = KoraApp;
window.KORA_MEALS = INITIAL_MEALS;
window.KORA_DATA = { calorieGoal: 2000, macros: { p: 96, c: 148, f: 44 }, meals: INITIAL_MEALS };
