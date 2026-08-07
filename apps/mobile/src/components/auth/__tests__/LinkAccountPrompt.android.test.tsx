import { render } from "@testing-library/react-native";
import { Platform } from "react-native";
import { LinkAccountPrompt } from "@/components/auth/LinkAccountPrompt";

// Apple's native sheet does not exist on Android. Enumeration protection makes
// existingSignInMethods() return [], which is the fail-open state that
// routinely hit this bug: without a platform guard, "Continue with Apple to
// link" was offered on Android too, and tapping it called an API that isn't
// there.
//
// jest.mock("react-native/Libraries/Utilities/Platform", () => ({ OS:
// "android", select: ... })) — the form suggested in the review — replaces
// the WHOLE Platform module. In this project's jest-expo setup that breaks
// module resolution before any test runs at all: expo-modules-core's own
// Platform.ts (required lazily off a `global.fetch` getter installed by
// jest-expo's setupFiles) also imports react-native's Platform and expects
// more than {OS, select} on it, so the swap crashes the whole suite with
// "Cannot read properties of undefined (reading 'select')" — reproduced by
// isolating the mock in an otherwise-empty test file. Patching just the two
// properties the component reads, on the real (singleton) Platform module
// object, achieves the identical test intent — Platform.OS === "android" and
// Platform.select behaving like Android — without replacing the module.
const originalOS = Platform.OS;
const originalSelect = Platform.select;

beforeAll(() => {
  Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
  Platform.select = ((specifics: Record<string, unknown>) => specifics.android) as typeof Platform.select;
});

afterAll(() => {
  Object.defineProperty(Platform, "OS", { value: originalOS, configurable: true });
  Platform.select = originalSelect;
});

const mockExistingSignInMethods = jest.fn();
jest.mock("@/auth/link", () => ({
  existingSignInMethods: (...a: unknown[]) => mockExistingSignInMethods(...a),
  completeLinkWithPassword: jest.fn(async (..._a: unknown[]) => {}),
  completeLinkWithGoogle: jest.fn(async (..._a: unknown[]) => {}),
  completeLinkWithApple: jest.fn(async (..._a: unknown[]) => {}),
}));
jest.mock("@/lib/socialAuth", () => ({
  configureGoogleSignin: jest.fn(),
  signInWithGoogleNative: jest.fn(async () => "g-token"),
  signInWithAppleNative: jest.fn(async () => ({ idToken: "a", rawNonce: "n", fullName: null })),
}));
// LinkAccountPrompt now imports @/api/hooks for storeAppleAuthorization; the
// real module pulls in firebase/auth (ESM), which this project's Jest config
// cannot parse outside a mock (see LinkAccountPrompt.test.tsx for the same
// requirement).
jest.mock("@/api/hooks", () => ({
  storeAppleAuthorization: jest.fn(async (..._a: unknown[]) => ({})),
}));

const pending = { provider: "google.com" } as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockExistingSignInMethods.mockResolvedValue([]);
});

describe("LinkAccountPrompt on Android", () => {
  it("never offers Apple, but still fails open with another control", async () => {
    const { queryByLabelText, findByLabelText } = await render(
      <LinkAccountPrompt
        visible
        email="sam@example.com"
        provider="google.com"
        pendingCredential={pending}
        onCancel={jest.fn()}
        onLinked={jest.fn()}
      />,
    );

    expect(await findByLabelText("Sign in and link")).toBeTruthy();
    expect(queryByLabelText("Continue with Apple to link")).toBeNull();
  });
});
