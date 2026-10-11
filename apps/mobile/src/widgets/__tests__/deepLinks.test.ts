import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The single configurable KoraWidget deep-links by literal string in Swift,
// composed per metric inside MetricKind.present(snapshot:steps:) rather than
// one static widgetURL(...) per widget file. Nothing else in the app reads
// those strings, so a route rename would break a home-screen tap and no other
// test would notice. This asserts every deepLink still resolves to a real
// route file, and that the exact set of routes is what we expect — so a new
// metric that invents a route cannot slip in unnoticed.
const TARGETS = join(__dirname, "../../../targets/kora-widgets");
const APP = join(__dirname, "../../../app");

// Matches EVERY `mobile://` literal in the file, not only ones written
// inline after `deepLink:` (kora#425). The steps link moved into a named
// constant, `Self.stepsDeepLink`, and the old `deepLink:\s*"..."` pattern
// stopped seeing it — so the one widget this test most exists to protect
// silently dropped out of both assertions while they stayed green-ish.
// Binding the string to a name must not hide it from the extractor.
function metricKindDeepLinks(): string[] {
  // Whole-line comments are stripped first: the doc comment explaining
  // kora#425 quotes the OLD "mobile:///progress" value, and a matcher that
  // reads prose would report a route the code no longer uses.
  //
  // Only WHOLE-LINE comments, anchored with ^\s*, because "mobile://"
  // contains "//" itself -- an unanchored //-to-end-of-line strip deletes
  // every deep link in the file and leaves both assertions looking at an
  // empty list.
  const source = readFileSync(join(TARGETS, "MetricKind.swift"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "");
  return [...source.matchAll(/"mobile:\/\/([^"]*)"/g)].map((m) => m[1]);
}

function routeExists(path: string): boolean {
  if (path === "/") {
    return existsSync(join(APP, "(tabs)", "index.tsx"));
  }
  const name = path.replace(/^\//, "");
  return existsSync(join(APP, "(tabs)", `${name}.tsx`)) || existsSync(join(APP, `${name}.tsx`));
}

test("KoraWidget's deep links are exactly the expected set of routes", () => {
  const links = metricKindDeepLinks();
  const distinct = [...new Set(links)];
  // Every metric lands on the dashboard. Steps used to point at "/progress"
  // (Trends), which renders no steps at all — the bug kora#425 fixed. If a
  // metric ever legitimately needs its own screen, update this list
  // deliberately rather than to make a red test go green.
  expect(distinct.sort()).toEqual(["/"]);
});

test("every KoraWidget deep link resolves to a route that exists", () => {
  const links = metricKindDeepLinks();
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(routeExists(link)).toBe(true);
  }
});
