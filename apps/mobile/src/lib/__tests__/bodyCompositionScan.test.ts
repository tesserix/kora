import * as ImagePicker from "expo-image-picker";
import { droppedFieldsNotice, pickScaleScreenshot, readFailureMessage } from "../bodyCompositionScan";

// See RecipeParseSheet.test.tsx's own comment: the real "@/lib/api" pulls in
// firebase/auth (real ESM) which Jest cannot parse unmocked. Only ApiError is
// needed here — it's the type readFailureMessage narrows on to route a
// status code to its own copy.
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
}));

beforeEach(() => {
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockReset();
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockReset();
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
});

describe("pickScaleScreenshot", () => {
  it("returns the picked file on success", async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file://scale.jpg", fileName: "scale.jpg", mimeType: "image/jpeg" }],
    });
    const outcome = await pickScaleScreenshot();
    expect(outcome).toEqual({
      status: "success",
      file: { uri: "file://scale.jpg", name: "scale.jpg", type: "image/jpeg" },
    });
  });

  it("reports denied without ever opening the picker", async () => {
    (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
    const outcome = await pickScaleScreenshot();
    expect(outcome).toEqual({ status: "denied" });
    expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
  });

  it("reports canceled when the user backs out of the picker", async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({ canceled: true });
    expect(await pickScaleScreenshot()).toEqual({ status: "canceled" });
  });

  it("reports failed rather than throwing when the picker itself errors", async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockRejectedValueOnce(new Error("native module crash"));
    expect(await pickScaleScreenshot()).toEqual({ status: "failed" });
  });
});

describe("droppedFieldsNotice", () => {
  it("renders nothing when nothing was dropped", () => {
    expect(droppedFieldsNotice([])).toBeNull();
  });

  it("names a single dropped field by its human label", () => {
    expect(droppedFieldsNotice([{ field: "bone_mass_kg", reason: "bone_mass_kg -3.1 is not positive" }])).toBe(
      "Your scale's bone mass didn't look right on that screenshot, so it was left out — check it below.",
    );
  });

  it("joins several dropped fields with a trailing 'and', pluralised", () => {
    const notice = droppedFieldsNotice([
      { field: "body_fat_pct", reason: "out of range" },
      { field: "protein_pct", reason: "out of range" },
    ]);
    expect(notice).toBe(
      "Your scale's body fat and protein didn't look right on that screenshot, so they were left out — check it below.",
    );
  });
});

describe("readFailureMessage", () => {
  const { ApiError } = jest.requireMock("@/lib/api");

  it("routes 422 to the unreadable-screenshot copy", () => {
    expect(readFailureMessage(new ApiError(422, "unreadable", "x"))).toMatch(/couldn't read anything/i);
  });

  it("routes 429 to the AI-limit copy with no retry offered", () => {
    expect(readFailureMessage(new ApiError(429, "budget_exhausted", "x"))).toMatch(/AI usage limit/i);
  });

  it("routes 503 to the unavailable copy", () => {
    expect(readFailureMessage(new ApiError(503, "unavailable", "x"))).toMatch(/isn't available right now/i);
  });

  it("falls back to a generic message for any other ApiError status", () => {
    expect(readFailureMessage(new ApiError(500, "internal", "x"))).toMatch(/couldn't read that screenshot/i);
  });

  it("treats a non-ApiError (network failure, timeout) as unreachable, not unreadable", () => {
    expect(readFailureMessage(new Error("fetch failed"))).toMatch(/couldn't reach kora/i);
  });
});
