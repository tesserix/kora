import { render } from "@testing-library/react-native";
import { MacroBars } from "../MacroBars";

test("renders a Fibre bar with consumed/goal and its fill", async () => {
  const { getByText, getByTestId } = await render(
    <MacroBars macros={{ p: 40, c: 100, f: 20, pGoal: 160, cGoal: 356, fGoal: 76, fib: 18, fibGoal: 38 }} />,
  );
  getByText("Fibre");
  getByText("18g / 38g");
  getByTestId("macro-fill-fibre");
});
