import { render, fireEvent } from "@testing-library/react-native";
import { LookupResultCard } from "../LookupResultCard";
import type { LookupResult } from "@/api/types";

// "Respond" (request_received) navigates to the dedicated requests screen
// rather than calling onSend -- see LookupResultCard.tsx's comment on why
// LookupView carries no friend-request id to accept directly. Same mock
// shape as app/__tests__/social.test.tsx's.
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));

function result(overrides: Partial<LookupResult> = {}): LookupResult {
  return {
    id: "u1",
    display_name: "Ada Lovelace",
    handle: "ada",
    avatar_url: "",
    friendship_status: "none",
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

// kora#453: the card must offer a live "Send request" for exactly one of the
// five wire values ("none") and something else -- never a send button -- for
// the other four. Each case below also checks the accessibility label still
// names the recipient, per the issue's "must not regress" requirement.
describe("LookupResultCard friendship_status", () => {
  it('renders a live "Send request" button for "none"', async () => {
    const onSend = jest.fn();
    const { getByLabelText, queryByText } = await render(
      <LookupResultCard result={result({ friendship_status: "none" })} onSend={onSend} sending={false} />,
    );
    const button = getByLabelText("Send request to Ada Lovelace");
    expect(button).toBeTruthy();
    expect(queryByText("Requested")).toBeNull();
    expect(queryByText("Already friends")).toBeNull();
  });

  it('renders "Requested" as non-actionable text for "request_sent"', async () => {
    const onSend = jest.fn();
    const { getByText, getByLabelText, queryByText } = await render(
      <LookupResultCard result={result({ friendship_status: "request_sent" })} onSend={onSend} sending={false} />,
    );
    expect(getByText("Requested")).toBeTruthy();
    expect(getByLabelText("Friend request already sent to Ada Lovelace")).toBeTruthy();
    expect(queryByText("Send request")).toBeNull();
  });

  it('renders "Already friends" as non-actionable text for "friends"', async () => {
    const onSend = jest.fn();
    const { getByText, getByLabelText, queryByText } = await render(
      <LookupResultCard result={result({ friendship_status: "friends" })} onSend={onSend} sending={false} />,
    );
    expect(getByText("Already friends")).toBeTruthy();
    expect(getByLabelText("You and Ada Lovelace are already friends")).toBeTruthy();
    expect(queryByText("Send request")).toBeNull();
  });

  it('renders "This is you" for "self"', async () => {
    const onSend = jest.fn();
    const { getByText, getByLabelText, queryByText } = await render(
      <LookupResultCard result={result({ friendship_status: "self" })} onSend={onSend} sending={false} />,
    );
    expect(getByText("This is you")).toBeTruthy();
    expect(getByLabelText("This is you")).toBeTruthy();
    expect(queryByText("Send request")).toBeNull();
  });

  it('renders a "Respond" button (not a send) for "request_received", routing to the requests screen', async () => {
    mockPush.mockClear();
    const onSend = jest.fn();
    const { getByLabelText, queryByText } = await render(
      <LookupResultCard result={result({ friendship_status: "request_received" })} onSend={onSend} sending={false} />,
    );
    const respond = getByLabelText("Respond to friend request from Ada Lovelace");
    expect(respond).toBeTruthy();
    expect(queryByText("Send request")).toBeNull();

    fireEvent.press(respond);
    expect(mockPush).toHaveBeenCalledWith("/friends");
    expect(onSend).not.toHaveBeenCalled();
  });
});
