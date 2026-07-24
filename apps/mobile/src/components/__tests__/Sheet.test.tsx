import { render } from "@testing-library/react-native";
import { AppText } from "../Text";
import { Sheet } from "../Sheet";

test("shows content when visible", async () => {
  const { findByText } = await render(
    <Sheet visible onClose={() => {}}>
      <AppText>Sheet body</AppText>
    </Sheet>
  );
  expect(await findByText("Sheet body")).toBeTruthy();
});

test("hides content when not visible", async () => {
  const { queryByText } = await render(
    <Sheet visible={false} onClose={() => {}}>
      <AppText>Sheet body</AppText>
    </Sheet>
  );
  expect(queryByText("Sheet body")).toBeNull();
});
