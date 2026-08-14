import { render } from "@testing-library/react-native";

import { ReportingUserBinder } from "../ReportingUserBinder";

const mockSetReportingUser = jest.fn();
jest.mock("@/observability/reporter", () => ({
  setReportingUser: (...a: unknown[]) => mockSetReportingUser(...a),
}));

let mockProfile: { data?: { id: string } } = {};
jest.mock("@/api/hooks", () => ({ useProfile: () => mockProfile }));

beforeEach(() => {
  mockSetReportingUser.mockClear();
  mockProfile = {};
});

test("sets the Kora uuid once the profile loads", async () => {
  mockProfile = { data: { id: "f5c11f49-fca2-4804-9809-03ac631b1fc7" } };
  await render(<ReportingUserBinder />);
  expect(mockSetReportingUser).toHaveBeenCalledWith("f5c11f49-fca2-4804-9809-03ac631b1fc7");
});

test("clears the user when there is no profile", async () => {
  await render(<ReportingUserBinder />);
  expect(mockSetReportingUser).toHaveBeenCalledWith(null);
});
