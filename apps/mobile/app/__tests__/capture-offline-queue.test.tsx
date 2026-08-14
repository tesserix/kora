import { useState } from "react";
import { act, fireEvent, render as rtlRender, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { useAudioRecorder } from "expo-audio";
import { router } from "expo-router";
import { ApiError, AuthTokenError, CancelledError, NetworkError, TimeoutError } from "@/lib/api";
import { CaptureQueueFullError } from "@/offline/captureQueue";
import { NoOwnerError } from "@/offline/owner";
import { mealSlotForHour } from "@/lib/mealSlot";
import { QUEUED_CAPTURES_KEY } from "@/offline/queryKeys";

import CaptureScreen from "../capture";

jest.mock("expo-router", () => ({ router: { back: jest.fn(), push: jest.fn() } }));

// Same shape as the real "@/lib/api" — see capture.test.tsx for why this is
// mocked instead of pulling in the real module (which drags in firebase/auth
// ESM) under Jest.
jest.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    requestId?: string;
    constructor(status: number, code: string, message: string, requestId?: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.requestId = requestId;
      this.name = "ApiError";
    }
  },
  AuthTokenError: class AuthTokenError extends Error {
    constructor(cause?: unknown) {
      super("Failed to obtain an auth token", { cause });
      this.name = "AuthTokenError";
    }
  },
  NetworkError: class NetworkError extends Error {
    constructor(cause?: unknown) {
      super("Network request failed", { cause });
      this.name = "NetworkError";
    }
  },
  ResponseParseError: class ResponseParseError extends Error {
    constructor(cause?: unknown) {
      super("Failed to parse response body", { cause });
      this.name = "ResponseParseError";
    }
  },
  TimeoutError: class TimeoutError extends Error {
    constructor() {
      super("The request timed out");
      this.name = "TimeoutError";
    }
  },
  CancelledError: class CancelledError extends Error {
    constructor(cause?: unknown) {
      super("Request cancelled", { cause });
      this.name = "CancelledError";
    }
  },
}));

// The slot capture.tsx seeds itself with (mealSlotForHour(new Date().getHours())),
// derived the same way production does rather than pinned to a literal, so the
// assertion stays correct whatever hour the suite runs at. Asserting
// `expect.any(String)` here was worthless: passing `kind`, `fileName`, or any
// other string as the slot stayed green, and the slot is what decides which
// diary section the meal lands in.
const expectedMealSlot = () => mealSlotForHour(new Date().getHours());

const mockResolveTextMutate = jest.fn();
const mockResolvePhotoMutate = jest.fn();
const mockResolveVoiceMutate = jest.fn();
const mockResolveBarcodeMutate = jest.fn();
const mockCreateLogMutateAsync = jest.fn();

// A plain `{ mutate, isPending: false }` object (as the other describe
// blocks below used before the Cancel tests were added) never lets
// displayStage reach "analyzing", so the Cancel control never renders and
// there is nothing to press. This mirrors capture.tsx's own hook shape with
// real state instead: mutate() flips isPending true synchronously, which
// re-renders the tree the same way a real useMutation call would, and the
// Cancel tests below rely on that to reach and press the button.
function mockUseMutation(mutateFn: jest.Mock) {
  const [isPending, setIsPending] = useState(false);
  return {
    isPending,
    mutate: (vars: unknown, options: unknown) => {
      setIsPending(true);
      mutateFn(vars, options);
    },
  };
}

jest.mock("@/api/hooks", () => ({
  useProfile: () => ({ data: { display_name: "Alex Stone" } }),
  useResolveText: () => mockUseMutation(mockResolveTextMutate),
  useResolvePhoto: () => mockUseMutation(mockResolvePhotoMutate),
  useResolveVoice: () => mockUseMutation(mockResolveVoiceMutate),
  useResolveBarcode: () => mockUseMutation(mockResolveBarcodeMutate),
  useCreateLog: () => ({ mutateAsync: mockCreateLogMutateAsync, isPending: false }),
  useFoodSearch: () => ({ data: [], isLoading: false, isError: false }),
}));

