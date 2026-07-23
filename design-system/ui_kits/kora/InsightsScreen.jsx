/* Kora — Weekly Insights report. Distinctive summary, not a raw number dump. */
const DS = window.TesserixDesignSystem_275930;

const WEEK_KCAL = [1980, 2110, 1740, 2040, 1890, 1252, 0];
const DAYS = ["M", "T", "W", "T", "F", "S", "S"];
const INSIGHTS = [
  { icon: "beef", hue: 285, label: "Protein consistency", value: "6 / 7 days", note: "Hit target all but Sunday" },
  { icon: "flame", hue: 30, label: "Avg calories", value: "1,921", note: "180 under goal — lean week" },
  { icon: "utensils", hue: 45, label: "Most-logged meal", value: "Chicken bowl", note: "4× this week" },
  { icon: "trophy", hue: 260, label: "Highest-protein day", value: "Tue · 168g", note: "Post-gym" },
  { icon: "timer", hue: 220, label: "Longest fast", value: "16h 40m", note: "Thursday" },
  { icon: "moon", hue: 280, label: "Best sleep", value: "8.1 h", note: "Friday night" },
];

function InsightsScreen({ onNav }) {
  const max = Math.max(...WEEK_KCAL);
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--background)" }}>
      <window.StatusBar />
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 18px 8px" }}>
        <button onClick={() => onNav("progress")} style={{ width: 36, height: 36, borderRadius: "var(--radius-full)", border: "1px solid var(--border)", background: "var(--card)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <DS.Icon name="arrow-left" size={19} color="var(--foreground)" />
        </button>
        <div><div style={{ fontSize: 11, letterSpacing: "0.09em", textTransform: "uppercase", fontWeight: 700, color: "var(--muted-foreground)" }}>Jul 18 – 24</div><div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em" }}>Weekly report</div></div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 20px 24px" }}>
        <DS.Card style={{ padding: 20, marginBottom: 16, background: "var(--primary)", border: "none" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--primary-foreground)", opacity: 0.85, fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em" }}><DS.Icon name="sparkles" size={15} color="var(--primary-foreground)" />Otto's take</div>
          <p style={{ margin: "8px 0 0", fontSize: 18, lineHeight: 1.4, fontWeight: 700, color: "var(--primary-foreground)", letterSpacing: "-0.01em" }}>Your most consistent week yet — protein steady and calories under goal six days running.</p>
        </DS.Card>

        <DS.Card style={{ padding: 18, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted-foreground)", marginBottom: 14 }}>Calories by day</div>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", height: 96, gap: 8 }}>
            {WEEK_KCAL.map((v, i) => (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <div style={{ width: "100%", height: v ? `${(v / max) * 80}px` : 3, borderRadius: "var(--radius-sm)", background: v ? (i === 5 ? "var(--primary)" : "color-mix(in oklch, var(--primary) 32%, transparent)") : "var(--border)" }} />
                <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--muted-foreground)" }}>{DAYS[i]}</span>
              </div>
            ))}
          </div>
        </DS.Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {INSIGHTS.map((it, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 13, padding: 14, background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", boxShadow: "var(--shadow-sm)" }}>
              <span style={{ width: 40, height: 40, borderRadius: "var(--radius-lg)", background: `oklch(0.95 0.045 ${it.hue})`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><DS.Icon name={it.icon} size={19} color={`oklch(0.52 0.13 ${it.hue})`} /></span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: "var(--muted-foreground)", fontWeight: 600 }}>{it.label}</div>
                <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{it.note}</div>
              </div>
              <span style={{ fontSize: 15, fontWeight: 800, fontFamily: "var(--font-mono)", letterSpacing: "-0.01em" }}>{it.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
window.InsightsScreen = InsightsScreen;
