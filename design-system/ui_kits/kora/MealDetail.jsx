/* Kora — Meal detail sheet content. Editable item list + macro summary. */
const DS = window.TesserixDesignSystem_275930;

function Stepper({ value, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button onClick={() => onChange(Math.max(0, value - 10))} style={{ width: 28, height: 28, borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--card)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><DS.Icon name="minus" size={14} color="var(--foreground)" /></button>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700, minWidth: 44, textAlign: "center" }}>{value}g</span>
      <button onClick={() => onChange(value + 10)} style={{ width: 28, height: 28, borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--card)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><DS.Icon name="plus" size={14} color="var(--foreground)" /></button>
    </div>
  );
}

function MealDetailSheet({ meal, onClose }) {
  const { FoodTile } = window;
  const items = meal.items || [
    { name: "Grilled chicken breast", grams: 140, kcal: 231, hue: 30, icon: "drumstick" },
    { name: "Steamed broccoli", grams: 90, kcal: 31, hue: 150, icon: "leaf" },
    { name: "Brown rice", grams: 120, kcal: 148, hue: 70, icon: "wheat" },
  ];
  const [g, setG] = React.useState(items.map((i) => i.grams));
  return (
    <div style={{ padding: "8px 22px 30px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 0 18px" }}>
        <FoodTile hue={meal.hue} icon={meal.icon} size={64} radius="var(--radius-xl)" />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: "var(--muted-foreground)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em" }}>{meal.name} · {meal.time}</div>
          <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em" }}>{meal.kcal} <span style={{ fontSize: 14, color: "var(--muted-foreground)", fontFamily: "var(--font-mono)" }}>kcal</span></div>
        </div>
        <DS.Badge variant="success"><DS.Icon name="sparkles" size={12} color="var(--success-muted-foreground)" />AI logged</DS.Badge>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        {[["Protein", "48g", 155], ["Carbs", "132g", 70], ["Fat", "12g", 30]].map(([l, v, h]) => (
          <div key={l} style={{ flex: 1, background: `oklch(0.96 0.03 ${h})`, borderRadius: "var(--radius-lg)", padding: "10px 12px" }}>
            <div style={{ fontSize: 11, color: "var(--muted-foreground)", fontWeight: 600 }}>{l}</div>
            <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "var(--font-mono)", color: `oklch(0.42 0.12 ${h})` }}>{v}</div>
          </div>
        ))}
      </div>

      <span style={{ fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted-foreground)" }}>Items</span>
      <div style={{ margin: "8px 0 20px" }}>
        {items.map((it, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: i < items.length - 1 ? "1px solid var(--border)" : "none" }}>
            <FoodTile hue={it.hue} icon={it.icon} size={40} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{it.name}</div>
              <div style={{ fontSize: 12, color: "var(--muted-foreground)", fontFamily: "var(--font-mono)" }}>{it.kcal} kcal</div>
            </div>
            <Stepper value={g[i]} onChange={(v) => setG(g.map((x, j) => (j === i ? v : x)))} />
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <DS.Button variant="outline" style={{ flex: "0 0 auto" }} onClick={onClose}><DS.Icon name="trash-2" size={16} color="var(--destructive)" /></DS.Button>
        <DS.Button style={{ flex: 1 }} onClick={onClose}>Save changes</DS.Button>
      </div>
    </div>
  );
}
window.MealDetailSheet = MealDetailSheet;
