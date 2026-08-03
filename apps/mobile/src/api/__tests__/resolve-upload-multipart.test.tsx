// #82 regression suite — the one that would have caught it.
//
// Photo and voice upload had NEVER worked in production while every test here was
// green, because the existing tests mocked `apiFetchMultipart` and therefore never
// executed the FormData the hooks build. The failure was one layer below the mock:
// Expo SDK 57 routes global `fetch` through its winter runtime, whose
// `convertFormDataAsync` accepts exactly three part shapes — a string, a real `Blob`,
// or an object exposing `bytes()` — and throws
//   "Unsupported FormDataPart implementation"
// for React Native's legacy `{ uri, name, type }` file part. Expo's own suite pins
// that rejection deliberately (expo/src/winter/fetch/__tests__/convertFormData-test.native.ts,
// "should throw an error if the react-native FormData passing an uri"), so this is a
// removed API, not an Expo bug.
//
// So these tests mock the TRANSPORT but not the CONVERSION: the hook builds a real
// FormData, and that exact object is then run through Expo's real converter. A fix
// that merely satisfies a mock cannot pass here — only one that produces a body the
// converter can actually encode.
//
// What this file does NOT prove: that `new File(uri).bytes()` reads a real
// picker/recorder file, or what MIME the native `type` getter reports for a given
// file (the expo-file-system mock in jest.setup.js derives it from the extension).
// Both are device-only facts and are verified on the simulator, not here.
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { File } from "expo-file-system";
import { convertFormDataAsync } from "expo/src/winter/fetch/convertFormData";
import { apiFetchMultipart } from "@/lib/api";
import { useResolvePhoto, useResolveVoice } from "../hooks";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  apiFetchEnvelope: jest.fn(),
  apiFetchMultipart: jest.fn(),
  currentUserId: jest.fn(() => "user-a"),
  ApiError: class extends Error {},
  NetworkError: class extends Error {},
  isNetworkError: () => false,
}));

const resolution = { candidates: [], tier: "auto" };

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

type SeedableFile = typeof File & {
  __seed: (uri: string, bytes: Uint8Array) => void;
  __reset: () => void;
};

beforeEach(() => {
  (File as SeedableFile).__reset();
  (apiFetchMultipart as jest.Mock).mockReset();
});

// Runs the FormData the hook actually built through Expo's real converter and
// returns the encoded multipart body as text.
async function encodeCapturedForm(): Promise<string> {
  expect(apiFetchMultipart).toHaveBeenCalledTimes(1);
  const form = (apiFetchMultipart as jest.Mock).mock.calls[0][1] as FormData;
  expect(form).toBeInstanceOf(FormData);
  const { body } = await convertFormDataAsync(form);
  return new TextDecoder().decode(body);
}

test("useResolvePhoto builds a multipart body Expo's fetch can actually encode", async () => {
  const uri = "file:///Library/Caches/ImagePicker/meal.png";
  // Recognisable ASCII rather than real PNG bytes, so the assertion below proves the
  // file's CONTENTS reached the body — not merely that some bytes were written.
  (File as SeedableFile).__seed(uri, new Uint8Array([0x4d, 0x45, 0x41, 0x4c])); // "MEAL"
  (apiFetchMultipart as jest.Mock).mockResolvedValueOnce(resolution);

  const { result } = await renderHook(() => useResolvePhoto(), { wrapper });
  result.current.mutate({ uri, name: "meal.png", type: "image/png" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(apiFetchMultipart).toHaveBeenCalledWith("/v1/resolve/photo", expect.any(FormData));

  const encoded = await encodeCapturedForm();
  // The Go handler reads the part by name: c.FormFile("file") in
  // api/internal/resolve/handler.go. A body encoded under any other name would be a
  // 400 "file is required".
  expect(encoded).toContain('name="file"');
  expect(encoded).toContain("MEAL");
  // Filename and content-type are now derived from the file itself rather than passed
  // in by the caller, so both are asserted to pin where they come from.
  expect(encoded).toContain('filename="meal.png"');
  // The handler falls back to http.DetectContentType only when the part carries no
  // Content-Type, so sending one keeps the server off the sniffing path.
  expect(encoded).toContain("content-type: image/png");
});

test("useResolveVoice builds a multipart body Expo's fetch can actually encode", async () => {
  const uri = "file:///Library/Caches/AV/recording.m4a";
  (File as SeedableFile).__seed(uri, new Uint8Array([0x43, 0x4c, 0x49, 0x50])); // "CLIP"
  (apiFetchMultipart as jest.Mock).mockResolvedValueOnce(resolution);

  const { result } = await renderHook(() => useResolveVoice(), { wrapper });
  result.current.mutate({ uri, name: "clip.m4a", type: "audio/mp4" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(apiFetchMultipart).toHaveBeenCalledWith("/v1/resolve/voice", expect.any(FormData));

  const encoded = await encodeCapturedForm();
  expect(encoded).toContain('name="file"');
  expect(encoded).toContain("CLIP");
  // The DECLARED name/type win over anything derived from the file. This is the
  // assertion that matters most on this path: the uri ends ".m4a", which iOS maps to
  // "audio/x-m4a" (the expo-file-system mock reproduces that exact value), and the
  // server hands this MIME straight to the model. Voice cannot currently be exercised
  // end to end (#79), so this test is the only thing standing between a refactor and a
  // silent change to an unverifiable wire format.
  expect(encoded).toContain('filename="clip.m4a"');
  expect(encoded).toContain("content-type: audio/mp4");
  expect(encoded).not.toContain("audio/x-m4a");
});

// The bug reduced to its essence, kept as its own test so a regression names itself
// instead of surfacing as four confusing failures above. This is the exact shape the
// hooks used to append, and Expo rejects it outright.
test("the legacy React Native {uri,name,type} file part is rejected by Expo's converter", async () => {
  const form = new FormData();
  form.append("file", { uri: "file:///meal.png", name: "meal.png", type: "image/png" } as never);
  await expect(convertFormDataAsync(form)).rejects.toThrow(/Unsupported FormDataPart implementation/);
});
