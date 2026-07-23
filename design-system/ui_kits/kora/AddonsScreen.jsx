/* Kora — Add-ons hub. Modular health trackers: steps, water, weight, meds, sleep, fasting. */
const DS = window.TesserixDesignSystem_275930;

function AddonCard({ icon, hue, title, value, unit, sub, progress, children }) {
  const color = `oklch(0.6 0.15 ${hue})`;
  return (
    <DS.Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ width: 36, height: 36, borderRadius: "var(--radius-lg)", background: `oklch(0.94 0.05 ${hue})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <DS.Icon name={icon} size={19} color={color} />
        </span>
        {children}
      </div>
      <div>
        <div style={{ fontSize: 12, color: "var(--muted-foreground)", fontWeight: 600 }}>{title}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <span style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-mono)", letterSpacing: "-0.02em" }}>{value}</span>
          {unit && <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{unit}</span>}
        </div>
        {progress != null && <div style={{ marginTop: 8 }}><DS.Progress value={progress} color={color} height={5} /></div>}
        {sub && <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 6 }}>{sub}</div>}
      </div>
    </DS.Card>
  );
}

function AddonsScreen({ onNav }) {
  const { ScreenHeader } = window;
  const [meds, setMeds] = React.useState(true);
  const TOOLS = [
    { id: "coach", icon: "message-circle", label: "AI Coach", hue: 285 },
    { id: "planner", icon: "calendar-check", label: "Meal plan", hue: 45 },
    { id: "restaurant", icon: "store", label: "Restaurants", hue: 30 },
    { id: "insights", icon: "chart-line", label: "Insights", hue: 220 },
  ];
  return (
    <div style={{ padding: "0 0 118px" }}>
      <ScreenHeader overline="Health" title="More" />
      <div style={{ padding: "0 20px 18px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
          {TOOLS.map((t) => (
            <button key={t.id} onClick={() => onNav(t.id)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7, padding: "14px 4px", borderRadius: "var(--radius-xl)", border: "1px solid var(--border)", background: "var(--card)", boxShadow: "var(--shadow-sm)", cursor: "pointer" }}>
              <span style={{ width: 40, height: 40, borderRadius: "var(--radius-lg)", background: `oklch(0.95 0.045 ${t.hue})`, display: "flex", alignItems: "center", justifyContent: "center" }}><DS.Icon name={t.icon} size={19} color={`oklch(0.52 0.13 ${t.hue})`} /></span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--foreground)", textAlign: "center" }}>{t.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{ padding: "0 20px 8px", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted-foreground)" }}>Trackers</div>
      <div style={{ padding: "0 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <AddonCard icon="footprints" hue={240} title="Steps" value="8,240" sub="Goal 10,000" progress={82} />
        <AddonCard icon="droplet" hue={220} title="Water" value="1.4" unit="/ 2.5 L" progress={56} />
        <AddonCard icon="scale" hue={155} title="Weight" value="72.4" unit="kg" sub="▼ 0.6 kg this week" />
        <AddonCard icon="moon" hue={280} title="Sleep" value="7.1" unit="hrs" sub="Bed 11:20 · Wake 6:30" />
        <AddonCard icon="pill" hue={30} title="Medication" value="2 / 3" sub="Vitamin D at 8pm"
          children={<DS.Switch checked={meds} onCheckedChange={setMeds} />} />
        <AddonCard icon="timer" hue={340} title="Fasting" value="14:22" sub="16:8 window" progress={78} />
      </div>

      <div style={{ padding: "16px 20px 0" }}>
        <DS.Callout variant="info" title="Sync health data"
          icon={<DS.Icon name="heart-pulse" size={18} color="var(--info-muted-foreground)" />}>
          Connect Apple Health or Google Fit to pull steps, heart rate, and sleep automatically.
        </DS.Callout>
      </div>
    </div>
  );
}
window.AddonsScreen = AddonsScreen;
