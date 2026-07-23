/* Kora — AI Meal Planner. Otto generates a day plan from constraints. */
const DS = window.TesserixDesignSystem_275930;

const PLAN = [
  { slot: "Breakfast", name: "Greek yogurt, berries & granola", kcal: 380, p: 28, hue: 220, icon: "milk" },
  { slot: "Lunch", name: "Chicken & quinoa power bowl", kcal: 540, p: 46, hue: 45, icon: "salad" },
  { slot: "Snack", name: "Protein shake & apple", kcal: 260, p: 30, hue: 285, icon: "cup-soda" },
  { slot: "Dinner", name: "Baked salmon, greens & potatoes", kcal: 620, p: 44, hue: 30, icon: "fish" },
];

function PlannerScreen({ onNav }) {
  const [active, setActive] = React.useState(["High protein", "~1,800 kcal", "30 min"]);
  const total = PLAN.reduce((s, p) => s + p.kcal, 0);
  const protein = PLAN.reduce((s, p) => s + p.p, 0);
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--background)" }}>
      <window.StatusBar />
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 18px 8px" }}>
        <button onClick={() => onNav("addons")} style={{ width: 36, height: 36, borderRadius: "var(--radius-full)", border: "1px solid var(--border)", background: "var(--card)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <DS.Icon name="arrow-left" size={19} color="var(--foreground)" />
        </button>
        <div><div style={{ fontSize: 11, letterSpacing: "0.09em", textTransform: "uppercase", fontWeight: 700, color: "var(--muted-foreground)" }}>Powered by Otto</div><div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em" }}>Meal plan</div></div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 20px 24px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
          {["High protein", "~1,800 kcal", "30 min", "Mediterranean", "Budget"].map((c) => {
            const on = active.includes(c);
            return <button key={c} onClick={() => setActive(on ? active.filter((x) => x !== c) : [...active, c])} style={{ border: on ? "1px solid var(--primary)" : "1px solid var(--border)", background: on ? "color-mix(in oklch, var(--primary) 12%, transparent)" : "var(--card)", color: on ? "var(--primary)" : "var(--muted-foreground)", borderRadius: "var(--radius-full)", padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{c}</button>;
          })}
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
          <div style={{ flex: 1, background: "var(--secondary)", borderRadius: "var(--radius-lg)", padding: "12px 14px" }}><div style={{ fontSize: 11, color: "var(--muted-foreground)", fontWeight: 600 }}>Total</div><div style={{ fontSize: 18, fontWeight: 800, fontFamily: "var(--font-mono)" }}>{total.toLocaleString()} <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>kcal</span></div></div>
          <div style={{ flex: 1, background: "var(--secondary)", borderRadius: "var(--radius-lg)", padding: "12px 14px" }}><div style={{ fontSize: 11, color: "var(--muted-foreground)", fontWeight: 600 }}>Protein</div><div style={{ fontSize: 18, fontWeight: 800, fontFamily: "var(--font-mono)" }}>{protein}g</div></div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {PLAN.map((p, i) => (
            <div key={i} style={{ display: "flex", gap: 13, alignItems: "center", padding: 12, background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", boxShadow: "var(--shadow-sm)" }}>
              <window.FoodTile hue={p.hue} icon={p.icon} size={54} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: "var(--muted-foreground)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{p.slot}</div>
                <div style={{ fontSize: 14.5, fontWeight: 700, letterSpacing: "-0.01em" }}>{p.name}</div>
                <div style={{ fontSize: 12, color: "var(--muted-foreground)", fontFamily: "var(--font-mono)" }}>{p.kcal} kcal · {p.p}g protein</div>
              </div>
              <button style={{ width: 32, height: 32, borderRadius: "var(--radius-full)", border: "1px solid var(--border)", background: "var(--card)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><DS.Icon name="rotate-cw" size={15} color="var(--muted-foreground)" /></button>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <DS.Button variant="outline" style={{ flex: 1 }}><DS.Icon name="sparkles" size={16} color="var(--foreground)" />Regenerate</DS.Button>
          <DS.Button style={{ flex: 1 }}><DS.Icon name="shopping-cart" size={16} color="var(--primary-foreground)" />Shopping list</DS.Button>
        </div>
      </div>
    </div>
  );
}
window.PlannerScreen = PlannerScreen;
