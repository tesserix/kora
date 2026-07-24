// Screens now call useSafeAreaInsets() (react-native-safe-area-context), which requires a
// SafeAreaProvider ancestor. expo-router mounts one at runtime, but component tests render
// screens in isolation, so we install the library's own official jest mock here.
jest.mock("react-native-safe-area-context", () =>
  require("react-native-safe-area-context/jest/mock").default,
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
