import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { CameraView, useCameraPermissions } from "expo-camera";
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder } from "expo-audio";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { OttoBubble } from "@/components/capture/OttoBubble";
import { UserBubble } from "@/components/capture/UserBubble";
import { ModePill } from "@/components/capture/ModePill";
import { Waveform } from "@/components/capture/Waveform";
import { DetectedCard } from "@/components/capture/DetectedCard";
import { captureColors } from "@/components/capture/captureTheme";
import {
  useCreateLog,
  useProfile,
  useResolveBarcode,
  useResolvePhoto,
  useResolveText,
  useResolveVoice,
} from "@/api/hooks";
import { ApiError } from "@/lib/api";
import { kcalTotalLabel } from "@/lib/resolutionKcal";
import type { Resolution, ResolvedCandidate } from "@/api/types";
import { mealSlotForHour, type MealSlot } from "@/lib/mealSlot";

export type CaptureMode = "photo" | "voice" | "scan" | "type";
export type CaptureStage = "idle" | "analyzing" | "result";

const MODE_PILLS: ReadonlyArray<{ mode: CaptureMode; icon: string; label: string }> = [
  { mode: "photo", icon: "camera", label: "Photo" },
  { mode: "voice", icon: "mic", label: "Voice" },
  { mode: "scan", icon: "scan-barcode", label: "Scan" },
  { mode: "type", icon: "type", label: "Type" },
];

const ROUND_BUTTON = {
  width: 36,
  height: 36,
  borderRadius: 9999,
  backgroundColor: captureColors.pillBg,
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

// Rotating "loader" icon for the analyzing stage. Honors reduce-motion by
// freezing at 0deg instead of looping the rotation — mirrors the mockup's
// `tsx-spin` keyframes and Waveform's reduce-motion pattern.
function AnalyzingSpinner() {
  const [reducedMotion, setReducedMotion] = useState(false);
  const rotation = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setReducedMotion(enabled);
      })
      .catch(() => {
        if (!cancelled) setReducedMotion(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      rotation.setValue(0);
      return undefined;
    }
    const animation = Animated.loop(
      Animated.timing(rotation, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }),
    );
    animation.start();
    return () => animation.stop();
  }, [reducedMotion, rotation]);

  const spin = rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });

  return (
    <Animated.View testID="capture-analyzing-spinner" style={{ transform: [{ rotate: spin }] }}>
      <Icon name="loader" size={16} color={captureColors.primary} />
    </Animated.View>
  );
}

interface IdleAffordanceProps {
  mode: CaptureMode;
  onCapturePhoto: () => void;
  isRecordingVoice: boolean;
  onToggleVoice: () => void;
  cameraPermissionGranted: boolean;
  onBarcodeScanned: (data: string) => void;
}

