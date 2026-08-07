/* Kora — Home. Conversational, Otto-led feed (NOT a calorie-tracker dashboard).
   Hero = Otto's coaching line + a capture prompt. Numbers are a compact secondary strip.
   Today reads as a feed of meals with inline Otto notes, not a data grid. */
const DS = window.TesserixDesignSystem_275930;

function FuelStrip({ eaten, goal, macros }) {
  const pct = Math.min(100, (eaten / goal) * 100);
  const M = [["P", macros.p, 140, 285], ["C", macros.c, 220, 45], ["F", macros.f, 70, 30]];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "14px 16px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", boxShadow: "var(--shadow-sm)" }}>
      <DS.CircularProgress value={eaten} max={goal} size={54} stroke={6} color="var(--primary)">
        <span style={{ fontSize: 11, fontWeight: 800, fontFamily: "var(--font-mono)" }}>{Math.round(pct)}%</span>
      </DS.CircularProgress>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
          <span style={{ fontSize: 17, fontWeight: 800, fontFamily: "var(--font-mono)", letterSpacing: "-0.02em" }}>{(goal - eaten).toLocaleString()}</span>
          <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>kcal left · {eaten.toLocaleString()} of {goal.toLocaleString()}</span>
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
          {M.map(([l, v, g, h]) => (
            <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--muted-foreground)" }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: `oklch(0.6 0.15 ${h})` }} />{l} {v}/{g}g
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function FeedMeal({ meal, onOpen }) {
  const { FoodTile } = window;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button onClick={onOpen} style={{ width: "100%", display: "flex", gap: 14, alignItems: "center", padding: 12, background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", boxShadow: "var(--shadow-sm)", cursor: "pointer", textAlign: "left" }}>
        <FoodTile hue={meal.hue} icon={meal.icon} size={60} radius="var(--radius-lg)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: "var(--muted-foreground)", fontFamily: "var(--font-mono)" }}>{meal.time}</div>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em" }}>{meal.name}</div>
          <div style={{ fontSize: 12, color: "var(--muted-foreground)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meal.meta}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "var(--font-mono)" }}>{meal.kcal}</div>
          <div style={{ fontSize: 10, color: "var(--muted-foreground)", fontFamily: "var(--font-mono)" }}>kcal</div>
        </div>
      </button>
      {meal.note && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "0 4px 0 8px" }}>
          <DS.Icon name="sparkles" size={14} color="var(--primary)" style={{ marginTop: 2 }} />
          <span style={{ fontSize: 12.5, color: "var(--muted-foreground)", lineHeight: 1.45 }}>{meal.note}</span>
        </div>
      )}
    </div>
  );
}

function HomeScreen({ data, onNav, onOpenMeal }) {
  const eaten = data.meals.reduce((s, m) => s + (m.kcal || 0), 0);
  const goal = data.calorieGoal;
  const logged = data.meals.filter((m) => m.kcal);
  const next = data.meals.find((m) => !m.kcal);
  const NOTES = ["Solid protein start — kept you full till noon.", null, "Smart snack choice.", null];

  return (
    <div style={{ padding: "0 0 118px" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 20px 16px" }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 700, color: "var(--muted-foreground)" }}>Wed · Jul 24</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--foreground)" }}>Good evening, Alex</div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => onNav("coach")} style={{ width: 40, height: 40, borderRadius: "var(--radius-full)", border: "1px solid var(--border)", background: "var(--card)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <DS.Icon name="message-circle" size={19} color="var(--foreground)" />
          </button>
          <DS.Avatar initials="AS" size="md" />
        </div>
      </div>

      {/* Otto editorial headline */}
      <div style={{ padding: "0 20px 18px" }}>
        <h1 style={{ margin: 0, fontSize: 27, lineHeight: 1.18, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--foreground)" }}>
          You're <span style={{ color: "var(--primary)" }}>{(goal - eaten).toLocaleString()} kcal</span> from a strong day.
        </h1>
        <p style={{ margin: "8px 0 0", fontSize: 14.5, lineHeight: 1.5, color: "var(--muted-foreground)" }}>
          Protein's on track. A lean, high-protein dinner and you'll close every ring — want a suggestion?
        </p>
      </div>

      {/* Capture hero — conversation-first */}
      <div style={{ padding: "0 20px 18px" }}>
        <button onClick={() => onNav("capture")} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "14px 14px 14px 18px", borderRadius: "var(--radius-2xl)", border: "none", cursor: "pointer", background: "var(--primary)", color: "var(--primary-foreground)", boxShadow: "var(--shadow-lg)", textAlign: "left" }}>
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
          <span style={{ flex: 1, fontSize: 15, fontWeight: 600 }}>Snap a meal or tell Otto what you ate…</span>
          <span style={{ display: "flex", gap: 8 }}>
            <span style={{ width: 34, height: 34, borderRadius: "var(--radius-full)", background: "rgba(255,255,255,0.18)", display: "flex", alignItems: "center", justifyContent: "center" }}><DS.Icon name="camera" size={17} color="var(--primary-foreground)" /></span>
            <span style={{ width: 34, height: 34, borderRadius: "var(--radius-full)", background: "rgba(255,255,255,0.18)", display: "flex", alignItems: "center", justifyContent: "center" }}><DS.Icon name="mic" size={17} color="var(--primary-foreground)" /></span>
          </span>
        </button>
      </div>

      {/* Compact fuel summary — secondary, not the identity */}
      <div style={{ padding: "0 20px 20px" }}>
        <FuelStrip eaten={eaten} goal={goal} macros={data.macros} />
      </div>

      {/* Today feed */}
      <div style={{ padding: "0 20px" }}>
        <span style={{ fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted-foreground)" }}>Today</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 12 }}>
          {logged.map((m, i) => <FeedMeal key={i} meal={{ ...m, note: NOTES[i] }} onOpen={() => onOpenMeal(m)} />)}
          {next && (
            <button onClick={() => onNav("capture")} style={{ display: "flex", alignItems: "center", gap: 12, padding: 16, borderRadius: "var(--radius-xl)", border: "1.5px dashed var(--border)", background: "transparent", cursor: "pointer", color: "var(--muted-foreground)" }}>
              <DS.Icon name="plus" size={20} color="var(--primary)" />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)" }}>Add dinner</span>
              <span style={{ marginLeft: "auto", fontSize: 12 }}>Snap · say · scan</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
window.HomeScreen = HomeScreen;
