/* Kora — AI Coach. Otto acts as a supportive nutrition coach: focus cards + conversational thread. */
const DS = window.TesserixDesignSystem_275930;

const FOCUS = [
  { icon: "beef", hue: 155, title: "Protein", body: "142 / 160g — one more Greek yogurt closes the gap.", variant: "info" },
  { icon: "wheat", hue: 70, title: "Fibre is low", body: "Under target 4 days running. Add beans or berries today.", variant: "warning" },
  { icon: "trending-down", hue: 285, title: "Weight trend", body: "Down 1.8kg this month — on pace for 75kg in ~6 weeks.", variant: "success" },
];

const THREAD = [
  { from: "otto", text: "Morning, Alex. You're trending well — protein's been consistent all week. Nice work. 👏" },
  { from: "user", text: "What should I have for dinner?" },
  { from: "otto", text: "You've got ~750 kcal and 35g protein left. A salmon fillet with quinoa and greens fits perfectly and pushes your omega-3s up. Want me to add it to your plan?" },
];

const CHIPS = ["Am I on track today?", "More protein ideas", "Plan my dinner", "How's my week?"];

function Bubble({ from, children }) {
  const otto = from === "otto";
  return (
    <div style={{ display: "flex", justifyContent: otto ? "flex-start" : "flex-end", gap: 10 }}>
      {otto && <span style={{ width: 28, height: 28, flexShrink: 0, borderRadius: "var(--radius-full)", background: "var(--primary)", display: "flex", alignItems: "center", justifyContent: "center" }}><DS.Icon name="sparkles" size={15} color="var(--primary-foreground)" /></span>}
      <div style={{ maxWidth: "78%", background: otto ? "var(--secondary)" : "var(--primary)", color: otto ? "var(--foreground)" : "var(--primary-foreground)", borderRadius: "var(--radius-xl)", borderTopLeftRadius: otto ? 6 : "var(--radius-xl)", borderTopRightRadius: otto ? "var(--radius-xl)" : 6, padding: "11px 14px", fontSize: 14, lineHeight: 1.5, fontWeight: otto ? 400 : 500 }}>{children}</div>
    </div>
  );
}

function CoachScreen({ onNav }) {
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--background)" }}>
      <window.StatusBar />
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 18px 12px" }}>
        <button onClick={() => onNav("home")} style={{ width: 36, height: 36, borderRadius: "var(--radius-full)", border: "1px solid var(--border)", background: "var(--card)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <DS.Icon name="arrow-left" size={19} color="var(--foreground)" />
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.09em", textTransform: "uppercase", fontWeight: 700, color: "var(--muted-foreground)" }}>Your coach</div>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em" }}>Otto</div>
        </div>
        <DS.Badge variant="success">Evidence-based</DS.Badge>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 18px 16px" }}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted-foreground)", margin: "6px 0 10px" }}>Today's focus</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
          {FOCUS.map((f, i) => (
            <DS.Callout key={i} variant={f.variant} title={f.title}
              icon={<span style={{ width: 30, height: 30, borderRadius: "var(--radius-lg)", background: `oklch(0.94 0.05 ${f.hue})`, display: "flex", alignItems: "center", justifyContent: "center" }}><DS.Icon name={f.icon} size={16} color={`oklch(0.5 0.13 ${f.hue})`} /></span>}>
              {f.body}
            </DS.Callout>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {THREAD.map((m, i) => <Bubble key={i} from={m.from}>{m.text}</Bubble>)}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 18 }}>
          {CHIPS.map((c) => (
            <button key={c} style={{ border: "1px solid var(--border)", background: "var(--card)", color: "var(--foreground)", borderRadius: "var(--radius-full)", padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)" }}>{c}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: "10px 16px 28px", borderTop: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--secondary)", borderRadius: "var(--radius-full)", padding: "6px 6px 6px 16px" }}>
          <input placeholder="Ask Otto anything…" style={{ flex: 1, background: "none", border: "none", outline: "none", fontSize: 15, color: "var(--foreground)", fontFamily: "var(--font-sans)" }} />
          <button style={{ width: 38, height: 38, borderRadius: "var(--radius-full)", background: "var(--primary)", border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <DS.Icon name="arrow-up" size={19} color="var(--primary-foreground)" />
          </button>
        </div>
      </div>
    </div>
  );
}
window.CoachScreen = CoachScreen;
