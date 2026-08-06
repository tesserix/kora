// react-native-gesture-handler: GestureDetector/Gesture.Pan() need the library's own
// jest setup (mocks the native gesture-handler view registry) or they crash under Jest.
require("react-native-gesture-handler/jestSetup");

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
  const React = require("react");
  const { View } = require("react-native");
  const ID = (t) => t;
  const NOOP = () => {};
  return {
    __esModule: true,
    // react-native-gesture-handler's GestureDetector calls
    // `Reanimated.default.createAnimatedComponent(Wrap)` at module-load time (see its
    // reanimatedWrapper.ts) purely to opt the wrapper view into the animated tree;
    // under Jest that wrapper is never actually driven, so it's otherwise a no-op —
    // except for the `animatedProps` prop (from `useAnimatedProps`, e.g.
    // CircularProgress's arc), which real reanimated applies imperatively to the
    // underlying host component. This mock reproduces that by spreading
    // `animatedProps` onto the wrapped component's own props (after `...rest`, so
    // animated values win), so consumers reading e.g. `strokeDashoffset` off the
    // rendered element under test see the real evaluated number.
    default: {
      View,
      createAnimatedComponent: (Component) =>
        React.forwardRef(({ animatedProps, ...rest }, ref) =>
          React.createElement(Component, { ...rest, ...(animatedProps || {}), ref }),
        ),
    },
    useReducedMotion: jest.fn(() => false),
    // Backed by a ref (not a plain object literal) so the same mutable
    // instance survives re-renders, matching real reanimated's semantics
    // where sv.value tracks the live animating position across renders.
    useSharedValue: (init) => {
      const ref = React.useRef();
      if (!ref.current) ref.current = { value: init };
      return ref.current;
    },
    useAnimatedStyle: (factory) => factory(),
    // Eagerly evaluates the worklet updater to a plain props object, mirroring
    // useAnimatedStyle above. Paired with the createAnimatedComponent change so the
    // resulting values land as real props (numbers) on the rendered host element.
    useAnimatedProps: (factory) => factory(),
    useAnimatedReaction: NOOP,
    // react-native-gesture-handler's GestureDetector calls Reanimated.useEvent(...) to wire
    // its native event handler; under Jest no native gesture events are ever dispatched
    // through it, so a stable no-op handler is a faithful stand-in.
    useEvent: () => NOOP,
    // Faithful linear interpolation (clamped to the output range) so scrim-opacity-style
    // usages (Sheet v2) resolve to real values under test instead of a stubbed constant.
    interpolate: (value, inputRange, outputRange) => {
      const [inLo, inHi] = inputRange;
      const [outLo, outHi] = outputRange;
      if (inHi === inLo) return outLo;
      const t = (value - inLo) / (inHi - inLo);
      const clamped = Math.min(1, Math.max(0, t));
      return outLo + clamped * (outHi - outLo);
    },
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
    // Layout-animation entering builders (FadeInDown, etc.): under Jest there's no
    // native layout-animation runtime to drive them, so `entering` never actually
    // animates anything — it's just a prop that must not throw when constructed via
    // its real chainable API (`FadeInDown.duration(300).delay(30)`). This stub
    // mirrors that chaining surface, returning itself so any call order resolves.
    FadeInDown: (() => {
      const builder = {
        duration: () => builder,
        delay: () => builder,
        springify: () => builder,
      };
      return builder;
    })(),
    FadeOutDown: (() => {
      const builder = {
        duration: () => builder,
        delay: () => builder,
        springify: () => builder,
      };
      return builder;
    })(),
  };
});

// react-native-gesture-handler/ReanimatedSwipeable: the real component drives its own
// Gesture.Pan()/GestureDetector worklet plumbing (useDerivedValue, runOnUI, measure, etc.)
// that the hand-written reanimated mock above doesn't implement, so it crashes under Jest.
// Component tests only need to render `children` and make the right-action content
// pressable — not simulate an actual swipe — so this mock renders both directly, letting
// tests fireEvent.press() straight on whatever `renderRightActions()` returns.
jest.mock("react-native-gesture-handler/ReanimatedSwipeable", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    __esModule: true,
    default: ({ children, renderRightActions }) =>
      React.createElement(
        View,
        null,
        children,
        renderRightActions ? renderRightActions({ value: 0 }, { value: 0 }, {}) : null,
      ),
  };
});

// expo-symbols: native SF Symbols rendering is unavailable under Jest. The mock
// surfaces the resolved symbol name as a testID (`sf-<name>`) so Icon tests can
// assert on the SF-Symbol-first render path without a real iOS runtime.
jest.mock("expo-symbols", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { SymbolView: (props) => React.createElement(View, { testID: `sf-${props.name}` }) };
});

