import { render, screen, fireEvent } from "@testing-library/react-native";
import { EmptyState } from "../EmptyState";

describe("EmptyState", () => {
  it("renders title, subtitle, and no CTA by default", async () => {
    await render(
      <EmptyState icon="camera" title="No meals yet" subtitle="Tap ✦ to log your first meal." />,
    );
    expect(screen.getByText("No meals yet")).toBeTruthy();
    expect(screen.getByText("Tap ✦ to log your first meal.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a CTA and fires onPress", async () => {
    const onPress = jest.fn();
    await render(
      <EmptyState
        icon="scale"
        title="No weigh-ins"
        subtitle="Log your weight to see trends."
        cta={{ label: "Log weight", onPress }}
      />,
    );
    fireEvent.press(screen.getByRole("button", { name: "Log weight" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  // Today's empty state sits directly above the dock's camera button, so it
  // opts out of the icon tile rather than showing a second camera glyph.
  it("omits the icon tile when no icon is given", async () => {
    await render(<EmptyState title="No meals logged yet" subtitle="Point the camera at your first meal." />);
    expect(screen.queryByTestId("empty-state-icon")).toBeNull();
    expect(screen.getByText("No meals logged yet")).toBeTruthy();
  });

  it("renders the icon tile when an icon is given", async () => {
    await render(<EmptyState icon="camera" title="No meals yet" subtitle="Tap to log." />);
    expect(screen.getByTestId("empty-state-icon")).toBeTruthy();
  });
});
