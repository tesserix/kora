import { createSentrySink } from "../sentry";

const mockInit = jest.fn();
const mockCaptureException = jest.fn();
const mockSetUser = jest.fn();

jest.mock("@sentry/react-native", () => ({
  init: (...a: unknown[]) => mockInit(...a),
  captureException: (...a: unknown[]) => mockCaptureException(...a),
  setUser: (...a: unknown[]) => mockSetUser(...a),
}));

const DSN = "https://key@o1.ingest.sentry.io/1";

beforeEach(() => {
  mockInit.mockClear();
  mockCaptureException.mockClear();
  mockSetUser.mockClear();
  delete process.env.EXPO_PUBLIC_SENTRY_DSN;
});

// A missing DSN is the NORMAL state in development, and in any build made
// before the Sentry project exists. It must yield no sink rather than a
// half-initialised one — the app runs unreported, exactly as it does today.
test("returns null when no DSN is configured, without calling init", () => {
  expect(createSentrySink()).toBeNull();
  expect(mockInit).not.toHaveBeenCalled();
});

test("initialises with the DSN when one is configured", () => {
  process.env.EXPO_PUBLIC_SENTRY_DSN = DSN;
  const sink = createSentrySink();
  expect(sink).not.toBeNull();
  expect(mockInit).toHaveBeenCalledWith(expect.objectContaining({ dsn: DSN }));
});

// The reporter layer redacts before anything reaches a sink, and synthesizes a
// clean Error for ApiError rather than forwarding a server message that can
// echo user input. Default PII collection would reintroduce precisely what
// that redaction exists to remove.
test("does not enable Sentry's default PII collection", () => {
  process.env.EXPO_PUBLIC_SENTRY_DSN = DSN;
  createSentrySink();
  expect(mockInit).toHaveBeenCalledWith(expect.objectContaining({ sendDefaultPii: false }));
});

// kora#104 asks for crash visibility, not APM. Tracing carries its own quota
// cost and is a separate decision.
test("does not enable performance tracing", () => {
  process.env.EXPO_PUBLIC_SENTRY_DSN = DSN;
  createSentrySink();
  expect(mockInit).toHaveBeenCalledWith(expect.objectContaining({ tracesSampleRate: 0 }));
});

test("recordError forwards the error with its attributes as searchable tags", () => {
  process.env.EXPO_PUBLIC_SENTRY_DSN = DSN;
  const sink = createSentrySink()!;
  const err = new Error("NetworkError");
  sink.recordError(err, { error_class: "NetworkError", route: "/capture" });

  expect(mockCaptureException).toHaveBeenCalledWith(err, {
    tags: { error_class: "NetworkError", route: "/capture" },
  });
});

test("setUser associates and, on sign-out, clears", () => {
  process.env.EXPO_PUBLIC_SENTRY_DSN = DSN;
  const sink = createSentrySink()!;

  sink.setUser("user-1");
  expect(mockSetUser).toHaveBeenCalledWith({ id: "user-1" });

  // A sign-out must dissociate, or the next person's errors are attributed to
  // the previous user.
  sink.setUser(null);
  expect(mockSetUser).toHaveBeenLastCalledWith(null);
});
