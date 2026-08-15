import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// Regression guard for a crash shipped in build 21 (kora#175).
//
// `GestureDetector` reaches its child's underlying native view by cloning the
// element with a ref. `PressableScale` is a plain function component and
// forwards no ref, so RNGH has nothing to attach to and the screen crashes on
// mount — not at build time, not in a unit test that renders the component in
// isolation, only on a device when the two are nested.
//
// Every other GestureDetector in the app hands it a host component (`View` in
// TickRuler, `Animated.View` in Sheet), which is why the mic was the only site
// that broke. This asserts the pairing never comes back.
//
// Source-level rather than render-level on purpose: the failure is structural,
// it spans two files, and a render test would need a real native host to
// reproduce the crash at all.

const ROOT = path.resolve(__dirname, "../../..");

function sourceFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "app", "src", "--", "*.tsx"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return out.split("\n").filter((f) => f && !f.includes("__tests__"));
}

test("no GestureDetector is handed a PressableScale", () => {
  const offenders: string[] = [];

  for (const rel of sourceFiles()) {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    if (!src.includes("<GestureDetector")) continue;

    // Look at what follows each GestureDetector open tag, skipping comments and
    // whitespace, and capture the first JSX element it actually wraps.
    for (const chunk of src.split("<GestureDetector").slice(1)) {
      const afterTag = chunk.slice(chunk.indexOf(">") + 1);
      const withoutComments = afterTag
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const child = withoutComments.match(/<\s*([A-Za-z][A-Za-z0-9_.]*)/);
      if (child && child[1] === "PressableScale") offenders.push(rel);
    }
  }

  expect(offenders).toEqual([]);
});
