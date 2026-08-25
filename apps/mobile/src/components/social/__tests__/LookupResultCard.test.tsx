import { render } from "@testing-library/react-native";
import { LookupResultCard } from "../LookupResultCard";
import type { LookupResult } from "@/api/types";

function result(overrides: Partial<LookupResult> = {}): LookupResult {
  return {
    id: "u1",
    display_name: "Ada Lovelace",
    handle: "ada",
    avatar_url: "",
    ...overrides,
  };
}

// kora#449 task 15 finding 6: "Send request" had no accessibilityLabel
// override, so VoiceOver announced only "Send request. Button." — not naming
// who the request was for.
describe("LookupResultCard accessibility", () => {
  it("names the recipient in the Send request button's accessibility label", async () => {
    const { getByLabelText } = await render(
      <LookupResultCard result={result()} onSend={jest.fn()} sending={false} />,
    );
    expect(getByLabelText("Send request to Ada Lovelace")).toBeTruthy();
  });

  // The label must use the same @handle fallback the card's own name text
  // does (kora#443) — a blank display_name must not produce a blank or
  // malformed label either.
  it("falls back to @handle in the label when display_name is blank", async () => {
    const { getByLabelText } = await render(
      <LookupResultCard result={result({ display_name: "" })} onSend={jest.fn()} sending={false} />,
    );
    expect(getByLabelText("Send request to @ada")).toBeTruthy();
  });
});
