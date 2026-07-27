import { render, fireEvent } from "@testing-library/react-native";
import { MealRow } from "../MealRow";
import { LeaderRow } from "../LeaderRow";
import { NotifRow } from "../NotifRow";

describe("display rows", () => {
  it("MealRow shows name, slot, kcal and fires onPress", async () => {
    const onPress = jest.fn();
    const { getByText, getByTestId } = await render(
      <MealRow name="Oats" slot="breakfast" kcal={320} onPress={onPress} />,
    );
    expect(getByText("Oats")).toBeTruthy();
    expect(getByText(/320/)).toBeTruthy();
    fireEvent.press(getByTestId("meal-row"));
    expect(onPress).toHaveBeenCalled();
  });

  it("LeaderRow highlights the current user", async () => {
    const { getByText } = await render(
      <LeaderRow rank={1} name="You" metric="5 days" isYou />,
    );
    expect(getByText("You")).toBeTruthy();
    expect(getByText("5 days")).toBeTruthy();
  });

  it("NotifRow renders text, time and an unread dot", async () => {
    const { getByText, getByTestId } = await render(
      <NotifRow type="friend_request" iconName="user-plus" tint="#34C759" text="Ada added you" time="2h" unread />,
    );
    expect(getByText("Ada added you")).toBeTruthy();
    expect(getByText("2h")).toBeTruthy();
    expect(getByTestId("notif-unread-dot")).toBeTruthy();
  });
});
