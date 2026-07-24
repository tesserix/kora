import { render } from "@testing-library/react-native";

import Index from "../(tabs)/index";

describe("Index", () => {
  it("renders the Home stub", async () => {
    const { findByText } = await render(<Index />);
    expect(await findByText("Home")).toBeTruthy();
  });
});
