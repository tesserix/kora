import { render } from "@testing-library/react-native";
import { Waveform } from "../Waveform";

test("renders the 9 bars from the mockup", async () => {
  const { getAllByTestId } = await render(<Waveform active />);
  expect(getAllByTestId("waveform-bar")).toHaveLength(9);
});

test("renders bars without throwing when inactive", async () => {
  const { getAllByTestId } = await render(<Waveform active={false} />);
  expect(getAllByTestId("waveform-bar")).toHaveLength(9);
});
