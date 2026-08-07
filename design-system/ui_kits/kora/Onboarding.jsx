/* Kora — Onboarding / goal setup (entry screen). */
const DS = window.TesserixDesignSystem_275930;

const GOALS = [
  { id: "lose", icon: "trending-down", title: "Lose weight", sub: "Gentle calorie deficit" },
  { id: "maintain", icon: "minus", title: "Maintain", sub: "Stay where you are" },
  { id: "gain", icon: "trending-up", title: "Build muscle", sub: "Lean surplus + protein" },
];

function Onboarding({ onStart }) {
  const [goal, setGoal] = React.useState("lose");
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--background)" }}>
      {window.StatusBar ? <window.StatusBar /> : <div style={{ height: 54 }} />}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 24px 24px", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
          <span style={{ width: 40, height: 40, borderRadius: "var(--radius-lg)", background: "var(--primary)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "var(--shadow-md)" }}>
            {/* Kora's mark: a 3x3 dot grid (see apps/mobile/assets/images/icon.png and
                apps/mobile/src/components/BrandMark.tsx). NOT the Lucide AI-affordance glyph, which
                must stay everywhere else in this kit. */}
            <span style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 2, width: 22, height: 22 }}>
              {[[0,0],[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2]].map(([r, c]) => {
                const muted = `${r}-${c}` === "0-1" || `${r}-${c}` === "1-2" || `${r}-${c}` === "2-1";
                const d = muted ? 3.5 : 6;
                return (
                  <span key={`${r}-${c}`} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ width: d, height: d, borderRadius: "50%", background: muted ? "var(--card-secondary)" : "var(--primary-foreground)" }} />
                  </span>
                );
              })}
            </span>
          </span>
          <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--foreground)" }}>Kora</span>
        </div>
        <h1 style={{ margin: 0, fontSize: 32, fontWeight: 800, letterSpacing: "-0.035em", lineHeight: 1.05, color: "var(--foreground)" }}>Snap it.<br />Otto tracks it.</h1>
        <p style={{ margin: "12px 0 26px", fontSize: 16, lineHeight: 1.5, color: "var(--muted-foreground)" }}>Photo or chat — log meals in seconds and let AI handle the calories and macros.</p>

        <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted-foreground)", marginBottom: 12 }}>What's your goal?</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {GOALS.map((g) => {
            const on = goal === g.id;
            return (
              <button key={g.id} onClick={() => setGoal(g.id)} style={{ display: "flex", alignItems: "center", gap: 14, padding: 16, borderRadius: "var(--radius-xl)", cursor: "pointer", textAlign: "left", background: "var(--card)", border: on ? "2px solid var(--primary)" : "2px solid var(--border)", boxShadow: on ? "var(--shadow-md)" : "none", transition: "var(--transition-all)" }}>
                <span style={{ width: 42, height: 42, borderRadius: "var(--radius-lg)", background: on ? "var(--primary)" : "var(--secondary)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <DS.Icon name={g.icon} size={20} color={on ? "var(--primary-foreground)" : "var(--primary)"} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "var(--foreground)" }}>{g.title}</div>
                  <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>{g.sub}</div>
                </div>
                <span style={{ width: 22, height: 22, borderRadius: 999, border: on ? "none" : "2px solid var(--border)", background: on ? "var(--primary)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {on && <DS.Icon name="check" size={14} color="var(--primary-foreground)" />}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ padding: "12px 24px 30px", borderTop: "1px solid var(--border)" }}>
        <DS.Button size="lg" style={{ width: "100%" }} onClick={onStart}>
          Get started<DS.Icon name="arrow-right" size={18} color="var(--primary-foreground)" />
        </DS.Button>
      </div>
    </div>
  );
}
window.Onboarding = Onboarding;
