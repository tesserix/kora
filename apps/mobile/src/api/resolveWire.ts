import { File } from "expo-file-system";
import type { Resolution, ResolvedCandidate } from "./types";

// A leaf module: no imports from @/offline/*. drainCaptures (src/offline/drainCaptures.ts)
// needs both helpers below, but api/hooks.ts already imports from @/offline/* (connectivity,
// foodCache, cachedResolution, queue, queryKeys) — so importing hooks.ts back from the offline
// layer would invert that dependency and make the two directories mutually dependent. Both
// helpers moved here, verbatim, so each side keeps a one-way dependency on this leaf instead.

// The server's ai.Resolution.Candidates field has no `omitempty`
// (api/internal/ai/types.go:81), and several resolver paths never populate it
// — budget-exceeded, zero-guess, and barcode's own "not recognized" branch
// (api/internal/resolve/handler.go:210-217) — leaving it Go's nil slice,
// which json.Marshal sends over the wire as `candidates: null`, not `[]`.
// Every existing consumer (AskAgainSheet, DetectedCard, capture.tsx) already
// treats an EMPTY array as "no results" and none of them expect `null`, so
// this normalizes the response ONCE, right where it enters the app, rather
// than pushing a null check onto every future caller — the barcode cache
// writer below almost shipped a crash on the server's designed "barcode not
// recognized" response for exactly that reason.
export function normalizeResolution(raw: unknown): Resolution {
  const r = raw as Omit<Resolution, "candidates"> & { candidates: ResolvedCandidate[] | null };
  return { ...r, candidates: r.candidates ?? [] };
}

export type ResolveFile = {
  uri: string;
  name: string;
  type: string;
};

// buildFileForm makes the one multipart body shape Expo SDK 57 can actually send.
//
// Global `fetch` is Expo's winter-runtime implementation, and its FormData converter
// (expo/src/winter/fetch/convertFormData.ts) accepts exactly three part shapes: a
// string, a real `Blob`, or an object exposing `bytes()`. React Native's legacy
// `{ uri, name, type }` file part is NOT one of them — it throws "Unsupported
// FormDataPart implementation" before any I/O, which is why photo and voice capture
// had never once worked in production (#82).
//
// A hand-built `Blob` is not an option either: React Native's Blob cannot be
// constructed from binary data in JS (BlobManager.createFromParts throws on
// ArrayBuffer/ArrayBufferView). That leaves expo-file-system's `File`, which
// implements Blob and exposes bytes()/name/type — the shape Expo's own converter
// test blesses.
//
// WHY THE CALLER STILL DECLARES name/type, instead of letting the File supply them:
// expo-file-system derives `type` from the filename extension via
// UTType(filenameExtension:).preferredMIMEType, and on iOS ".m4a" maps to
// "audio/x-m4a" — NOT the "audio/mp4" this app has always declared for recordings.
// That MIME is not cosmetic: the server forwards it straight to the model
// (genai.NewPartFromBytes(audio, mime) in api/internal/ai/providers/gemini.go), and
// voice cannot currently be exercised end to end (#79 kills the request at Istio's
// 30s perTryTimeout). Taking the OS value would therefore silently change the wire
// format of a path nobody can verify, so the declared value wins and this fix changes
// nothing observable about voice except that the body now sends at all.
//
// The cast is unavoidable — TypeScript's FormData.append only admits string | Blob,
// while the converter's third branch is structural (`'bytes' in entry`). It is
// confined here, aimed at a named type rather than a blind `as unknown as Blob`, and
// unlike the code it replaces it is covered by a test that encodes the resulting body
// with Expo's real converter, so a wrong shape fails loudly instead of silently.
type MultipartFilePart = {
  bytes: () => Promise<Uint8Array>;
  name: string;
  type: string;
};

export function buildCaptureForm(file: ResolveFile): FormData {
  const source = new File(file.uri);
  const part: MultipartFilePart = {
    bytes: () => source.bytes(),
    name: file.name,
    type: file.type,
  };
  const form = new FormData();
  form.append("file", part as unknown as Blob);
  return form;
}
