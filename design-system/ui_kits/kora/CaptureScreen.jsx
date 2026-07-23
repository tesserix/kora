/* Kora — AI Capture. Unified photo + chat composer with Otto. Futuristic dark surface. */
const DS = window.TesserixDesignSystem_275930;

const DETECTED = [
  { name: "Grilled chicken breast", grams: 140, kcal: 231, hue: 30, icon: "drumstick", conf: 0.96 },
  { name: "Steamed broccoli", grams: 90, kcal: 31, hue: 150, icon: "leaf", conf: 0.91 },
  { name: "Brown rice", grams: 120, kcal: 148, hue: 70, icon: "wheat", conf: 0.88 },
];

function OttoBubble({ children }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <span style={{ width: 30, height: 30, flexShrink: 0, borderRadius: "var(--radius-full)", background: "var(--primary)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 0 3px color-mix(in oklch,var(--primary) 22%,transparent)" }}>
        <DS.Icon name="sparkles" size={16} color="var(--primary-foreground)" />
      </span>
      <div style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", borderRadius: "var(--radius-xl)", borderTopLeftRadius: 6, padding: "12px 14px", fontSize: 14, lineHeight: 1.5, maxWidth: "80%", backdropFilter: "blur(8px)" }}>
        {children}
      </div>
    </div>
  );
}

function UserBubble({ children }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <div style={{ background: "var(--primary)", color: "var(--primary-foreground)", borderRadius: "var(--radius-xl)", borderTopRightRadius: 6, padding: "10px 14px", fontSize: 14, lineHeight: 1.5, maxWidth: "80%", fontWeight: 500 }}>{children}</div>
    </div>
  );
}

