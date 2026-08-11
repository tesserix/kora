import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The widgets deep link by literal string in Swift. Nothing else in the app
// reads those strings, so a route rename would break a home screen tap and no
// other test would notice. This asserts every widgetURL still resolves to a
// real route file.
const TARGETS = join(__dirname, "../../../targets/kora-widgets");
const APP = join(__dirname, "../../../app");

function widgetURLs(file: string): string[] {
  const source = readFileSync(join(TARGETS, file), "utf8");
  return [...source.matchAll(/widgetURL\(URL\(string:\s*"mobile:\/\/([^"]*)"\)\)/g)].map((m) => m[1]);
}

function routeExists(path: string): boolean {
  const name = path.replace(/^\//, "");
  return existsSync(join(APP, "(tabs)", `${name}.tsx`)) || existsSync(join(APP, `${name}.tsx`));
}

test("the nutrition widget links to a route that exists", () => {
  const urls = widgetURLs("NutritionWidget.swift");
  expect(urls).toEqual(["/diary"]);
  expect(routeExists(urls[0])).toBe(true);
});

test("the steps widget links to a route that exists", () => {
  const urls = widgetURLs("StepsWidget.swift");
  expect(urls).toEqual(["/progress"]);
  expect(routeExists(urls[0])).toBe(true);
});
