import { render } from "@testing-library/react-native";

import Index from "../index";

describe("Index", () => {
  it("renders the Kora heading", async () => {
    const { getByText } = await render(<Index />);
    expect(getByText("Kora")).toBeTruthy();
  });
});