function DetectedCard({ items, onAdd }) {
  const total = items.reduce((s, i) => s + i.kcal, 0);
  return (
    <div style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: "var(--radius-xl)", padding: 14, backdropFilter: "blur(8px)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "rgba(255,255,255,0.6)" }}>Detected · 3 items</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 700, color: "#fff" }}>{total} kcal</span>
      </div>
      {items.map((it, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 11, padding: "8px 0", borderBottom: i < items.length - 1 ? "1px solid rgba(255,255,255,0.1)" : "none" }}>
          <span style={{ width: 38, height: 38, borderRadius: "var(--radius-md)", background: `oklch(0.4 0.1 ${it.hue})`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <DS.Icon name={it.icon} size={18} color={`oklch(0.9 0.08 ${it.hue})`} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>{it.name}</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", fontFamily: "var(--font-mono)" }}>{it.grams}g · {Math.round(it.conf*100)}% match</div>
          </div>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700, color: "#fff" }}>{it.kcal}</span>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <DS.Button onClick={onAdd} style={{ flex: 1 }}><DS.Icon name="check" size={16} color="var(--primary-foreground)" />Add to diary</DS.Button>
        <DS.Button variant="outline" style={{ background: "transparent", color: "#fff", borderColor: "rgba(255,255,255,0.25)" }}>Edit</DS.Button>
      </div>
    </div>
  );
}

function CaptureScreen({ mode, onNav, onLog, initialStage }) {
  const [stage, setStage] = React.useState(initialStage || "idle"); // idle → analyzing → result
  const [input, setInput] = React.useState(mode === "chat" ? "type" : "photo");
  const [text, setText] = React.useState("");
  const analyze = () => { setStage("analyzing"); setTimeout(() => setStage("result"), 1400); };

  return (
    <div style={{ position: "absolute", inset: 0, background: "oklch(0.19 0.03 165)", display: "flex", flexDirection: "column" }}>
      {window.StatusBar ? <window.StatusBar dark /> : <div style={{ height: 54 }} />}
      {/* top bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px 10px" }}>
        <button onClick={() => onNav("home")} style={{ background: "rgba(255,255,255,0.1)", border: "none", width: 36, height: 36, borderRadius: "var(--radius-full)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <DS.Icon name="x" size={20} color="#fff" />
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 7, color: "#fff", fontWeight: 700 }}>
          <DS.Icon name="sparkles" size={17} color="var(--primary)" /> Ask Otto
        </div>
        <button style={{ background: "rgba(255,255,255,0.1)", border: "none", width: 36, height: 36, borderRadius: "var(--radius-full)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <DS.Icon name="images" size={18} color="#fff" />
        </button>
      </div>

      {/* thread */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 18px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
        <OttoBubble>Hi Alex — show me your meal or just tell me what you ate. A photo works great. 📷 is optional; words work too.</OttoBubble>

        {stage === "idle" && input === "photo" && (
          <div onClick={analyze} style={{ marginTop: 4, position: "relative", height: 200, borderRadius: "var(--radius-2xl)", overflow: "hidden", background: "oklch(0.93 0.03 285)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <DS.Icon name="utensils" size={54} color="oklch(0.52 0.13 285)" />
            <div style={{ position: "absolute", inset: 0, border: "2px dashed rgba(0,0,0,0.12)", borderRadius: "var(--radius-2xl)", margin: 10 }} />
            <div style={{ position: "absolute", bottom: 12, left: 0, right: 0, textAlign: "center", color: "oklch(0.4 0.13 285)", fontSize: 13, fontWeight: 600 }}>Tap the viewfinder to capture</div>
          </div>
        )}

        {stage === "idle" && input === "voice" && (
          <div onClick={analyze} style={{ marginTop: 4, height: 200, borderRadius: "var(--radius-2xl)", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18 }}>
            <span style={{ width: 72, height: 72, borderRadius: "var(--radius-full)", background: "var(--primary)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 0 10px color-mix(in oklch, var(--primary) 22%, transparent)" }}><DS.Icon name="mic" size={30} color="var(--primary-foreground)" /></span>
            <div style={{ display: "flex", alignItems: "center", gap: 4, height: 26 }}>
              {[10,20,14,26,16,22,12,18,10].map((h,i)=>(<span key={i} style={{ width: 3, height: h, borderRadius: 3, background: "var(--primary)", animation: `tsx-wave 1s ease-in-out ${i*0.09}s infinite alternate` }} />))}
            </div>
            <span style={{ color: "rgba(255,255,255,0.75)", fontSize: 13, fontWeight: 600 }}>Listening… tell Otto what you ate</span>
            <style>{"@keyframes tsx-wave{to{transform:scaleY(1.9)}}"}</style>
          </div>
        )}

        {stage === "idle" && input === "scan" && (
          <div onClick={analyze} style={{ marginTop: 4, position: "relative", height: 200, borderRadius: "var(--radius-2xl)", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: 200, height: 110, borderRadius: "var(--radius-lg)", border: "2px solid rgba(255,255,255,0.25)", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 2, background: "var(--primary)", boxShadow: "0 0 12px var(--primary)", animation: "tsx-scan 1.6s ease-in-out infinite alternate" }} />
              <DS.Icon name="barcode" size={64} color="rgba(255,255,255,0.4)" style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)" }} />
            </div>
            <div style={{ position: "absolute", bottom: 12, left: 0, right: 0, textAlign: "center", color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: 600 }}>Point at a barcode</div>
            <style>{"@keyframes tsx-scan{from{top:20%}to{top:80%}}"}</style>
          </div>
        )}

        {stage === "idle" && input === "type" && (
          <UserBubble>Grilled chicken with broccoli and brown rice</UserBubble>
        )}

        {stage === "analyzing" && (
          <>
            {mode !== "chat" && <UserBubble>📷 Meal photo</UserBubble>}
            <div style={{ display: "flex", gap: 10, alignItems: "center", color: "rgba(255,255,255,0.7)", fontSize: 13, paddingLeft: 40 }}>
              <DS.Icon name="loader" size={16} color="var(--primary)" style={{ animation: "tsx-spin 0.9s linear infinite" }} />
              Otto is analyzing…
              <style>{"@keyframes tsx-spin{to{transform:rotate(360deg)}}"}</style>
            </div>
          </>
        )}

        {stage === "result" && (
          <>
            <OttoBubble>Got it — I found three items, about <strong>410 kcal</strong>. Looks like a lean, high-protein plate. Confirm and I'll log it to dinner.</OttoBubble>
            <DetectedCard items={DETECTED} onAdd={() => { onLog(DETECTED); onNav("home"); }} />
          </>
        )}
      </div>

      {/* composer */}
      <div style={{ padding: "10px 14px", paddingBottom: 26, background: "rgba(0,0,0,0.25)", borderTop: "1px solid rgba(255,255,255,0.1)", backdropFilter: "blur(12px)" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          {[["camera","Photo","photo"],["mic","Voice","voice"],["scan-barcode","Scan","scan"],["type","Type","type"]].map(([ic,l,key])=>{
            const on = input===key;
            return (<button key={l} onClick={()=>{setInput(key);setStage("idle");}} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: "var(--radius-full)", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "var(--font-sans)", background: on?"var(--primary)":"rgba(255,255,255,0.1)", color: on?"var(--primary-foreground)":"rgba(255,255,255,0.75)" }}>
              <DS.Icon name={ic} size={14} color={on?"var(--primary-foreground)":"rgba(255,255,255,0.75)"} />{l}
            </button>);
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(255,255,255,0.1)", borderRadius: "var(--radius-full)", padding: "6px 6px 6px 8px" }}>
          <button onClick={analyze} style={{ width: 38, height: 38, borderRadius: "var(--radius-full)", background: "var(--primary)", border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
            <DS.Icon name="camera" size={19} color="var(--primary-foreground)" />
          </button>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Tell Otto what you ate…"
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: "#fff", fontSize: 15, fontFamily: "var(--font-sans)" }} />
          <button onClick={analyze} style={{ width: 38, height: 38, borderRadius: "var(--radius-full)", background: text ? "var(--primary)" : "rgba(255,255,255,0.15)", border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
            <DS.Icon name="arrow-up" size={19} color="#fff" />
          </button>
        </div>
      </div>
    </div>
  );
}

window.CaptureScreen = CaptureScreen;
