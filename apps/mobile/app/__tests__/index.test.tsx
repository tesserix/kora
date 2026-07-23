import { render } from "@testing-library/react-native";

import Index from "../index";

jest.mock("@/lib/firebase", () => ({ auth: {} }));
jest.mock("firebase/auth", () => ({
  onAuthStateChanged: jest.fn(() => jest.fn()),
  signOut: jest.fn(),
}));
jest.mock("expo-router", () => ({ router: { replace: jest.fn() } }));

describe("Index", () => {
  it("renders the Kora heading", async () => {
    const { getByText } = await render(<Index />);
    expect(getByText("Kora")).toBeTruthy();
  });
});
