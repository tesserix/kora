// #82 regression suite for the OFFLINE drain path.
//
// Modelled directly on src/api/__tests__/resolve-upload-multipart.test.tsx — read that
// file's header for the full story. The short version: Expo SDK 57 routes global
// `fetch` through its winter runtime, whose `convertFormDataAsync` accepts exactly
// three part shapes (a string, a real `Blob`, or an object exposing `bytes()`) and
// throws "Unsupported FormDataPart implementation" for React Native's legacy
// `{ uri, name, type }` file part. That is the bug that shipped broken for the life
// of this project.
//
// That suite covers src/api/hooks.ts. It does NOT cover drainCaptures.ts's own
// `resolveCapture`, which is the SECOND production caller of buildCaptureForm and the
// only one on the offline path — and drainCaptures.test.ts injects `resolve`, so
// `resolveCapture` is dead code there. Reverting the multipart part to the legacy
// shape, appending it under "photo" instead of "file", or swapping the declared MIME
// for the File's own therefore left the whole suite green.
//
// So, exactly as the sibling suite does: this mocks the TRANSPORT (apiFetchMultipart)
// and NOT the conversion. drainCaptures builds a real FormData through the real
// buildCaptureForm, and that exact object is then run through Expo's real converter.
// A fix that merely satisfies a mock cannot pass here.
//
// It drives `drainCaptures(queryClient)` — the app-facing wrapper — rather than
// exporting `resolveCapture` for the test, so the thing under test is the code path
// production actually takes.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { File, Paths } from "expo-file-system";
import { convertFormDataAsync } from "expo/src/winter/fetch/convertFormData";
import { apiFetchMultipart } from "@/lib/api";
import { copyIntoQueue } from "../captureMedia";
import { append as appendCapture } from "../captureQueue";
import { drainCaptures } from "../drainCaptures";

// The transport only. Everything below it — buildCaptureForm, expo-file-system's
// File, the FormData itself — is real.
jest.mock("@/lib/api", () => ({
  apiFetchMultipart: jest.fn(),
  currentUserId: jest.fn(() => "uid-1"),
}));

const atLocalNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();

const RESOLUTION = {
  tier: "confirm",
  candidates: [{ item: { id: "food-1", name: "Oats", kcal_per_100g: 389 }, portion_grams: 100 }],
};

// drainCaptures only ever calls invalidateQueries on this.
const queryClient = { invalidateQueries: jest.fn() } as never;

function makeSourceFile(name: string, contents: string): string {
  const f = new File(Paths.cache, name);
  f.create({ overwrite: true });
  f.write(contents);
  return f.uri;
}

async function seed(id: string, fileName: string, mimeType: string, contents: string) {
  const storedName = await copyIntoQueue(makeSourceFile(`${id}-src${fileName.slice(fileName.lastIndexOf("."))}`, contents), id, fileName);
  await appendCapture({
    id, kind: fileName.endsWith(".m4a") ? "voice" : "photo", storedName, fileName, mimeType,
    capturedAt: atLocalNoon(2026, 8, 1), ownerId: "uid-1",
  } as Parameters<typeof appendCapture>[0]);
}

beforeEach(async () => {
  await AsyncStorage.clear();
  (apiFetchMultipart as jest.Mock).mockReset().mockResolvedValue(RESOLUTION);
});

// Runs the FormData the drain actually built through Expo's real converter and
// returns the encoded multipart body as text.
async function encodeDrainedForm(): Promise<string> {
  expect(apiFetchMultipart).toHaveBeenCalledTimes(1);
  const form = (apiFetchMultipart as jest.Mock).mock.calls[0][1] as FormData;
  expect(form).toBeInstanceOf(FormData);
  const { body } = await convertFormDataAsync(form);
  return new TextDecoder().decode(body);
}

test("the drain's photo resolve builds a multipart body Expo's fetch can actually encode", async () => {
  // Recognisable ASCII rather than real JPEG bytes, so the assertion below proves the
  // queued file's CONTENTS reached the body — not merely that some bytes were written.
  await seed("cap_1754006400000_aaaaaa", "meal.jpg", "image/jpeg", "MEAL");

  await drainCaptures(queryClient);

  expect(apiFetchMultipart).toHaveBeenCalledWith("/v1/resolve/photo", expect.any(FormData));

  const encoded = await encodeDrainedForm();
  // The Go handler reads the part by name: c.FormFile("file") in
  // api/internal/resolve/handler.go. Any other name is a 400 "file is required".
  expect(encoded).toContain('name="file"');
  expect(encoded).toContain("MEAL");
  expect(encoded).toContain('filename="meal.jpg"');
  // Sending a Content-Type keeps the server off its http.DetectContentType fallback.
  expect(encoded).toContain("content-type: image/jpeg");
});

test("the drain's voice resolve sends the DECLARED mime, not the file's own", async () => {
  await seed("cap_1754006400000_bbbbbb", "clip.m4a", "audio/mp4", "CLIP");

  await drainCaptures(queryClient);

  expect(apiFetchMultipart).toHaveBeenCalledWith("/v1/resolve/voice", expect.any(FormData));

  const encoded = await encodeDrainedForm();
  expect(encoded).toContain('name="file"');
  expect(encoded).toContain("CLIP");
  expect(encoded).toContain('filename="clip.m4a"');
  // The queued row's stored mimeType wins over anything expo-file-system derives from
  // the extension. iOS maps ".m4a" to "audio/x-m4a" (the jest.setup.js mock reproduces
  // that exact value), and the server hands this MIME straight to the model — so
  // taking the OS value would silently change the wire format of a path that cannot
  // be exercised end to end (#79).
  expect(encoded).toContain("content-type: audio/mp4");
  expect(encoded).not.toContain("audio/x-m4a");
});
