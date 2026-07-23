/* Kora — Progress. Weight trend chart + key stats. */
const DS = window.TesserixDesignSystem_275930;

const WEIGHTS = [74.2, 74.0, 73.6, 73.7, 73.1, 72.8, 72.4];
const LABELS = ["Jul 17", "", "Jul 19", "", "Jul 21", "", "Jul 23"];

function WeightChart() {
  const w = 300, h = 130, pad = 10;
  const min = Math.min(...WEIGHTS) - 0.4, max = Math.max(...WEIGHTS) + 0.4;
  const x = (i) => pad + (i * (w - pad * 2)) / (WEIGHTS.length - 1);
  const y = (v) => pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
  const pts = WEIGHTS.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${x(0)},${h - pad} ${pts} ${x(WEIGHTS.length - 1)},${h - pad}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "auto", display: "block" }}>
      <defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--primary)" stopOpacity="0.22" /><stop offset="100%" stopColor="var(--primary)" stopOpacity="0" /></linearGradient></defs>
      <polygon points={area} fill="url(#wg)" />
      <polyline points={pts} fill="none" stroke="var(--primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {WEIGHTS.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={i === WEIGHTS.length - 1 ? 4.5 : 2.5} fill="var(--primary)" stroke="var(--background)" strokeWidth="1.5" />)}
    </svg>
  );
}

function ProgressScreen({ onNav }) {
  const { ScreenHeader } = window;
  const [range, setRange] = React.useState("1W");
  return (
    <div style={{ padding: "0 0 118px" }}>
      <ScreenHeader overline="Trends" title="Progress"
        right={<DS.Button variant="outline" size="sm" onClick={() => onNav && onNav("insights")}><DS.Icon name="sparkles" size={15} color="var(--foreground)" />Weekly report</DS.Button>} />
      <div style={{ padding: "0 20px", display: "flex", flexDirection: "column", gap: 16 }}>
        <DS.Card style={{ padding: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
            <div>
              <div style={{ fontSize: 12, color: "var(--muted-foreground)", fontWeight: 600 }}>Weight</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.03em", fontFamily: "var(--font-mono)" }}>72.4</span>
                <span style={{ fontSize: 14, color: "var(--muted-foreground)" }}>kg</span>
              </div>
            </div>
            <DS.Badge variant="success"><DS.Icon name="trending-down" size={13} color="var(--success-muted-foreground)" />1.8 kg</DS.Badge>
          </div>
          <WeightChart />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            {LABELS.map((l, i) => <span key={i} style={{ fontSize: 9, color: "var(--muted-foreground)", fontFamily: "var(--font-mono)" }}>{l}</span>)}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 14 }}>
            {["1W", "1M", "3M", "1Y"].map((r) => (
              <button key={r} onClick={() => setRange(r)} style={{ flex: 1, padding: "7px 0", borderRadius: "var(--radius-md)", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "var(--font-mono)", background: range === r ? "var(--secondary)" : "transparent", color: range === r ? "var(--primary)" : "var(--muted-foreground)" }}>{r}</button>
            ))}
          </div>
        </DS.Card>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <DS.Card style={{ padding: 16 }}><DS.Stat label="Avg intake" value="1,921" unit="kcal" delta="On target" trend="down" /></DS.Card>
          <DS.Card style={{ padding: 16 }}><DS.Stat label="Log streak" value="12" unit="days" delta="Personal best" trend="up" /></DS.Card>
          <DS.Card style={{ padding: 16 }}><DS.Stat label="Avg steps" value="8,240" delta="+6% wk" trend="up" /></DS.Card>
          <DS.Card style={{ padding: 16 }}><DS.Stat label="Avg sleep" value="7.1" unit="hrs" /></DS.Card>
        </div>
      </div>
    </div>
  );
}
window.ProgressScreen = ProgressScreen;
