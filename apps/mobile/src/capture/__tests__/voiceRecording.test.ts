import {
  CANCEL_DX,
  LOCK_DY,
  PRESS_ARM_MS,
  initialVoiceState,
  reduceVoice,
  shouldUpload,
} from "../voiceRecording";

function recording() {
  return reduceVoice(reduceVoice(initialVoiceState, { type: "press" }), { type: "armDelayElapsed" });
}

function locked() {
  return reduceVoice(recording(), { type: "pan", dx: 0, dy: LOCK_DY - 1 });
}

test("a press that is held past the arm delay starts recording", () => {
  const armed = reduceVoice(initialVoiceState, { type: "press" });
  expect(armed).toBe("armed");
  expect(reduceVoice(armed, { type: "armDelayElapsed" })).toBe("recording");
});

// A stray tap must NOT bill a fraction-of-a-second clip to a paid endpoint.
test("a press released before the arm delay never records", () => {
  const armed = reduceVoice(initialVoiceState, { type: "press" });
  const after = reduceVoice(armed, { type: "release" });
  expect(after).toBe("idle");
  expect(shouldUpload(after)).toBe(false);
});

test("sliding left past the cancel threshold discards the clip", () => {
  const cancelled = reduceVoice(recording(), { type: "pan", dx: CANCEL_DX - 1, dy: 0 });
  expect(cancelled).toBe("cancelled");
  expect(shouldUpload(cancelled)).toBe(false);
});

test("a slide short of the cancel threshold keeps recording", () => {
  expect(reduceVoice(recording(), { type: "pan", dx: CANCEL_DX + 1, dy: 0 })).toBe("recording");
});

test("swiping up past the lock threshold locks hands-free", () => {
  expect(reduceVoice(recording(), { type: "pan", dx: 0, dy: LOCK_DY - 1 })).toBe("locked");
});

test("a swipe short of the lock threshold keeps recording", () => {
  expect(reduceVoice(recording(), { type: "pan", dx: 0, dy: LOCK_DY + 1 })).toBe("recording");
});

test("releasing while locked does nothing — only Stop ends a locked recording", () => {
  const l = locked();
  expect(reduceVoice(l, { type: "release" })).toBe("locked");
  expect(reduceVoice(l, { type: "stop" })).toBe("finished");
});

test("releasing a held recording finishes it and uploads", () => {
  const finished = reduceVoice(recording(), { type: "release" });
  expect(finished).toBe("finished");
  expect(shouldUpload(finished)).toBe(true);
});

test("cancelling from the locked state does not upload", () => {
  const cancelled = reduceVoice(locked(), { type: "cancel" });
  expect(cancelled).toBe("cancelled");
  expect(shouldUpload(cancelled)).toBe(false);
});

// shouldUpload is the single gate in front of a paid transcription call, so it
// is pinned exhaustively rather than by example.
test("only the finished state ever uploads", () => {
  expect(shouldUpload("idle")).toBe(false);
  expect(shouldUpload("armed")).toBe(false);
  expect(shouldUpload("recording")).toBe(false);
  expect(shouldUpload("locked")).toBe(false);
  expect(shouldUpload("cancelled")).toBe(false);
  expect(shouldUpload("finished")).toBe(true);
});

test("thresholds match the spec", () => {
  expect(PRESS_ARM_MS).toBe(200);
  expect(CANCEL_DX).toBe(-80);
  expect(LOCK_DY).toBe(-60);
});
