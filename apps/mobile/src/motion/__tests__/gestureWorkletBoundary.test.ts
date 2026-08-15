import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// Guard for the third UI-runtime crash of this shape in this codebase.
//
// With Reanimated installed, react-native-gesture-handler runs gesture
// callbacks on the UI thread as worklets. Calling a plain JS function from one
// throws, on device, at the moment the gesture is touched:
//
//   [Worklets] Tried to synchronously call a Remote Function.
//   Called "anonymous" on the UI Runtime.
//       at VoiceComposerTsx3
//       at runWorklet_reactNativeGestureHandler_useAnimatedGestureTs3
//
// VoiceComposer's pan called `send` (a closure over React callbacks),
// `clearArmTimer` (a ref mutation) and `setTimeout` — all JS-runtime — and
// crashed the app on the mic, the capture screen's primary control.
//
// **Jest cannot catch this.** RNGH is mocked in this project, so a synthesised
// pan exercises the mock rather than the worklet boundary — VoiceComposer's own
// comment says exactly that. So the check is source-level: every gesture must
// declare which side it runs on.
//
// Two legitimate shapes:
//   1. `.runOnJS(true)` — the whole gesture is JS-side glue (VoiceComposer).
//   2. `runOnJS(fn)()` inside the callbacks, with worklet-safe work otherwise
//      (TickRuler, Sheet — both assign to shared values and hop out explicitly).
//
// A gesture with neither is either already broken or one edit away from it.

const ROOT = path.resolve(__dirname, "../../..");

function sourceFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "app", "src", "--", "*.tsx", "*.ts"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\n").filter((f) => f && !f.includes("__tests__"));
}

test("every gesture declares its worklet boundary", () => {
  const offenders: string[] = [];

  for (const rel of sourceFiles()) {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    if (!/\bGesture\.[A-Z]/.test(src)) continue;

    // Take each gesture builder chain up to the JSX/return that consumes it.
    for (const chunk of src.split(/\bGesture\.[A-Z]/).slice(1)) {
      // Split only at OUTER-scope boundaries — a line indented two spaces or
      // less. Splitting on any `const` truncated the chain at `const next =`
      // *inside* Sheet's `.onChange`, hiding the `runOnJS` in its `.onEnd` and
      // reporting a correct file as broken. Chain internals are indented four
      // spaces or more.
      const chain = chunk.split(/\n {0,2}(?:const|return|function|export|\})/)[0];
      const declaresJS = /\.runOnJS\(\s*true\s*\)/.test(chain);
      const hopsOut = /\brunOnJS\s*\(/.test(chain);
      if (!declaresJS && !hopsOut) offenders.push(rel);
    }
  }

  expect(offenders).toEqual([]);
});
