import { render } from "@testing-library/react-native";
import { AppBackground } from "../AppBackground";

test("paints the instrument ground with three static pools", async () => {
  const { getByTestId } = await render(<AppBackground />);
  expect(getByTestId("app-background")).toBeTruthy();
  for (const id of ["bg-pool-1", "bg-pool-2", "bg-pool-3"]) {
    expect(getByTestId(id)).toBeTruthy();
  }
});
