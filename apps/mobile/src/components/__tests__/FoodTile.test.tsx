import { render } from "@testing-library/react-native";
import { FoodTile } from "@/components/FoodTile";

test("renders without throwing at a given hue/icon", async () => {
  const { toJSON } = await render(<FoodTile hue={150} icon="leaf" size={56} />);
  expect(toJSON()).toBeTruthy();
});