// The boundary under test: capture.tsx's decision to enqueue on NetworkError
// and how it reacts to enqueueCapture's outcome. enqueueCapture's own
// behaviour (copy-before-append, ownership) is covered by
// src/offline/__tests__/enqueueCapture.test.ts.
//
// The mock function is fetched via jest.requireMock (not a module-level
// `const` closed over by the factory) so its identity can never drift from
// what capture.tsx actually imports — a `const mockX = jest.fn()` captured by
// the factory risks resolving before the const initializes, given import
// statements (and therefore this module's require of "../capture", which
// pulls in "@/offline/enqueueCapture") are hoisted above other statements.
jest.mock("@/offline/enqueueCapture", () => ({ enqueueCapture: jest.fn() }));

type MockRecorder = {
  prepareToRecordAsync: jest.Mock;
  record: jest.Mock;
  stop: jest.Mock;
  uri: string | null;
};

function makeRecorder(): MockRecorder {
  const recorder: MockRecorder = {
    prepareToRecordAsync: jest.fn(async () => {}),
    record: jest.fn(),
    stop: jest.fn(),
    uri: null,
  };
  recorder.stop = jest.fn(async () => {
    recorder.uri = "file://mock-recording.m4a";
  });
  return recorder;
}

function mockEnqueueCapture(): jest.Mock {
  return jest.requireMock("@/offline/enqueueCapture").enqueueCapture;
}

// CaptureScreen holds its own query client (useQueryClient, to invalidate the
// queued-captures view after an offline enqueue), so every render needs a
// provider in the tree.
// rtlRender's return value must be awaited before its query methods
// (findByText, etc.) are actually attached — mirrors every `await render(...)`
// call already established in capture.test.tsx.
async function render(ui: React.ReactElement, options?: Parameters<typeof rtlRender>[1]) {
  const queryClient = new QueryClient();
  const invalidateQueriesSpy = jest.spyOn(queryClient, "invalidateQueries");
  const result = await rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>, options);
  // RNTL's render() defines its query methods as non-enumerable, so a spread
  // (`{ ...result, ... }`) silently drops every one of them — mutate instead.
  return Object.assign(result, { invalidateQueriesSpy });
}

