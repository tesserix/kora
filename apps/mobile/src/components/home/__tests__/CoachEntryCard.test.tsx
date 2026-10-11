import { StyleSheet } from "react-native";
import { render, fireEvent } from "@testing-library/react-native";
import type { CoachNudge } from "@/api/types";
import { CoachEntryCard } from "../CoachEntryCard";

const NUDGE: CoachNudge = {
  kind: "protein",
  title: "Protein is trailing",
  text: "You are about 40g behind your target so far this week.",
} as CoachNudge;

// kora#313. The defect was not that the label was unclear — it was that the
// identifying word MOVED. "Otto · today's focus" with a nudge, "Otto · coach"
// without, so "coach" was present only in the empty state and vanished the
// moment the row had something to show. These pin the name as constant, which
// is the actual invariant; the exact wording is free to change around it.
describe("CoachEntryCard", () => {
  it("names itself the same way whether or not there is a nudge", async () => {
    const withNudge = await render(<CoachEntryCard nudge={NUDGE} onPress={jest.fn()} />);
    const nameWithNudge = withNudge.getByText(/coach/i).props.children;

    const withoutNudge = await render(<CoachEntryCard nudge={undefined} onPress={jest.fn()} />);
    const nameWithout = withoutNudge.getByText(/coach/i).props.children;

    expect(nameWithNudge).toBe(nameWithout);
  });

  it("says 'coach' in the state that has a nudge — the regression", async () => {
    const { getByText } = await render(<CoachEntryCard nudge={NUDGE} onPress={jest.fn()} />);
    expect(getByText(/coach/i)).toBeTruthy();
  });

  it("renders the name as an engraved label, not body text", async () => {
    const { getByText } = await render(<CoachEntryCard nudge={NUDGE} onPress={jest.fn()} />);
    // Uppercasing is what makes it read as a section header beside Home's
    // ENERGY RESERVE / MACROS. Asserted through the style rather than the
    // string so the source copy stays sentence-case and readable.
    expect(StyleSheet.flatten(getByText(/coach/i).props.style)).toEqual(
      expect.objectContaining({ textTransform: "uppercase" }),
    );
  });

  it("gives the nudge two lines so a title:text pair is not cut mid-claim", async () => {
    const { getByText } = await render(<CoachEntryCard nudge={NUDGE} onPress={jest.fn()} />);
    expect(getByText(new RegExp(NUDGE.title)).props.numberOfLines).toBe(2);
  });

  it("keeps announcing the destination to screen readers", async () => {
    const { getByLabelText } = await render(<CoachEntryCard nudge={NUDGE} onPress={jest.fn()} />);
    // This was always correct — VoiceOver users never had the sighted bug.
    expect(getByLabelText(/^Open coach\./)).toBeTruthy();
  });

  it("opens the coach when pressed", async () => {
    const onPress = jest.fn();
    const { getByLabelText } = await render(<CoachEntryCard nudge={NUDGE} onPress={onPress} />);
    await fireEvent.press(getByLabelText(/^Open coach\./));
    expect(onPress).toHaveBeenCalled();
  });
});
