import { render } from "@testing-library/react-native";

import ConfigMissing from "../config-missing";

// kora#174: this screen used to say "reload the app" with no way to, and no
// indication of WHICH variable was missing. The list is the part
// with logic in it, and the part that could leak a secret if it were built
// carelessly — so both properties are pinned here.

const NAMES = [
  "EXPO_PUBLIC_ZITADEL_PROJECT_ID",
  "EXPO_PUBLIC_ZITADEL_CLIENT_ID_IOS",
  "EXPO_PUBLIC_ZITADEL_CLIENT_ID_ANDROID",
];

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of NAMES) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of NAMES) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("names only the variables that are actually absent", async () => {
  // jest runs as iOS, so only the iOS client id is this platform's.
  process.env.EXPO_PUBLIC_ZITADEL_CLIENT_ID_IOS = "123";

  const { queryByText } = await render(<ConfigMissing />);

  expect(queryByText("EXPO_PUBLIC_ZITADEL_PROJECT_ID")).toBeTruthy();
  // A generic "set all of them" instruction is what made the old copy useless,
  // and the other platform's client id is not needed to sign in here.
  expect(queryByText("EXPO_PUBLIC_ZITADEL_CLIENT_ID_IOS")).toBeNull();
  expect(queryByText("EXPO_PUBLIC_ZITADEL_CLIENT_ID_ANDROID")).toBeNull();
});

test("never renders a variable's value, only its name", async () => {
  // The diagnostic value is entirely in the names.
  process.env.EXPO_PUBLIC_ZITADEL_PROJECT_ID = "leak-canary-project";
  process.env.EXPO_PUBLIC_ZITADEL_CLIENT_ID_ANDROID = "leak-canary-client";

  const { toJSON } = await render(<ConfigMissing />);

  expect(JSON.stringify(toJSON())).not.toMatch(/leak-canary/);
});

test("tells the developer how to reload rather than asking them to", async () => {
  const { getByText, queryByLabelText } = await render(<ConfigMissing />);

  expect(getByText(/npx expo start --clear/)).toBeTruthy();
  expect(getByText(/shake the device/i)).toBeTruthy();
  // Deliberately no back affordance: _layout.tsx replaces into this route at
  // startup, so there is nothing behind it. See the comment in the screen.
  expect(queryByLabelText("Go back")).toBeNull();
});