beforeEach(() => {
  mockResolveTextMutate.mockReset();
  mockResolvePhotoMutate.mockReset();
  mockResolveVoiceMutate.mockReset();
  mockResolveBarcodeMutate.mockReset();
  mockCreateLogMutateAsync.mockReset();
  mockEnqueueCapture().mockReset();
  (router.back as jest.Mock).mockReset();
  (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockReset().mockResolvedValue({ granted: true });
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockReset().mockResolvedValue({ granted: true });
  (ImagePicker.launchCameraAsync as jest.Mock).mockReset();
  (useAudioRecorder as jest.Mock).mockReset().mockReturnValue(makeRecorder());
});

describe("Photo capture goes offline", () => {
  async function triggerPhotoNetworkError() {
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file://x.jpg", fileName: "x.jpg", mimeType: "image/jpeg" }],
    });
    const rendered = await render(<CaptureScreen />);
    await fireEvent.press(await rendered.findByLabelText("Photo viewfinder"));
    await waitFor(() => expect(mockResolvePhotoMutate).toHaveBeenCalled());
    const [, options] = mockResolvePhotoMutate.mock.calls[0];
    await act(async () => options.onError(new NetworkError(new TypeError("Network request failed"))));
    return rendered;
  }

  test("queues the photo with the file, kind, and current meal slot", async () => {
    mockEnqueueCapture().mockResolvedValue({ id: "cap-1" });
    await triggerPhotoNetworkError();

    expect(mockEnqueueCapture()).toHaveBeenCalledWith(
      { uri: "file://x.jpg", name: "x.jpg", type: "image/jpeg" },
      "photo",
      expectedMealSlot(),
    );
  });

  test("tells the user it saved the capture for later, not that it failed", async () => {
    mockEnqueueCapture().mockResolvedValue({ id: "cap-1" });
    const rendered = await triggerPhotoNetworkError();

    expect(await rendered.findByText(/you.{0,3}re offline/i)).toBeTruthy();
    expect(rendered.queryByText(/couldn.{0,3}t reach the server/i)).toBeNull();
  });

  test("invalidates the queued-captures view once the enqueue succeeds", async () => {
    mockEnqueueCapture().mockResolvedValue({ id: "cap-1" });
    const rendered = await triggerPhotoNetworkError();

    await waitFor(() =>
      expect(rendered.invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: [QUEUED_CAPTURES_KEY] }),
    );
  });

  test("a full queue surfaces CaptureQueueFullError's message verbatim", async () => {
    mockEnqueueCapture().mockRejectedValue(new CaptureQueueFullError());
    const rendered = await triggerPhotoNetworkError();

    expect(
      await rendered.findByText(
        "There are too many captures waiting to be identified. Connect to the internet, or remove one first.",
      ),
    ).toBeTruthy();
  });

  test("no signed-in owner surfaces NoOwnerError's message verbatim", async () => {
    mockEnqueueCapture().mockRejectedValue(new NoOwnerError());
    const rendered = await triggerPhotoNetworkError();

    expect(await rendered.findByText("Can't save this log — please sign in and try again.")).toBeTruthy();
  });

  test("an unexpected enqueue failure falls back to the network error's own message", async () => {
    mockEnqueueCapture().mockRejectedValue(new Error("disk full"));
    const rendered = await triggerPhotoNetworkError();

    expect(await rendered.findByText(/couldn.{0,3}t reach the server/i)).toBeTruthy();
  });

  // The regression this task fixes: api.ts's own REQUEST_TIMEOUT_MS now fires
  // before Istio's 30s cut would, so a slow/flaky-cellular resolve throws
  // TimeoutError instead of the NetworkError this describe block otherwise
  // exercises. Before this task's fix, TimeoutError matched neither branch in
  // handleResolveFailure's guard and the capture was silently dropped instead
  // of queued — exactly the scenario the offline queue exists for.
  test("queues a timed-out photo the same as a network failure, not dropped", async () => {
    mockEnqueueCapture().mockResolvedValue({ id: "cap-1" });
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file://x.jpg", fileName: "x.jpg", mimeType: "image/jpeg" }],
    });
    const rendered = await render(<CaptureScreen />);
    await fireEvent.press(await rendered.findByLabelText("Photo viewfinder"));
    await waitFor(() => expect(mockResolvePhotoMutate).toHaveBeenCalled());
    const [, options] = mockResolvePhotoMutate.mock.calls[0];
    await act(async () => options.onError(new TimeoutError()));

    expect(mockEnqueueCapture()).toHaveBeenCalledWith(
      { uri: "file://x.jpg", name: "x.jpg", type: "image/jpeg" },
      "photo",
      expectedMealSlot(),
    );
    expect(await rendered.findByText(/you.{0,3}re offline/i)).toBeTruthy();
  });
});

describe("Voice capture goes offline", () => {
  test("queues the voice clip with kind 'voice' and the current meal slot, not 'photo'", async () => {
    mockEnqueueCapture().mockResolvedValue({ id: "cap-2" });
    const recorder = makeRecorder();
    (useAudioRecorder as jest.Mock).mockReturnValue(recorder);

    const rendered = await render(<CaptureScreen />);
    await fireEvent.press(await rendered.findByText("Voice"));
    await fireEvent.press(await rendered.findByLabelText("Hold to record"));
    await fireEvent.press(await rendered.findByLabelText("Stop recording"));

    await waitFor(() => expect(mockResolveVoiceMutate).toHaveBeenCalled());
    const [, options] = mockResolveVoiceMutate.mock.calls[0];
    await act(async () => options.onError(new NetworkError(new TypeError("Network request failed"))));

    expect(mockEnqueueCapture()).toHaveBeenCalledWith(
      { uri: "file://mock-recording.m4a", name: "clip.m4a", type: "audio/mp4" },
      "voice",
      expectedMealSlot(),
    );
    expect(await rendered.findByText(/you.{0,3}re offline/i)).toBeTruthy();
  });
});

