import { render, fireEvent } from "@testing-library/react-native";

import { SocialAudit } from "../SocialAudit";

import type { Circle } from "@/api/types";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));

const circle = (over: Partial<Circle> & { id: string }): Circle => ({
  name: "Circle " + over.id,
  members: [],
  categories: [],
  ...over,
});

const ada = { id: "u1", display_name: "Ada" };

beforeEach(() => mockPush.mockClear());

// The house rule, and the fix for two of kora#443's defects at once: a hero
// mono numeral that can legitimately be zero never renders "0". Rendering it
// was both redundant against the word beneath it AND ambiguous, because
// Menlo's slashed zero reads as "Ø" at 28px.
test("a category with no audience renders a sentence and NO numeral", async () => {
  const { getByTestId, queryByTestId } = await render(
    <SocialAudit circles={[]} failed={false} />,
  );
  expect(getByTestId("audit-empty-body")).toHaveTextContent("Nobody can see your body metrics");
  expect(queryByTestId("audit-count-body")).toBeNull();
  expect(queryByTestId("audit-names-body")).toBeNull();
});

// Per category INDEPENDENTLY: one row collapsing to a sentence must not
// collapse the other.
test("a populated category keeps its numeral while an empty one collapses", async () => {
  const circles = [circle({ id: "c1", members: [ada], categories: ["progress"] })];
  const { getByTestId, queryByTestId } = await render(
    <SocialAudit circles={circles} failed={false} />,
  );
  expect(getByTestId("audit-count-progress")).toHaveTextContent("1");
  expect(getByTestId("audit-names-progress")).toHaveTextContent(/Ada/);
  expect(queryByTestId("audit-count-body")).toBeNull();
  expect(getByTestId("audit-empty-body")).toBeTruthy();
});

test("the hint names the next step when nothing is shared and no circle exists", async () => {
  const { getByTestId } = await render(<SocialAudit circles={[]} failed={false} />);
  expect(getByTestId("audit-hint")).toHaveTextContent(/build one from a friend/i);
});

// A circle that exists but grants nothing to nobody is a different blocker
// from having no circle at all, and the hint has to say so.
test("the hint changes once a circle exists but has no audience", async () => {
  const circles = [circle({ id: "c1", members: [], categories: ["body"] })];
  const { getByTestId } = await render(<SocialAudit circles={circles} failed={false} />);
  expect(getByTestId("audit-hint")).toHaveTextContent(/Turn a friend into a circle/i);
});

test("no hint once something is actually shared", async () => {
  const circles = [circle({ id: "c1", members: [ada], categories: ["body"] })];
  const { queryByTestId } = await render(<SocialAudit circles={circles} failed={false} />);
  expect(queryByTestId("audit-hint")).toBeNull();
});

// #174. This is the assertion that matters most on this component: an outage
// must never be rendered as a reassuring claim about the user's privacy.
test("a failed load replaces the audit instead of claiming nobody can see anything", async () => {
  const { queryByTestId, getByText } = await render(
    <SocialAudit circles={[]} failed onRetry={jest.fn()} />,
  );
  expect(queryByTestId("social-audit")).toBeNull();
  expect(queryByTestId("audit-empty-body")).toBeNull();
  expect(queryByTestId("audit-empty-progress")).toBeNull();
  expect(getByText(/couldn't load/i)).toBeTruthy();
});

test("the whole cluster is one press target and opens circles", async () => {
  const { getByLabelText } = await render(<SocialAudit circles={[]} failed={false} />);
  await fireEvent.press(getByLabelText("Who can see your data"));
  expect(mockPush).toHaveBeenCalledWith("/circles");
});

// Screen readers get one utterance per row, not three separate stops for
// numeral / label / names.
test("each row is a single accessible node with a composed label", async () => {
  const circles = [circle({ id: "c1", members: [ada], categories: ["body"] })];
  const { getByLabelText } = await render(<SocialAudit circles={circles} failed={false} />);
  expect(getByLabelText("1, can see body metrics: Ada")).toBeTruthy();
  expect(getByLabelText("Nobody can see your progress")).toBeTruthy();
});
