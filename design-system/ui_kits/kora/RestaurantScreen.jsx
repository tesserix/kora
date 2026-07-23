/* Kora — Restaurant mode. Search chains; AI imports/estimates nutrition. */
const DS = window.TesserixDesignSystem_275930;

const CHAINS = ["Nando's", "Subway", "McDonald's", "KFC", "Chipotle", "Pret"];
const MENU = [
  { name: "1/4 Chicken, skin off", meta: "Nando's", kcal: 285, p: 44, hue: 30, verified: true },
  { name: "PERi-PERi chips (regular)", meta: "Nando's", kcal: 342, p: 6, hue: 45, verified: true },
  { name: "Grilled corn on the cob", meta: "Nando's", kcal: 140, p: 4, hue: 70, verified: false },
  { name: "Spicy rice", meta: "Nando's", kcal: 232, p: 5, hue: 20, verified: false },
];

function RestaurantScreen({ onNav }) {
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--background)" }}>
      <window.StatusBar />
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 18px 10px" }}>
        <button onClick={() => onNav("addons")} style={{ width: 36, height: 36, borderRadius: "var(--radius-full)", border: "1px solid var(--border)", background: "var(--card)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <DS.Icon name="arrow-left" size={19} color="var(--foreground)" />
        </button>
        <div><div style={{ fontSize: 11, letterSpacing: "0.09em", textTransform: "uppercase", fontWeight: 700, color: "var(--muted-foreground)" }}>Eating out</div><div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em" }}>Restaurants</div></div>
      </div>
      <div style={{ padding: "0 18px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--secondary)", borderRadius: "var(--radius-full)", padding: "11px 16px" }}>
          <DS.Icon name="search" size={18} color="var(--muted-foreground)" />
          <span style={{ fontSize: 15, color: "var(--muted-foreground)" }}>Search a restaurant or dish…</span>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 20px 24px" }}>
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 16 }}>
          {CHAINS.map((c, i) => (
            <div key={c} style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderRadius: "var(--radius-full)", border: i === 0 ? "1px solid var(--primary)" : "1px solid var(--border)", background: i === 0 ? "color-mix(in oklch, var(--primary) 12%, transparent)" : "var(--card)", color: i === 0 ? "var(--primary)" : "var(--foreground)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              <DS.Icon name="store" size={15} color={i === 0 ? "var(--primary)" : "var(--muted-foreground)"} />{c}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Nando's · popular</span>
          <DS.Badge variant="info"><DS.Icon name="sparkles" size={12} color="var(--info-muted-foreground)" />AI-matched</DS.Badge>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {MENU.map((m, i) => (
            <div key={i} style={{ display: "flex", gap: 13, alignItems: "center", padding: 13, background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", boxShadow: "var(--shadow-sm)" }}>
              <window.FoodTile hue={m.hue} icon="utensils" size={46} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14.5, fontWeight: 700, letterSpacing: "-0.01em" }}>{m.name}</div>
                <div style={{ fontSize: 12, color: "var(--muted-foreground)", fontFamily: "var(--font-mono)" }}>{m.kcal} kcal · {m.p}g protein · {m.verified ? "verified" : "≈ estimated"}</div>
              </div>
              <button style={{ width: 32, height: 32, borderRadius: "var(--radius-full)", border: "none", background: "var(--primary)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><DS.Icon name="plus" size={16} color="var(--primary-foreground)" /></button>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "flex-start", padding: 14, borderRadius: "var(--radius-lg)", background: "var(--accent)", border: "1px solid color-mix(in oklch, var(--primary) 20%, transparent)" }}>
          <DS.Icon name="sparkles" size={16} color="var(--primary)" style={{ marginTop: 1 }} />
          <span style={{ fontSize: 13, color: "var(--foreground)", lineHeight: 1.45 }}>No official data? Otto estimates from a photo or the dish description — flagged as approximate.</span>
        </div>
      </div>
    </div>
  );
}
window.RestaurantScreen = RestaurantScreen;