// #136 task 3 + its follow-up review. Cancel stops the WAITING, not the
// capture: a cancelled capture whose failure would otherwise be queueable is
// preserved, and a cancel that has nothing to preserve queues nothing.
//
// The discriminant is the ERROR CLASS, not a connectivity snapshot. A capture
// cancelled on a dead connection arrives as a NetworkError (the request had
// already failed in transport), which handleResolveFailure queues exactly as it
// queues an uncancelled one. A capture cancelled on a live connection arrives as
// api.ts's CancelledError, which that same classifier does not queue — there is
// nothing to resolve later. isOnline() used to make this call instead, and it
// fails open while NetInfo is still probing: on a connection that had dropped
// but not yet been reclassified, the capture was discarded.
describe("Cancelling a photo resolve", () => {
  async function cancelPhotoResolve(error: Error) {
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file://x.jpg", fileName: "x.jpg", mimeType: "image/jpeg" }],
    });
    const rendered = await render(<CaptureScreen />);
    await fireEvent.press(await rendered.findByLabelText("Photo viewfinder"));
    await waitFor(() => expect(mockResolvePhotoMutate).toHaveBeenCalled());
    await fireEvent.press(await rendered.findByLabelText("Cancel"));

    const [, options] = mockResolvePhotoMutate.mock.calls[0];
    await act(async () => options.onError(error));
    return rendered;
  }

  test("offline, the cancelled capture is enqueued rather than discarded", async () => {
    mockEnqueueCapture().mockResolvedValue({ id: "cap-cancel-photo" });

    await cancelPhotoResolve(new NetworkError(new TypeError("Network request failed")));

    expect(mockEnqueueCapture()).toHaveBeenCalledWith(
      { uri: "file://x.jpg", name: "x.jpg", type: "image/jpeg" },
      "photo",
      expectedMealSlot(),
    );
  });

  test("online, nothing is enqueued — there is nothing to resolve later", async () => {
    await cancelPhotoResolve(new CancelledError(new Error("aborted")));

    expect(mockEnqueueCapture()).not.toHaveBeenCalled();
  });

  // A broken session while offline is the condition handleResolveFailure's own
  // comment names as the reason it groups AuthTokenError with NetworkError: a
  // user offline for longer than the token's life (a flight, a hike) gets
  // AuthTokenError, not NetworkError, and the capture must survive it — cancelled
  // or not.
  test("an expired token while offline still preserves the cancelled capture", async () => {
    mockEnqueueCapture().mockResolvedValue({ id: "cap-cancel-auth" });

    await cancelPhotoResolve(new AuthTokenError(new Error("no token")));

    expect(mockEnqueueCapture()).toHaveBeenCalledWith(
      { uri: "file://x.jpg", name: "x.jpg", type: "image/jpeg" },
      "photo",
      expectedMealSlot(),
    );
  });

  // `silent` itself, pinned: Cancel already took the screen to idle and told
  // the user what it was doing, so a successful enqueue does NOT also pop an
  // Otto bubble. Without this, deleting `{ silent: true }` from the cancelled
  // path would keep the whole suite green.
  test("a successful enqueue after Cancel says nothing — the screen already went idle", async () => {
    mockEnqueueCapture().mockResolvedValue({ id: "cap-cancel-photo" });

    const rendered = await cancelPhotoResolve(new NetworkError(new TypeError("Network request failed")));

    expect(mockEnqueueCapture()).toHaveBeenCalled();
    expect(rendered.queryByText(/i.{0,3}ve saved that/i)).toBeNull();
    expect(rendered.queryByText(/you.{0,3}re offline/i)).toBeNull();
  });

  // The other half of that rule, and the defect it exists to prevent: `silent`
  // suppresses the reassurance, never the bad news. A queue refusal on the
  // cancelled path destroyed the photo with zero indication.
  test("a full queue still surfaces its refusal — a destroyed capture is never silent", async () => {
    mockEnqueueCapture().mockRejectedValue(new CaptureQueueFullError());

    const rendered = await cancelPhotoResolve(new NetworkError(new TypeError("Network request failed")));

    expect(
      await rendered.findByText(
        "There are too many captures waiting to be identified. Connect to the internet, or remove one first.",
      ),
    ).toBeTruthy();
  });

  test("no signed-in owner still surfaces its refusal on the cancelled path", async () => {
    mockEnqueueCapture().mockRejectedValue(new NoOwnerError());

    const rendered = await cancelPhotoResolve(new NetworkError(new TypeError("Network request failed")));

    expect(await rendered.findByText("Can't save this log — please sign in and try again.")).toBeTruthy();
  });
});

