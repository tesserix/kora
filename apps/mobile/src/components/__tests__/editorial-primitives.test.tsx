import { render } from "@testing-library/react-native";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Avatar } from "@/components/Avatar";
import { Stat } from "@/components/Stat";
import { Badge } from "@/components/Badge";

test("ScreenHeader shows overline and title", async () => {
  const { findByText } = await render(<ScreenHeader overline="This week" title="Diary" />);
  expect(await findByText("This week")).toBeTruthy();
  expect(await findByText("Diary")).toBeTruthy();
});

test("Avatar shows initials", async () => {
  const { findByText } = await render(<Avatar initials="AS" />);
  expect(await findByText("AS")).toBeTruthy();
});

test("Stat shows label, value and unit", async () => {
  const { findByText } = await render(<Stat label="Total intake" value="1,252" unit="kcal" />);
  expect(await findByText("Total intake")).toBeTruthy();
  expect(await findByText("1,252")).toBeTruthy();
  expect(await findByText("kcal")).toBeTruthy();
});

test("Badge renders its children", async () => {
  const { findByText } = await render(<Badge variant="success">AI logged</Badge>);
  expect(await findByText("AI logged")).toBeTruthy();
});