// expo-haptics: native haptic feedback is unavailable under Jest.
jest.mock("expo-haptics", () => ({
  selectionAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));

// @kingstinct/react-native-healthkit (v14, Nitro-modules based): native HealthKit is
// unavailable under Jest and on the simulator. Export names/signatures below are taken
// from the installed package's lib/typescript/healthkit.d.ts, not guessed — notably
// isHealthDataAvailable is SYNCHRONOUS (a direct Nitro binding returning boolean), unlike
// its isHealthDataAvailableAsync twin. Default mock reports "unavailable" so degraded-state
// tests pass; individual tests override per-case (authorized/denied) via jest.mock.
jest.mock("@kingstinct/react-native-healthkit", () => ({
  isHealthDataAvailable: jest.fn(() => false),
  isHealthDataAvailableAsync: jest.fn(async () => false),
  requestAuthorization: jest.fn(async () => false),
  queryQuantitySamples: jest.fn(async () => []),
  queryCategorySamples: jest.fn(async () => []),
  // Read by useActivityHistory for onboarding's activity inference. Signature
  // taken from the installed package's lib/typescript/healthkit.d.ts:
  // queryWorkoutSamples(options: WorkoutQueryOptions) => Promise<readonly WorkoutProxyTyped[]>
  queryWorkoutSamples: jest.fn(async () => []),
}));

// FormData: make the global the SAME implementation the app has at runtime.
//
// This matters more than it looks, and #82 is the proof. Jest's default global
// FormData is the WHATWG/undici one, which per spec coerces any non-Blob value with
// String(value) — so a broken file part silently encodes as the text
// "[object Object]" and NOTHING ever throws. On a device the global is React Native's
// FormData (getParts()/_parts, no entries()), which Expo's winter runtime then
// patches to add the iteration methods its fetch converter reads. Only on THAT
// implementation does an unsupported part surface as
// "Unsupported FormDataPart implementation".
//
// Testing multipart against the WHATWG global therefore verifies nothing about this
// app: the broken and fixed forms both "pass". Installing the real pair here is what
// makes src/api/__tests__/resolve-upload-multipart.test.tsx a binding test rather
// than a decorative one. The patch adds methods, so it is a superset of what the
// WHATWG global offered — existing suites keep working.
// requireActual is REQUIRED here, not stylistic: jest-expo automocks modules under
// expo/, which turns installFormDataPatch into a stub that returns undefined and
// silently leaves the global unpatched. Expo's own converter test does the same thing
// for the same reason.
const { installFormDataPatch } = jest.requireActual("expo/src/winter/FormData");
global.FormData = installFormDataPatch(
  jest.requireActual("react-native/Libraries/Network/FormData").default,
);

// expo-file-system (SDK 57): `new File(uri)` is a native SharedObject whose bytes()/
// name/type read the real filesystem, none of which exists under Jest. This stand-in
// keeps the three members Expo's FormData converter actually consumes
// (expo/src/winter/fetch/convertFormData.ts): it dispatches on `'bytes' in entry`,
// then reads `name` for the filename and `type` for the part's content-type.
//
// The `type` values below are the REAL iOS ones, measured rather than assumed:
// expo-file-system computes type as UTType(filenameExtension:).preferredMIMEType
// (ios/FileSystemFile.swift), which on this machine returns image/png, image/jpeg
// and — note — audio/x-m4a, NOT the audio/mp4 the app declares for recordings.
// Keeping the discrepancy in the mock is deliberate: it is what makes the voice test
// able to prove the CALLER's declared MIME wins over the file-derived one, so nobody
// can "simplify" buildFileForm into using File.type without a test failing.
jest.mock("expo-file-system", () => {
  const MIME = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    m4a: "audio/x-m4a",
  };

  // In-memory filesystem: map of uri -> { type: "file"|"dir", content: string|Map }
  const fs = new Map();

  // Seeded files for the multipart test (bypasses fs storage)
  const seededContents = new Map();

  // URIs that should fail on delete (for testing error handling)
  const failDeleteSet = new Set();

  // Initialize root directories
  const initFS = () => {
    fs.clear();
    fs.set("file:///document", { type: "dir", content: new Map() });
    fs.set("file:///cache", { type: "dir", content: new Map() });
  };
  initFS();

  class Directory {
    constructor(parentOrUri, name) {
      // Support: new Directory(Paths.document, "captures") or new Directory(uri)
      if (typeof parentOrUri === "string") {
        // Direct URI
        this.uri = String(parentOrUri);
      } else if (parentOrUri && parentOrUri.uri) {
        // Directory parent
        const parentUri = parentOrUri.uri;
        this.uri = `${parentUri}${parentUri.endsWith("/") ? "" : "/"}${name}`;
      } else {
        throw new Error("Invalid Directory constructor arguments");
      }
    }

    get name() {
      return this.uri.split("/").pop() ?? "";
    }

    get exists() {
      const entry = fs.get(this.uri);
      return !!(entry && entry.type === "dir");
    }

    create({ intermediates = false } = {}) {
      if (this.exists) return; // idempotent

      if (intermediates) {
        // Create all parent directories up to this one
        // Build a list of all paths: ["file:///", "file:///document", "file:///document/captures"]
        const uri = this.uri;
        const uriParts = uri.split("/");
        let currentPath = "";

        for (let i = 0; i < uriParts.length; i++) {
          if (i < 3) {
            // Handle "file:" and "" and ""
            if (i === 0) {
              currentPath = uriParts[0]; // "file:"
            } else if (i === 1) {
              currentPath += "/" + uriParts[1]; // "file:/"
            } else if (i === 2) {
              currentPath += "/" + uriParts[2]; // "file://"
            }
          } else {
            // Now we're at the directory names
            currentPath += "/" + uriParts[i];
            if (!fs.has(currentPath)) {
              fs.set(currentPath, { type: "dir", content: new Map() });
            }
          }
        }
      } else {
        // Create just this directory
        fs.set(this.uri, { type: "dir", content: new Map() });
      }
    }

    delete() {
      // Recursively delete this directory
      const entry = fs.get(this.uri);
      if (!entry || entry.type !== "dir") return;

      // Delete all children
      for (const [key] of fs) {
        if (key.startsWith(this.uri + "/")) {
          fs.delete(key);
        }
      }

      fs.delete(this.uri);
    }

    list() {
      const entry = fs.get(this.uri);
      if (!entry || entry.type !== "dir") {
        throw new Error(`Directory not found: ${this.uri}`);
      }

      const result = [];
      const dirUriPrefix = `${this.uri}/`;

      for (const [key, value] of fs) {
        if (key.startsWith(dirUriPrefix) && key.slice(dirUriPrefix.length).indexOf("/") === -1) {
          const name = key.split("/").pop();
          if (value.type === "dir") {
            result.push(new Directory(key));
          } else {
            result.push(new File(key));
          }
        }
      }

      return result;
    }
  }

  class File {
    constructor(dirOrUri, name) {
      if (typeof dirOrUri === "string") {
        // Direct URI: new File(uri)
        this.uri = String(dirOrUri);
      } else if (dirOrUri && dirOrUri.uri) {
        // Directory + name: new File(directory, "filename")
        const dirUri = dirOrUri.uri;
        this.uri = `${dirUri}${dirUri.endsWith("/") ? "" : "/"}${name}`;
      } else {
        throw new Error("Invalid File constructor arguments");
      }
    }

    get name() {
      return this.uri.split("/").pop() ?? "";
    }

    get type() {
      return MIME[this.name.split(".").pop()?.toLowerCase() ?? ""] ?? "";
    }

    get exists() {
      const entry = fs.get(this.uri);
      return !!(entry && entry.type === "file");
    }

    create({ overwrite = false } = {}) {
      if (this.exists && !overwrite) return;
      fs.set(this.uri, { type: "file", content: "" });
    }

    write(content) {
      fs.set(this.uri, { type: "file", content: String(content) });
    }

    textSync() {
      const entry = fs.get(this.uri);
      if (!entry || entry.type !== "file") {
        throw new Error(`File not found: ${this.uri}`);
      }
      return entry.content;
    }

    async bytes() {
      // First check if this was seeded (for multipart test)
      const seeded = seededContents.get(this.uri);
      if (seeded) return seeded;

      // Otherwise read from fs
      const entry = fs.get(this.uri);
      if (!entry || entry.type !== "file") {
        throw new Error(`expo-file-system mock: no contents seeded for ${this.uri}`);
      }
      return Buffer.from(entry.content);
    }

    delete() {
      if (!this.exists) throw new Error(`File not found: ${this.uri}`);
      if (failDeleteSet.has(this.uri)) {
        throw new Error(`Permission denied: cannot delete ${this.uri}`);
      }
      fs.delete(this.uri);
    }

    async copy(destination) {
      const source = fs.get(this.uri);
      if (!source || source.type !== "file") {
        throw new Error(`Source file not found: ${this.uri}`);
      }

      const destUri = destination.uri;
      fs.set(destUri, { type: "file", content: source.content });
    }
  }

  // Test isolation: reset filesystem between tests, preserve seeded contents
  File.__seed = (uri, bytes) => seededContents.set(String(uri), bytes);
  File.__failDelete = (uri) => failDeleteSet.add(String(uri));
  File.__reset = () => {
    seededContents.clear();
    failDeleteSet.clear();
    initFS();
  };

  // Paths: singleton directory instances
  const Paths = {
    get document() {
      return new Directory("file:///document");
    },
    get cache() {
      return new Directory("file:///cache");
    },
  };

  return { __esModule: true, File, Directory, Paths };
});

// expo-crypto: jest-expo's automock resolves randomUUID() to undefined, which
// would hand every log the same empty identity — and the client-minted id is
// the whole basis of replay idempotency for the offline queue. Delegate to
// Node's own crypto so tests get real, distinct v4 UUIDs.
jest.mock("expo-crypto", () => ({
  randomUUID: jest.fn(() => require("crypto").randomUUID()),
}));
