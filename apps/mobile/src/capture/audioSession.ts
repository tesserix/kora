import { setAudioModeAsync } from "expo-audio";

/**
 * The iOS audio session has to be told a recording is coming.
 *
 * expo-audio does NOT configure this for you. The session's default category
 * permits playback but not capture, so `recorder.prepareToRecordAsync()` throws
 * on a device unless `allowsRecording` has been set first — which surfaced as
 * "Something went wrong starting the recording" the instant the user granted
 * the mic permission, on every attempt (kora#186). The app had never called
 * `setAudioModeAsync` anywhere, so voice capture could not have worked on iOS.
 *
 * `playsInSilentMode` is part of the same requirement, not a nicety: with the
 * ring/silent switch flipped — which is how a lot of people carry a phone — the
 * session is otherwise silenced and the capture yields nothing usable.
 *
 * This mirrors the recording example in expo-audio's own documentation for the
 * installed version (57.0.3, see `setAudioModeAsync` in ExpoAudio.d.ts).
 */
export async function beginRecordingSession(): Promise<void> {
  await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
}

/**
 * Hands the audio session back after a recording ends.
 *
 * Leaving `allowsRecording` on is not inert: iOS keeps the session in a capture
 * category, which attenuates playback and can route audio to the earpiece
 * rather than the speaker. The app would work but sound quietly broken to
 * anyone who played something afterwards.
 *
 * Best-effort by design. This runs on the success path of a recording the user
 * has already made, and a failure to restore playback mode must never turn a
 * good clip into an error message. The recording itself is the thing worth
 * surfacing failures about; the teardown is housekeeping.
 */
export async function endRecordingSession(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } catch {
    // Deliberately swallowed — see above.
  }
}