// The per-mode "empty" affordance shown in the thread before a capture
// starts. Photo, voice, and scan all wire into their real capture flows;
// type falls through to the static prompt bubble below.
function IdleAffordance({
  mode,
  onCapturePhoto,
  isRecordingVoice,
  onToggleVoice,
  cameraPermissionGranted,
  onBarcodeScanned,
}: IdleAffordanceProps) {
  if (mode === "photo") {
    return (
      <Pressable
        testID="capture-idle-photo"
        accessibilityRole="button"
        accessibilityLabel="Photo viewfinder"
        onPress={onCapturePhoto}
        style={{
          height: 200,
          borderRadius: 20,
          overflow: "hidden",
          backgroundColor: captureColors.viewfinderBg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="utensils" size={54} color={captureColors.viewfinderIcon} />
        <View
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            right: 10,
            bottom: 10,
            borderWidth: 2,
            borderStyle: "dashed",
            borderColor: "rgba(0,0,0,0.12)",
            borderRadius: 20,
          }}
        />
        <View style={{ position: "absolute", bottom: 12, left: 0, right: 0 }}>
          <AppText style={{ textAlign: "center", color: captureColors.viewfinderCaption, fontSize: 13, fontWeight: "600" }}>
            Tap the viewfinder to capture
          </AppText>
        </View>
      </Pressable>
    );
  }

  if (mode === "voice") {
    return (
      <View
        testID="capture-idle-voice"
        style={{
          height: 200,
          borderRadius: 20,
          backgroundColor: captureColors.bubbleBg,
          borderWidth: 1,
          borderColor: captureColors.bubbleBorder,
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isRecordingVoice ? "Stop recording" : "Start recording"}
          onPress={onToggleVoice}
          style={{
            width: 72,
            height: 72,
            borderRadius: 9999,
            backgroundColor: captureColors.primary,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 10,
            borderColor: captureColors.primaryGlow,
          }}
        >
          <Icon name="mic" size={30} color={captureColors.primaryForeground} />
        </Pressable>
        <Waveform active={isRecordingVoice} />
        <AppText style={{ color: captureColors.onSurfaceMuted, fontSize: 13, fontWeight: "600" }}>
          {isRecordingVoice ? "Listening… tell Otto what you ate" : "Tap the mic to start"}
        </AppText>
      </View>
    );
  }

  if (mode === "scan") {
    return (
      <View
        testID="capture-idle-scan"
        style={{
          height: 200,
          borderRadius: 20,
          backgroundColor: captureColors.bubbleBg,
          borderWidth: 1,
          borderColor: captureColors.bubbleBorder,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <View
          style={{
            width: 200,
            height: 110,
            borderRadius: 12,
            borderWidth: 2,
            borderColor: captureColors.outlineBorder,
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          {cameraPermissionGranted ? (
            // No camera on the iOS simulator — this renders but won't scan
            // there; live barcode detection is device-only (see report).
            <CameraView
              testID="capture-camera-view"
              style={{ width: "100%", height: "100%" }}
              barcodeScannerSettings={{ barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e"] }}
              onBarcodeScanned={({ data }) => onBarcodeScanned(data)}
            />
          ) : (
            <>
              <Icon name="barcode" size={64} color={captureColors.onSurfaceFaint} />
              <View
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: "50%",
                  height: 2,
                  backgroundColor: captureColors.primary,
                }}
              />
            </>
          )}
        </View>
        <AppText style={{ marginTop: 12, color: captureColors.onSurfaceMuted, fontSize: 13, fontWeight: "600" }}>
          Point at a barcode
        </AppText>
      </View>
    );
  }

  return (
    <View testID="capture-idle-type">
      <UserBubble>Grilled chicken with broccoli and brown rice</UserBubble>
    </View>
  );
}

type ResultView = "card" | "followUp" | "empty";

// Which of the three result presentations applies to a given resolution.
// A follow-up question always wins when present (the server is explicitly
// asking for clarification); otherwise an empty candidate list falls back to
// the generic "couldn't identify that" state; anything else has candidates
// worth showing in the DetectedCard.
function resolveResultView(resolution: Resolution): ResultView {
  if (resolution.tier === "follow_up" && resolution.follow_up_question) {
    return "followUp";
  }
  if (resolution.candidates.length === 0) {
    return "empty";
  }
  return "card";
}

// The Otto summary bubble shown above the DetectedCard — total kcal is the
// server-reported estimate range when `is_estimate`, otherwise the sum of
// the candidates' own kcal (never a client-side recompute of nutrition).
function resultSummary(resolution: Resolution): string {
  const count = resolution.candidates.length;
  const itemWord = count === 1 ? "item" : "items";
  const kcalText = kcalTotalLabel(resolution);
  return `I found ${count} ${itemWord}, about ${kcalText} — confirm and I'll log it.`;
}

// Maps a capture mode to the food-log `source` value. "scan" reads as a
// barcode lookup and "type" as free text; the rest are literally "ai_<mode>".
export function sourceForMode(mode: CaptureMode): string {
  if (mode === "scan") return "ai_barcode";
  if (mode === "type") return "ai_text";
  return `ai_${mode}`;
}

// A stable per-candidate key for tracking add-to-diary success across retry
// attempts. Combines the candidate's position (stable for the lifetime of a
// single resolution) with its food_item_id (in case ids ever duplicate) so
// two candidates never collide.
function candidateKey(candidate: ResolvedCandidate, index: number): string {
  return `${index}:${candidate.item.id}`;
}

// The fallback link shown alongside a follow-up question or an unidentified
// result — routes to the manual search/log screen instead of the AI flow.
function SearchManuallyLink({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Search manually"
      onPress={onPress}
      style={(state) => ({
        alignSelf: "flex-start",
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderRadius: 9999,
        borderWidth: 1,
        borderColor: captureColors.outlineBorder,
        opacity: state.pressed ? 0.7 : 1,
      })}
    >
      <AppText style={{ color: captureColors.onSurface, fontSize: 14, fontWeight: "600" }}>Search manually</AppText>
    </Pressable>
  );
}

interface CaptureBodyProps {
  displayName: string;
  insetTop: number;
  insetBottom: number;
  mode: CaptureMode;
  onModeChange: (mode: CaptureMode) => void;
  stage: CaptureStage;
  resolution: Resolution | null;
  errorMsg: string | null;
  mealSlot: MealSlot;
  onChangeMealSlot: (slot: MealSlot) => void;
  onAdd: () => void;
  adding: boolean;
  onSearchManually: () => void;
  text: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onCapturePhoto: () => void;
  isRecordingVoice: boolean;
  onToggleVoice: () => void;
  cameraPermissionGranted: boolean;
  onBarcodeScanned: (data: string) => void;
  onClose: () => void;
}

// Presentational capture surface — pure props in, no state, no API calls.
// Exported (in addition to the default route) so the result/analyzing stages
// can be exercised directly in tests without simulating a full capture flow.
export function CaptureBody({
  displayName,
  insetTop,
  insetBottom,
  mode,
  onModeChange,
  stage,
  resolution,
  errorMsg,
  mealSlot,
  onChangeMealSlot,
  onAdd,
  adding,
  onSearchManually,
  text,
  onChangeText,
  onSend,
  onCapturePhoto,
  isRecordingVoice,
  onToggleVoice,
  cameraPermissionGranted,
  onBarcodeScanned,
  onClose,
}: CaptureBodyProps) {
  const scrollViewRef = useRef<ScrollView>(null);
  const resultView = resolution ? resolveResultView(resolution) : null;

  // Bring the newest Otto message (an error bubble or the detected-food
  // result) into view — on short viewports or with the keyboard open, the
  // in-thread bubble can otherwise land below the fold with no signal.
  useEffect(() => {
    if (errorMsg || resolution) {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }
  }, [errorMsg, resolution]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: captureColors.surface }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 18,
          paddingBottom: 10,
          paddingTop: insetTop + 8,
        }}
      >
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={ROUND_BUTTON}>
          <Icon name="x" size={20} color={captureColors.onSurface} />
        </Pressable>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Icon name="camera" size={17} color={captureColors.primary} />
          <AppText style={{ color: captureColors.onSurface, fontWeight: "700" }}>Ask Otto</AppText>
        </View>
        {/* Reserved for a future gallery/history view — no-op in this task,
            hidden from screen readers so they don't focus a dead button. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Photo library"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={() => {}}
          style={ROUND_BUTTON}
        >
          <Icon name="images" size={18} color={captureColors.onSurface} />
        </Pressable>
      </View>

      <ScrollView
        ref={scrollViewRef}
        contentContainerStyle={{ padding: 18, paddingTop: 8, gap: 14 }}
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
      >
        <OttoBubble>
          Hi {displayName} — show me your meal or just tell me what you ate. A photo works great. 📷 is optional; words
          work too.
        </OttoBubble>

        {stage === "idle" && (
          <IdleAffordance
            mode={mode}
            onCapturePhoto={onCapturePhoto}
            isRecordingVoice={isRecordingVoice}
            onToggleVoice={onToggleVoice}
            cameraPermissionGranted={cameraPermissionGranted}
            onBarcodeScanned={onBarcodeScanned}
          />
        )}

        {stage === "analyzing" && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 40 }}>
            <AnalyzingSpinner />
            <AppText style={{ color: captureColors.onSurfaceMuted, fontSize: 13 }}>Otto is analyzing…</AppText>
          </View>
        )}

        {stage === "result" && resolution && resultView === "card" && (
          <>
            <OttoBubble>{resultSummary(resolution)}</OttoBubble>
            <DetectedCard
              resolution={resolution}
              mealSlot={mealSlot}
              onChangeMealSlot={onChangeMealSlot}
              onAdd={onAdd}
              adding={adding}
            />
          </>
        )}

        {stage === "result" && resolution && resultView === "followUp" && (
          <>
            <OttoBubble>{resolution.follow_up_question}</OttoBubble>
            <SearchManuallyLink onPress={onSearchManually} />
          </>
        )}

        {stage === "result" && resolution && resultView === "empty" && (
          <>
            <OttoBubble>I couldn&apos;t identify that — try again or search manually.</OttoBubble>
            <SearchManuallyLink onPress={onSearchManually} />
          </>
        )}

        {errorMsg ? <OttoBubble>{errorMsg}</OttoBubble> : null}
      </ScrollView>

      <View
        style={{
          paddingHorizontal: 14,
          paddingTop: 10,
          paddingBottom: Math.max(insetBottom, 12),
          backgroundColor: captureColors.composerBg,
          borderTopWidth: 1,
          borderTopColor: captureColors.composerBorder,
        }}
      >
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
          {MODE_PILLS.map(({ mode: m, icon, label }) => (
            <ModePill key={m} icon={icon} label={label} active={mode === m} onPress={() => onModeChange(m)} />
          ))}
        </View>

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            backgroundColor: captureColors.pillBg,
            borderRadius: 9999,
            paddingVertical: 6,
            paddingHorizontal: 6,
            paddingLeft: 8,
          }}
        >
          {/* Quick-capture shortcut — triggers the same camera/library flow as the idle viewfinder. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Quick photo capture"
            onPress={onCapturePhoto}
            style={{
              width: 38,
              height: 38,
              borderRadius: 9999,
              backgroundColor: captureColors.primary,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="camera" size={19} color={captureColors.primaryForeground} />
          </Pressable>
          <TextInput
            accessibilityLabel="Tell Otto what you ate"
            value={text}
            onChangeText={onChangeText}
            placeholder="Tell Otto what you ate…"
            placeholderTextColor={captureColors.onSurfaceFaint}
            style={{ flex: 1, color: captureColors.onSurface, fontSize: 15 }}
          />
          {/* Send — resolves the typed phrase via useResolveText. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            accessibilityState={{ disabled: !text.trim() }}
            disabled={!text.trim()}
            onPress={onSend}
            style={{
              width: 38,
              height: 38,
              borderRadius: 9999,
              backgroundColor: text.trim() ? captureColors.primary : "rgba(255,255,255,0.15)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="arrow-up" size={19} color={captureColors.onSurface} />
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

type PhotoFile = { uri: string; name: string; type: string };

type PhotoPickOutcome =
  | { status: "success"; file: PhotoFile }
  | { status: "canceled" }
  | { status: "denied" }
  | { status: "failed" };

// Camera first, library as fallback — matches the sim (no camera hardware,
// so launchCameraAsync throws) and a user who denies camera but allows
// photo library access. Only a genuine permission denial (both camera *and*
// library) is reported as "denied"; a user-canceled picker is silent. The
// outer try/catch is a last-resort net: ANY unexpected throw (e.g. a native
// error from the library permission check or launch, not just the camera)
// must still surface an Otto bubble rather than fail silently.
async function pickMealPhoto(): Promise<PhotoPickOutcome> {
  try {
    const cameraPermission = await ImagePicker.requestCameraPermissionsAsync();
    let result: ImagePicker.ImagePickerResult | undefined;

    if (cameraPermission.granted) {
      try {
        result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.7 });
      } catch {
        result = undefined; // no camera hardware available — fall back to the library below
      }
    }

    if (!result) {
      const libraryPermission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!libraryPermission.granted) {
        return { status: "denied" };
      }
      result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.7 });
    }

    if (result.canceled) {
      return { status: "canceled" };
    }
    const asset = result.assets[0];
    if (!asset) {
      return { status: "canceled" };
    }
    return {
      status: "success",
      file: { uri: asset.uri, name: asset.fileName ?? "meal.jpg", type: asset.mimeType ?? "image/jpeg" },
    };
  } catch {
    return { status: "failed" };
  }
}

function ottoErrorMessage(error: Error): string {
  if (error instanceof ApiError) {
    return `Hmm, I couldn't tell — ${error.message}. Mind trying again?`;
  }
  return "Something went wrong while I looked at that. Please try again.";
}

export default function CaptureScreen() {
  const insets = useSafeAreaInsets();
  const profile = useProfile();
  const resolveText = useResolveText();
  const resolvePhoto = useResolvePhoto();
  const resolveVoice = useResolveVoice();
  const resolveBarcode = useResolveBarcode();
  const createLog = useCreateLog();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [mode, setMode] = useState<CaptureMode>("photo");
  // idle<->result is driven by the four capture flows below; "analyzing" is
  // derived from the mutations' isPending rather than tracked separately.
  const [stage, setStage] = useState<CaptureStage>("idle");
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mealSlot, setMealSlot] = useState<MealSlot>(() => mealSlotForHour(new Date().getHours()));
  const [adding, setAdding] = useState(false);
  // Candidate keys (see candidateKey) already logged successfully across
  // add-to-diary attempts for the *current* resolution — reset whenever a
  // fresh resolution replaces it, so a retry only re-submits what actually
  // failed instead of re-logging (duplicating) the ones that already succeeded.
  const [loggedCandidateKeys, setLoggedCandidateKeys] = useState<Set<string>>(new Set());
  const [text, setText] = useState("");
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  // Guards a single CameraView against firing onBarcodeScanned repeatedly
  // for the same physical scan while the camera keeps detecting the code.
  const scannedRef = useRef(false);

  const displayStage: CaptureStage =
    resolveText.isPending || resolvePhoto.isPending || resolveVoice.isPending || resolveBarcode.isPending
      ? "analyzing"
      : stage;

  // Request camera access as soon as the user switches into Scan mode; a
  // denial surfaces as an Otto bubble rather than a silently blank viewfinder.
  useEffect(() => {
    if (mode !== "scan" || cameraPermission?.granted) return;
    requestCameraPermission()
      .then((result) => {
        if (!result.granted) {
          setErrorMsg("I need camera access to scan barcodes.");
        }
      })
      .catch(() => {
        setErrorMsg("Something went wrong turning on the camera — please try again.");
      });
    // Only re-check on a mode change into "scan" — requestCameraPermission's
    // own hook state (cameraPermission) updates independently and re-running
    // this on every state change would re-prompt in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Mirrors isRecordingVoice into a ref so the unmount-cleanup effect below
  // (which only runs once, with a closure from mount time) can still read
  // the *latest* recording state instead of the stale `false` it started with.
  const isRecordingVoiceRef = useRef(false);
  useEffect(() => {
    isRecordingVoiceRef.current = isRecordingVoice;
  }, [isRecordingVoice]);

  // Best-effort: if the screen unmounts (e.g. the user backs out via Close)
  // while a voice recording is still live, stop it rather than leaving the
  // mic recording indefinitely. Never throws — a stop failure on the way out
  // isn't worth surfacing, there's no screen left to show an Otto bubble on.
  useEffect(() => {
    return () => {
      if (isRecordingVoiceRef.current) {
        recorder.stop().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Applies a newly-resolved capture result and clears any add-to-diary
  // success tracking from a previous resolution — a fresh capture always
  // starts with a clean retry slate.
  function applyResolution(data: Resolution) {
    setResolution(data);
    setStage("result");
    setLoggedCandidateKeys(new Set());
  }

  function handleModeChange(next: CaptureMode) {
    // Switching away from Voice mid-recording must not leave the native
    // recorder running in the background — stop it (best-effort) and reset
    // the mic button back to its start state.
    if (next !== "voice" && isRecordingVoice) {
      recorder.stop().catch(() => {});
      setIsRecordingVoice(false);
    }
    setMode(next);
    setStage("idle");
    setErrorMsg(null);
    scannedRef.current = false;
  }

  function handleSend() {
    const phrase = text.trim();
    if (!phrase) return;
    setErrorMsg(null);
    // Fires right as send is pressed — the composer's own keyboard should
    // not stay up covering the result thread once a send is in flight.
    Keyboard.dismiss();
    resolveText.mutate(phrase, {
      onSuccess: (data) => {
        applyResolution(data);
        setText("");
      },
      onError: (error) => setErrorMsg(ottoErrorMessage(error)),
    });
  }

  async function handleCapturePhoto() {
    setErrorMsg(null);
    const outcome = await pickMealPhoto();
    if (outcome.status === "canceled") return;
    if (outcome.status === "denied") {
      setErrorMsg("I need camera or photo access to see your meal.");
      return;
    }
    if (outcome.status === "failed") {
      setErrorMsg("Something went wrong opening your photos — try again.");
      return;
    }
    resolvePhoto.mutate(outcome.file, {
      onSuccess: (data) => applyResolution(data),
      onError: (error) => setErrorMsg(ottoErrorMessage(error)),
    });
  }

  // Stop path first (recorder.stop() can throw — a "real" failure, not just
  // a denial — so both branches surface an Otto bubble rather than failing
  // silently, mirroring pickMealPhoto's discipline above).
  async function handleToggleVoice() {
    setErrorMsg(null);

    if (isRecordingVoice) {
      try {
        await recorder.stop();
      } catch {
        setIsRecordingVoice(false);
        setErrorMsg("Something went wrong recording that — please try again.");
        return;
      }
      setIsRecordingVoice(false);
      const uri = recorder.uri;
      if (!uri) {
        setErrorMsg("I didn't catch that — mind trying again?");
        return;
      }
      resolveVoice.mutate(
        { uri, name: "clip.m4a", type: "audio/mp4" },
        {
          onSuccess: (data) => applyResolution(data),
          onError: (error) => setErrorMsg(ottoErrorMessage(error)),
        },
      );
      return;
    }

    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setErrorMsg("I need mic access to hear what you ate.");
        return;
      }
      await recorder.prepareToRecordAsync();
      recorder.record();
      setIsRecordingVoice(true);
    } catch {
      setErrorMsg("Something went wrong starting the recording — please try again.");
    }
  }

  function handleBarcodeScanned(data: string) {
    if (scannedRef.current) return;
    scannedRef.current = true;
    setErrorMsg(null);
    resolveBarcode.mutate(data, {
      onSuccess: (result) => applyResolution(result),
      onError: (error) => {
        setErrorMsg(ottoErrorMessage(error));
        scannedRef.current = false;
      },
    });
  }

  // Logs every not-yet-succeeded candidate in the current resolution as its
  // own diary entry. Only the id/grams/slot/source/timestamp quintet is ever
  // sent — the backend recomputes kcal/macros from the food_item row. Uses
  // allSettled (not Promise.all) so a single failing candidate doesn't hide
  // whether the *other* candidates were logged — required to avoid a
  // partial silent success per the task's error-handling discipline.
  //
  // Candidates already recorded in `loggedCandidateKeys` (from an earlier
  // press of this same card) are skipped entirely — otherwise re-pressing
  // "Add to diary" after a partial failure would re-log the ones that
  // already succeeded, duplicating diary entries.
  async function handleAddToDiary() {
    if (!resolution || resolution.candidates.length === 0) return;
    setErrorMsg(null);
    setAdding(true);
    const source = sourceForMode(mode);

    const pending = resolution.candidates
      .map((candidate, index) => ({ candidate, key: candidateKey(candidate, index) }))
      .filter(({ key }) => !loggedCandidateKeys.has(key));

    const outcomes = await Promise.allSettled(
      pending.map(({ candidate }) =>
        createLog.mutateAsync({
          food_item_id: candidate.item.id,
          quantity_grams: candidate.portion_grams,
          meal_slot: mealSlot,
          source,
          logged_at: new Date().toISOString(),
        }),
      ),
    );
    setAdding(false);

    const newlySucceededKeys = pending
      .filter((_, index) => outcomes[index]?.status === "fulfilled")
      .map(({ key }) => key);
    const failedNames = pending
      .filter((_, index) => outcomes[index]?.status === "rejected")
      .map(({ candidate }) => candidate.item.name);

    const updatedKeys = new Set([...loggedCandidateKeys, ...newlySucceededKeys]);
    setLoggedCandidateKeys(updatedKeys);

    if (failedNames.length > 0) {
      setErrorMsg(
        `I logged ${updatedKeys.size} of ${resolution.candidates.length} items, but couldn't log ${failedNames.join(
          ", ",
        )}. Please try again.`,
      );
      return;
    }

    router.back();
  }

  return (
    <View style={{ flex: 1, backgroundColor: captureColors.surface }}>
      <CaptureBody
        displayName={profile.data?.display_name?.trim().split(" ")[0] || "there"}
        insetTop={insets.top}
        insetBottom={insets.bottom}
        mode={mode}
        onModeChange={handleModeChange}
        stage={displayStage}
        resolution={resolution}
        errorMsg={errorMsg}
        mealSlot={mealSlot}
        onChangeMealSlot={setMealSlot}
        onAdd={handleAddToDiary}
        adding={adding}
        onSearchManually={() => router.push("/log")}
        text={text}
        onChangeText={setText}
        onSend={handleSend}
        onCapturePhoto={handleCapturePhoto}
        isRecordingVoice={isRecordingVoice}
        onToggleVoice={handleToggleVoice}
        cameraPermissionGranted={cameraPermission?.granted ?? false}
        onBarcodeScanned={handleBarcodeScanned}
        onClose={() => router.back()}
      />
    </View>
  );
}
