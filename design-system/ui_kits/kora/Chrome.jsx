/* Kora — shared app chrome: phone frame, status bar, bottom tab bar, bottom sheet.
   Consumes the Tesserix bundle via window.TesserixDesignSystem_275930. */
const DS = window.TesserixDesignSystem_275930;
const { Icon } = DS;

function StatusBar({ dark }) {
  const c = dark ? "#fff" : "var(--foreground)";
  return (
    <div style={{ height: 54, display: "flex", alignItems: "flex-end", justifyContent: "space-between", padding: "0 28px 8px", fontFamily: "var(--font-sans)", color: c, flexShrink: 0 }}>
      <span style={{ fontSize: 15, fontWeight: 600, fontFamily: "var(--font-mono)" }}>9:41</span>
      <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
        <Icon name="signal" size={16} color={c} />
        <Icon name="wifi" size={16} color={c} />
        <Icon name="battery-full" size={18} color={c} />
      </div>
    </div>
  );
}

const TABS = [
  { id: "home", icon: "house", label: "Home" },
  { id: "diary", icon: "book-open", label: "Diary" },
  { id: "capture", icon: "camera", label: "" },
  { id: "progress", icon: "chart-line", label: "Progress" },
  { id: "addons", icon: "grid-2x2", label: "More" },
];

function TabBar({ active, onNav }) {
  const glass = "color-mix(in oklch, var(--card) 68%, transparent)";
  const item = (t) => {
    if (t.id === "capture") {
      return (
        <button key={t.id} onClick={() => onNav("capture")} aria-label="Capture" style={{ width: 52, height: 52, margin: "0 2px", borderRadius: "var(--radius-full)", border: "none", background: "var(--primary)", color: "var(--primary-foreground)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 6px 16px -4px color-mix(in oklch, var(--primary) 60%, transparent)", cursor: "pointer" }}>
          <Icon name="sparkles" size={24} color="var(--primary-foreground)" />
        </button>
      );
    }
    const on = active === t.id;
    return (
      <button key={t.id} onClick={() => onNav(t.id)} aria-label={t.label || t.id} style={{ width: 52, height: 52, borderRadius: "var(--radius-full)", border: "none", background: on ? "color-mix(in oklch, var(--primary) 15%, transparent)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
        <Icon name={t.icon} size={22} color={on ? "var(--primary)" : "var(--muted-foreground)"} strokeWidth={on ? 2.5 : 2} />
      </button>
    );
  };
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, display: "flex", justifyContent: "center", paddingBottom: 22, pointerEvents: "none", zIndex: 20 }}>
      <div style={{ pointerEvents: "auto", display: "flex", alignItems: "center", gap: 2, padding: 7, borderRadius: "var(--radius-full)", background: glass, backdropFilter: "blur(24px) saturate(180%)", WebkitBackdropFilter: "blur(24px) saturate(180%)", border: "1px solid color-mix(in oklch, var(--foreground) 9%, transparent)", boxShadow: "0 12px 34px -10px rgba(0,0,0,0.28), inset 0 1px 0 color-mix(in oklch, var(--card) 90%, transparent)" }}>
        {TABS.map(item)}
      </div>
    </div>
  );
}

/* Rounded meal/photo tile — soft single-hue tint + centered icon (placeholder for real photography). */
function FoodTile({ hue = 150, icon = "utensils", size = 56, radius = "var(--radius-lg)" }) {
  return (
    <div style={{ width: size, height: size, borderRadius: radius, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: `oklch(0.93 0.06 ${hue})`, color: `oklch(0.5 0.12 ${hue})` }}>
      <Icon name={icon} size={Math.round(size * 0.42)} color={`oklch(0.5 0.12 ${hue})`} />
    </div>
  );
}

/* Bottom sheet overlay */
function Sheet({ open, onClose, children, dark }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", alignItems: "flex-end", background: "rgba(10,20,15,0.38)", backdropFilter: "blur(2px)" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxHeight: "82%", overflowY: "auto", background: dark ? "var(--card)" : "var(--background)", borderTopLeftRadius: "var(--radius-2xl)", borderTopRightRadius: "var(--radius-2xl)", boxShadow: "var(--shadow-2xl)", animation: "sheetUp 280ms cubic-bezier(0.4,0,0.2,1)" }}>
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 10 }}>
          <div style={{ width: 40, height: 5, borderRadius: 999, background: "var(--border)" }} />
        </div>
        {children}
      </div>
      <style>{"@keyframes sheetUp{from{transform:translateY(100%)}to{transform:translateY(0)}}"}</style>
    </div>
  );
}

/* Screen header with title + optional right slot */
function ScreenHeader({ overline, title, right }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "4px 20px 14px" }}>
      <div>
        {overline && <div style={{ fontSize: 11, letterSpacing: "0.09em", textTransform: "uppercase", fontWeight: 700, color: "var(--muted-foreground)", marginBottom: 3 }}>{overline}</div>}
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--foreground)" }}>{title}</h1>
      </div>
      {right}
    </div>
  );
}

Object.assign(window, { StatusBar, TabBar, FoodTile, Sheet, ScreenHeader });
