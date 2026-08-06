// The offline branch, driven by the REAL failure a real offline device produces.
//
// capture-offline-queue.test.tsx hand-constructs `new NetworkError(...)` and hands it
// to the mutation's onError, so nothing in that suite ever exercises which error
// api.ts actually throws first. It throws AuthTokenError: fetchWithRetry awaits
// getToken(user) BEFORE it calls fetch (src/lib/api.ts), and api-error-modes.test.ts
// already pins that when getIdToken rejects, fetch is never attempted — so no
// NetworkError is produced at all. Firebase serves getIdToken() from cache while the
// ID token is valid (~1h) and goes to the network to refresh it after that, where
// offline rejects with auth/network-request-failed. A user offline for longer than an
// hour therefore reached handleResolveFailure with an AuthTokenError, which the
// original `instanceof NetworkError` gate rejected — and the capture was dropped, in
// exactly the scenario the queue exists for.
//
// So this suite does NOT mock "@/lib/api". It mocks the seam below it — Firebase's
// auth object and global fetch — and lets the real api.ts produce the error, which
// then travels through the real onError wiring into handleResolveFailure.
import { act, fireEvent, render as rtlRender, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { AuthTokenError, NetworkError, apiFetchMultipart } from "@/lib/api";
import { mealSlotForHour } from "@/lib/mealSlot";

jest.mock("expo-router", () => ({ router: { back: jest.fn(), push: jest.fn() } }));

// Firebase's own module boundary. `getIdToken` rejecting is what an expired cached
// token does on an offline device; firebase/auth's other exports are only used by
// api.ts's session-expiry bookkeeping.
const mockGetIdToken = jest.fn();
jest.mock("firebase/auth", () => ({
  signOut: jest.fn(async () => {}),
  onAuthStateChanged: jest.fn(() => jest.fn()),
}));
jest.mock("@/lib/firebase", () => ({
  auth: { currentUser: { uid: "uid-1", getIdToken: (...a: unknown[]) => mockGetIdToken(...a) } },
  isFirebaseConfigured: true,
}));

// The resolve hooks are stubbed, but useResolvePhoto's `mutate` runs the REAL
// apiFetchMultipart and routes its rejection into the caller's onError exactly as
// react-query would — so the error reaching capture.tsx is the one api.ts minted, not
// one this file wrote.
jest.mock("@/api/hooks", () => ({
  useProfile: () => ({ data: { display_name: "Alex Stone" } }),
  useResolveText: () => ({ mutate: jest.fn(), isPending: false }),
  useResolvePhoto: () => ({
    mutate: (_input: unknown, options: { onError: (e: Error) => void }) => {
      const { apiFetchMultipart: realFetch } = jest.requireActual("@/lib/api");
      return realFetch("/v1/resolve/photo", new FormData()).catch(options.onError);
    },
    isPending: false,
  }),
  useResolveVoice: () => ({ mutate: jest.fn(), isPending: false }),
  useResolveBarcode: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateLog: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useFoodSearch: () => ({ data: [], isLoading: false, isError: false }),
}));

jest.mock("@/offline/enqueueCapture", () => ({ enqueueCapture: jest.fn() }));

// The slot capture.tsx seeds itself with, derived the same way production does
// rather than pinned to a literal, so the assertion holds whatever hour the
// suite runs at. Never `expect.any(String)`: passing `kind` or `fileName` as
// the slot would stay green, and the slot decides which diary section the
// meal lands in.
const expectedMealSlot = () => mealSlotForHour(new Date().getHours());

import CaptureScreen from "../capture";

function mockEnqueueCapture(): jest.Mock {
  return jest.requireMock("@/offline/enqueueCapture").enqueueCapture;
}

async function render(ui: React.ReactElement) {
  const queryClient = new QueryClient();
  return rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  mockGetIdToken.mockReset();
  mockEnqueueCapture().mockReset().mockResolvedValue({ id: "cap-1" });
  global.fetch = jest.fn();
  (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockReset().mockResolvedValue({ granted: true });
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockReset().mockResolvedValue({ granted: true });
  (ImagePicker.launchCameraAsync as jest.Mock).mockReset().mockResolvedValue({
    canceled: false,
    assets: [{ uri: "file://x.jpg", fileName: "x.jpg", mimeType: "image/jpeg" }],
  });
});

// Firebase's real offline rejection. The device has no connection, so refreshing the
// expired cached ID token cannot complete.
function goOffline(): void {
  mockGetIdToken.mockRejectedValue(
    Object.assign(new Error("Firebase: Error (auth/network-request-failed)."), {
      code: "auth/network-request-failed",
    }),
  );
  (global.fetch as jest.Mock).mockRejectedValue(new TypeError("Network request failed"));
}

// The ordering fact the whole finding rests on, asserted against the real module
// rather than assumed: offline, the token fetch fails FIRST and fetch never runs, so
// a gate that only admits NetworkError never fires.
test("an offline device produces AuthTokenError before any NetworkError can exist", async () => {
  goOffline();

  const caught = await apiFetchMultipart("/v1/resolve/photo", new FormData()).catch((e: unknown) => e);

  expect(caught).toBeInstanceOf(AuthTokenError);
  expect(caught).not.toBeInstanceOf(NetworkError);
  expect(global.fetch).not.toHaveBeenCalled();
});

test("a photo whose resolve dies on the token fetch is queued, not lost", async () => {
  goOffline();
  const rendered = await render(<CaptureScreen />);

  await act(async () => {
    fireEvent.press(await rendered.findByLabelText("Photo viewfinder"));
  });

  await waitFor(() => expect(mockEnqueueCapture()).toHaveBeenCalled());
  expect(mockEnqueueCapture()).toHaveBeenCalledWith(
    { uri: "file://x.jpg", name: "x.jpg", type: "image/jpeg" },
    "photo",
    expectedMealSlot(),
  );
  // And the user is told it was saved, not that their session is in doubt.
  expect(await rendered.findByText(/you.{0,3}re offline/i)).toBeTruthy();
  expect(rendered.queryByText(/couldn.{0,3}t confirm your session/i)).toBeNull();
});
