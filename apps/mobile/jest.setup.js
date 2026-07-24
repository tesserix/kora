// Screens now call useSafeAreaInsets() (react-native-safe-area-context), which requires a
// SafeAreaProvider ancestor. expo-router mounts one at runtime, but component tests render
// screens in isolation, so we install the library's own official jest mock here.
jest.mock("react-native-safe-area-context", () =>
  require("react-native-safe-area-context/jest/mock").default,
);
