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

function metricKindDeepLinks(): string[] {
  const source = readFileSync(join(TARGETS, "MetricKind.swift"), "utf8");
  return [...source.matchAll(/deepLink:\s*"mobile:\/\/([^"]*)"/g)].map((m) => m[1]);
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
  expect(distinct.sort()).toEqual(["/", "/progress"]);
});

test("every KoraWidget deep link resolves to a route that exists", () => {
  const links = metricKindDeepLinks();
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(routeExists(link)).toBe(true);
  }
});
