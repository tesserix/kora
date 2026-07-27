import { render } from "@testing-library/react-native";
import { StreakBars } from "../StreakBars";

describe("StreakBars", () => {
  it("fills min(count, window) bars", async () => {
    const { getAllByTestId } = await render(<StreakBars count={3} window={7} />);
    expect(getAllByTestId("streak-bar-filled")).toHaveLength(3);
  });
  it("caps fill at the window", async () => {
    const { getAllByTestId } = await render(<StreakBars count={12} window={7} />);
    expect(getAllByTestId("streak-bar-filled")).toHaveLength(7);
  });
});
