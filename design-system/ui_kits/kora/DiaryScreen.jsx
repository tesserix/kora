/* Kora — Diary. Week strip + timeline of logged meals for the selected day. */
const DS = window.TesserixDesignSystem_275930;

const WEEK = [
  { d: "M", n: 18, kcal: 1980 }, { d: "T", n: 19, kcal: 2110 }, { d: "W", n: 20, kcal: 1740 },
  { d: "T", n: 21, kcal: 2040 }, { d: "F", n: 22, kcal: 1890 }, { d: "S", n: 23, kcal: 1252, today: true }, { d: "S", n: 24, kcal: null },
];

function DiaryScreen({ data, onOpenMeal }) {
  const { FoodTile, ScreenHeader } = window;
  const [sel, setSel] = React.useState(23);
  const logged = data.meals.filter((m) => m.kcal);
  return (
    <div style={{ padding: "0 0 110px" }}>
      <ScreenHeader overline="This week" title="Diary" />
      {/* week strip */}
      <div style={{ display: "flex", gap: 8, padding: "0 20px 8px", overflowX: "auto" }}>
        {WEEK.map((w) => {
          const on = w.n === sel;
          return (
            <button key={w.n} onClick={() => setSel(w.n)} style={{ flex: "1 0 auto", minWidth: 42, borderRadius: "var(--radius-lg)", border: on ? "none" : "1px solid var(--border)", background: on ? "var(--primary)" : "var(--card)", color: on ? "var(--primary-foreground)" : "var(--foreground)", padding: "10px 0", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.7 }}>{w.d}</span>
              <span style={{ fontSize: 16, fontWeight: 700 }}>{w.n}</span>
              <span style={{ width: 5, height: 5, borderRadius: 999, background: w.kcal ? (on ? "var(--primary-foreground)" : "var(--primary)") : "transparent" }} />
            </button>
          );
        })}
      </div>

      <div style={{ padding: "12px 20px 0" }}>
        <DS.Card style={{ padding: 16, display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <DS.Stat label="Total intake" value="1,252" unit="kcal" />
          <div style={{ height: 40, width: 1, background: "var(--border)" }} />
          <DS.Stat label="Remaining" value="748" unit="kcal" />
          <div style={{ height: 40, width: 1, background: "var(--border)" }} />
          <DS.Stat label="Water" value="1.4" unit="L" />
        </DS.Card>

        <span style={{ fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted-foreground)" }}>Timeline</span>
        <div style={{ marginTop: 10, position: "relative", paddingLeft: 20 }}>
          <div style={{ position: "absolute", left: 5, top: 6, bottom: 6, width: 2, background: "var(--border)" }} />
          {logged.map((m, i) => (
            <button key={i} onClick={() => onOpenMeal(m)} style={{ position: "relative", width: "100%", display: "flex", gap: 12, alignItems: "center", padding: "10px 0", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>
              <span style={{ position: "absolute", left: -18, top: 22, width: 10, height: 10, borderRadius: 999, background: "var(--primary)", border: "2px solid var(--background)" }} />
              <FoodTile hue={m.hue} icon={m.icon} size={48} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: "var(--muted-foreground)", fontFamily: "var(--font-mono)" }}>{m.time}</div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{m.name}</div>
                <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{m.meta}</div>
              </div>
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 14 }}>{m.kcal}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
window.DiaryScreen = DiaryScreen;
