import { audienceFor, categoryLabel, CATEGORY_ORDER } from "../shareAudit";

import type { Circle } from "@/api/types";

const circle = (over: Partial<Circle> & { id: string }): Circle => ({
  name: "Circle " + over.id,
  members: [],
  categories: [],
  ...over,
});

test("nobody can see a category no circle grants", () => {
  const circles = [circle({ id: "c1", members: [{ id: "u1", display_name: "Ada" }], categories: ["progress"] })];
  expect(audienceFor(circles, "body")).toEqual([]);
});

test("the audience is the members of circles granting that category", () => {
  const circles = [
    circle({ id: "c1", members: [{ id: "u1", display_name: "Ada" }], categories: ["progress", "body"] }),
    circle({ id: "c2", members: [{ id: "u2", display_name: "Ben" }], categories: ["progress"] }),
  ];
  expect(audienceFor(circles, "progress").map((m) => m.display_name)).toEqual(["Ada", "Ben"]);
  expect(audienceFor(circles, "body").map((m) => m.display_name)).toEqual(["Ada"]);
});

// The whole point of the audit view is answering "who can see this" with a
// number a person can trust. Someone in two circles that both grant `body` is
// one person, not two — a count that double-counts is worse than no count.
test("a member of two granting circles is counted once", () => {
  const ada = { id: "u1", display_name: "Ada" };
  const circles = [
    circle({ id: "c1", members: [ada], categories: ["body"] }),
    circle({ id: "c2", members: [ada, { id: "u2", display_name: "Ben" }], categories: ["body"] }),
  ];
  const got = audienceFor(circles, "body");
  expect(got.map((m) => m.id)).toEqual(["u1", "u2"]);
});

// Deduplication must key on id, not on display name. Two different people may
// share a name, and collapsing them would under-report the audience — the
// failure direction that matters, because it tells someone fewer people can
// see their body metrics than actually can.
test("two different people with the same name are both counted", () => {
  const circles = [
    circle({
      id: "c1",
      members: [
        { id: "u1", display_name: "Alex" },
        { id: "u2", display_name: "Alex" },
      ],
      categories: ["body"],
    }),
  ];
  expect(audienceFor(circles, "body")).toHaveLength(2);
});

// The names deliberately straddle the case boundary: a case-SENSITIVE sort
// puts every capitalised name before every lowercase one, so it would order
// these ["Ben", "Zoe", "ada"]. An earlier fixture used Ada/ben/zoe, which
// sorts identically under both rules and so could not tell them apart.
test("names are sorted case-insensitively, so the list is stable between renders", () => {
  const circles = [
    circle({
      id: "c1",
      members: [
        { id: "u3", display_name: "Zoe" },
        { id: "u1", display_name: "ada" },
        { id: "u2", display_name: "Ben" },
      ],
      categories: ["body"],
    }),
  ];
  expect(audienceFor(circles, "body").map((m) => m.display_name)).toEqual(["ada", "Ben", "Zoe"]);
});

test("an empty circle grants nothing to anyone", () => {
  const circles = [circle({ id: "c1", members: [], categories: ["progress", "body"] })];
  expect(audienceFor(circles, "progress")).toEqual([]);
});

test("categories render with human labels in a fixed order, body last", () => {
  expect(CATEGORY_ORDER).toEqual(["progress", "body"]);
  expect(categoryLabel("progress")).toBe("Progress");
  expect(categoryLabel("body")).toBe("Body metrics");
});
