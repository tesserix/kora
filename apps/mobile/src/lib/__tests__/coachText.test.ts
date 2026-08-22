import { parseCoachText } from "../coachText";

describe("parseCoachText", () => {
  it("renders bold runs as spans instead of literal asterisks", () => {
    expect(parseCoachText("your daily target is **140g** of protein")).toEqual([
      {
        kind: "paragraph",
        spans: [
          { text: "your daily target is " },
          { text: "140g", bold: true },
          { text: " of protein" },
        ],
      },
    ]);
  });

  it("treats underscore emphasis the same way", () => {
    expect(parseCoachText("__hit__ your _goal_")).toEqual([
      {
        kind: "paragraph",
        spans: [
          { text: "hit", bold: true },
          { text: " your " },
          { text: "goal", italic: true },
        ],
      },
    ]);
  });

  it("keeps a lone asterisk as text", () => {
    expect(parseCoachText("2 * 70g")).toEqual([{ kind: "paragraph", spans: [{ text: "2 * 70g" }] }]);
  });

  it("splits paragraphs on blank lines and joins soft-wrapped lines", () => {
    expect(parseCoachText("one\ntwo\n\nthree")).toEqual([
      { kind: "paragraph", spans: [{ text: "one two" }] },
      { kind: "paragraph", spans: [{ text: "three" }] },
    ]);
  });

  it("reads dash, asterisk and bullet lines as bullets", () => {
    expect(parseCoachText("- eggs\n* toast\n• milk")).toEqual([
      { kind: "bullet", marker: "•", spans: [{ text: "eggs" }] },
      { kind: "bullet", marker: "•", spans: [{ text: "toast" }] },
      { kind: "bullet", marker: "•", spans: [{ text: "milk" }] },
    ]);
  });

  it("keeps the number on an ordered list", () => {
    expect(parseCoachText("1. eggs\n2. toast")).toEqual([
      { kind: "bullet", marker: "1.", spans: [{ text: "eggs" }] },
      { kind: "bullet", marker: "2.", spans: [{ text: "toast" }] },
    ]);
  });

  it("turns a markdown heading into a heading block without the hashes", () => {
    expect(parseCoachText("## Day 1\nEggs")).toEqual([
      { kind: "heading", spans: [{ text: "Day 1" }] },
      { kind: "paragraph", spans: [{ text: "Eggs" }] },
    ]);
  });

  it("drops table pipes rather than printing them", () => {
    expect(parseCoachText("| Meal | kcal |\n| --- | --- |\n| Eggs | 200 |")).toEqual([
      { kind: "paragraph", spans: [{ text: "Meal · kcal" }] },
      { kind: "paragraph", spans: [{ text: "Eggs · 200" }] },
    ]);
  });

  it("unwraps inline code", () => {
    expect(parseCoachText("eat `140g` today")).toEqual([
      { kind: "paragraph", spans: [{ text: "eat 140g today" }] },
    ]);
  });

  it("returns nothing for empty or whitespace-only text", () => {
    expect(parseCoachText("   \n\n ")).toEqual([]);
  });

  it("normalises carriage returns", () => {
    expect(parseCoachText("one\r\n\r\ntwo")).toEqual([
      { kind: "paragraph", spans: [{ text: "one" }] },
      { kind: "paragraph", spans: [{ text: "two" }] },
    ]);
  });
});
