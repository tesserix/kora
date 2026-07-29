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
});