describe("Cancelling a voice resolve", () => {
  async function cancelVoiceResolve(error: Error) {
    const recorder = makeRecorder();
    (useAudioRecorder as jest.Mock).mockReturnValue(recorder);

    const rendered = await render(<CaptureScreen />);
    await fireEvent.press(await rendered.findByText("Voice"));
    await fireEvent.press(await rendered.findByLabelText("Hold to record"));
    await fireEvent.press(await rendered.findByLabelText("Stop recording"));
    await waitFor(() => expect(mockResolveVoiceMutate).toHaveBeenCalled());
    await fireEvent.press(await rendered.findByLabelText("Cancel"));

    const [, options] = mockResolveVoiceMutate.mock.calls[0];
    await act(async () => options.onError(error));
    return rendered;
  }

  test("offline, the cancelled clip is enqueued rather than discarded", async () => {
    mockEnqueueCapture().mockResolvedValue({ id: "cap-cancel-voice" });

    await cancelVoiceResolve(new NetworkError(new TypeError("Network request failed")));

    expect(mockEnqueueCapture()).toHaveBeenCalledWith(
      { uri: "file://mock-recording.m4a", name: "clip.m4a", type: "audio/mp4" },
      "voice",
      expectedMealSlot(),
    );
  });

  test("online, nothing is enqueued — there is nothing to resolve later", async () => {
    await cancelVoiceResolve(new CancelledError(new Error("aborted")));

    expect(mockEnqueueCapture()).not.toHaveBeenCalled();
  });

  test("a full queue still surfaces its refusal for a cancelled clip", async () => {
    mockEnqueueCapture().mockRejectedValue(new CaptureQueueFullError());

    const rendered = await cancelVoiceResolve(new NetworkError(new TypeError("Network request failed")));

    expect(
      await rendered.findByText(
        "There are too many captures waiting to be identified. Connect to the internet, or remove one first.",
      ),
    ).toBeTruthy();
  });
});

describe("A non-network resolve failure never enqueues", () => {
  test("an ApiError still shows the ordinary Otto message and does not touch the queue", async () => {
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file://x.jpg", fileName: "x.jpg", mimeType: "image/jpeg" }],
    });
    const rendered = await render(<CaptureScreen />);
    await fireEvent.press(await rendered.findByLabelText("Photo viewfinder"));
    await waitFor(() => expect(mockResolvePhotoMutate).toHaveBeenCalled());
    const [, options] = mockResolvePhotoMutate.mock.calls[0];
    await act(async () => options.onError(new ApiError(422, "no_match", "no confident match")));

    expect(await rendered.findByText(/no confident match/i)).toBeTruthy();
    expect(mockEnqueueCapture()).not.toHaveBeenCalled();
  });
});

// ottoErrorMessage's own copy for TimeoutError, exercised through the typed
// (text) resolve path — the one call site of ottoErrorMessage that never
// queues (handleSend doesn't route through handleResolveFailure/
// enqueueCapture at all), so this pins that its message stays honest about
// the timeout itself rather than reusing generic or queuing-flavoured copy.
describe("ottoErrorMessage's TimeoutError copy", () => {
  test("is distinct from the generic fallback and the network-error copy", async () => {
    const rendered = await render(<CaptureScreen />);
    const input = await rendered.findByLabelText("Tell Otto what you ate");
    await fireEvent.changeText(input, "brekkie eggs");
    await fireEvent.press(await rendered.findByLabelText("Send"));

    await waitFor(() => expect(mockResolveTextMutate).toHaveBeenCalled());
    const [, options] = mockResolveTextMutate.mock.calls[0];
    await act(async () => options.onError(new TimeoutError()));

    expect(await rendered.findByText(/took too long/i)).toBeTruthy();
    expect(rendered.queryByText(/something went wrong while i looked/i)).toBeNull();
    expect(rendered.queryByText(/couldn.{0,3}t reach the server/i)).toBeNull();
    // Never claims the capture was saved — this path never enqueues.
    expect(rendered.queryByText(/i.{0,3}ve saved that/i)).toBeNull();
  });
});
