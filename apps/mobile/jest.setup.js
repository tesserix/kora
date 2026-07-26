// Screens now call useSafeAreaInsets() (react-native-safe-area-context), which requires a
// SafeAreaProvider ancestor. expo-router mounts one at runtime, but component tests render
// screens in isolation, so we install the library's own official jest mock here.
jest.mock("react-native-safe-area-context", () =>
  require("react-native-safe-area-context/jest/mock").default,
);

// @react-native-async-storage/async-storage: the real native module is unavailable
// under Jest, so we install the package's own official in-memory mock (per its docs).
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

// expo-image-picker (SDK 57): MediaTypeOptions is deprecated in favor of the `mediaTypes`
// array + MediaType string union ("images" | "videos" | "livePhotos"). Both are mocked so
// either call style resolves during tests.
jest.mock("expo-image-picker", () => ({
  launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: null })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: null })),
  requestCameraPermissionsAsync: jest.fn(async () => ({
    granted: true,
    status: "granted",
    canAskAgain: true,
    expires: "never",
  })),
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({
    granted: true,
    status: "granted",
    canAskAgain: true,
    expires: "never",
  })),
  getCameraPermissionsAsync: jest.fn(async () => ({ granted: true, status: "granted" })),
  getMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true, status: "granted" })),
  MediaTypeOptions: { All: "All", Images: "Images", Videos: "Videos" },
  MediaType: { images: "images", videos: "videos", livePhotos: "livePhotos" },
}));

// expo-camera (SDK 57): useCameraPermissions/useMicrophonePermissions return a 3-tuple
// [permissionResponse, requestPermission, getPermission] — not the 2-tuple older SDKs used.
// Both hooks are jest.fn()s (not bare arrows) so per-test overrides — e.g. a denied
// permission — can be applied via `(useCameraPermissions as jest.Mock).mockReturnValue(...)`.
jest.mock("expo-camera", () => ({
  CameraView: "CameraView",
  useCameraPermissions: jest.fn(() => [
    { granted: true, status: "granted", canAskAgain: true, expires: "never" },
    jest.fn(async () => ({ granted: true, status: "granted" })),
    jest.fn(async () => ({ granted: true, status: "granted" })),
  ]),
  useMicrophonePermissions: jest.fn(() => [
    { granted: true, status: "granted", canAskAgain: true, expires: "never" },
    jest.fn(async () => ({ granted: true, status: "granted" })),
    jest.fn(async () => ({ granted: true, status: "granted" })),
  ]),
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true, status: "granted" })),
  getCameraPermissionsAsync: jest.fn(async () => ({ granted: true, status: "granted" })),
}));

// expo-audio (SDK 57 replacement for expo-av): useAudioRecorder returns an AudioRecorder
// instance (record/pause/stop/prepareToRecordAsync + uri/isRecording state), not a bare
// { record, stop, uri } shape. useAudioRecorderState mirrors its status for UI polling.
// useAudioRecorder is a jest.fn() (not a bare arrow) so tests can override the returned
// recorder — e.g. to make .uri populate once .stop() resolves.
jest.mock("expo-audio", () => ({
  useAudioRecorder: jest.fn(() => ({
    prepareToRecordAsync: jest.fn(async () => {}),
    record: jest.fn(),
    pause: jest.fn(),
    stop: jest.fn(async () => {}),
    getStatus: jest.fn(async () => ({ isRecording: false })),
    uri: null,
    isRecording: false,
    currentTime: 0,
    id: "mock-recorder",
  })),
  useAudioRecorderState: () => ({
    isRecording: false,
    durationMillis: 0,
    canRecord: true,
    url: null,
    metering: null,
  }),
  RecordingPresets: {
    HIGH_QUALITY: {},
    LOW_QUALITY: {},
  },
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true, status: "granted" })),
  getRecordingPermissionsAsync: jest.fn(async () => ({ granted: true, status: "granted" })),
}));

// expo-notifications (SDK 57): mock the permission/token/listener surface the
// push registration + responder use. getExpoPushTokenAsync returns { data }.
jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  requestPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: "ExponentPushToken[test]" })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock("expo-device", () => ({ isDevice: true }));

// expo-constants: default export carries expoConfig. Tests mutate
// Constants.expoConfig.extra.eas.projectId to exercise the inert (absent) path.
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: "test-project" } } } },
}));

// react-native-reanimated: the real native/worklets runtime is unavailable under Jest.
// jest-expo does not auto-mock reanimated, and reanimated 4's own shipped mock
// (react-native-reanimated/mock) is NOT usable here: it imports from the package's
// real "./index", which unconditionally calls into react-native-worklets'
// NativeWorklets.native.ts at module load time and throws ("Cannot read properties
// of undefined (reading 'loadUnpackers')") outside a real native runtime. So this is
// a hand-written mock covering only the API surface src/motion actually calls,
// mirroring the semantics of reanimated's own mock (synchronous withSpring/withTiming,
// a NOOP useAnimatedReaction, identity runOnJS) so behavior matches what the shipped
// mock would do if it were loadable.
jest.mock("react-native-reanimated", () => {
  const { View } = require("react-native");
  const ID = (t) => t;
  const NOOP = () => {};
  return {
    __esModule: true,
    default: { View },
    useReducedMotion: jest.fn(() => false),
    useSharedValue: (init) => ({ value: init }),
    useAnimatedStyle: (factory) => factory(),
    useAnimatedReaction: NOOP,
    withSpring: (toValue, _config, callback) => {
      callback?.(true);
      return toValue;
    },
    withTiming: (toValue, _config, callback) => {
      callback?.(true);
      return toValue;
    },
    cancelAnimation: NOOP,
    runOnJS: ID,
    Easing: {
      linear: ID,
      ease: ID,
      cubic: ID,
      out: ID,
      in: ID,
      inOut: ID,
    },
  };
});

// expo-haptics: native haptic feedback is unavailable under Jest.
jest.mock("expo-haptics", () => ({
  selectionAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));
