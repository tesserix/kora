import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  AppState,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { safeBack } from "@/lib/safeBack";
import * as ImagePicker from "expo-image-picker";
import { CameraView, useCameraPermissions } from "expo-camera";
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder } from "expo-audio";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { OttoBubble } from "@/components/capture/OttoBubble";
import { PlanCard } from "@/components/capture/PlanCard";
import { UserBubble } from "@/components/capture/UserBubble";
import { ModePill } from "@/components/capture/ModePill";
import { Waveform } from "@/components/capture/Waveform";
import { VoiceComposer } from "@/components/capture/VoiceComposer";
import { beginRecordingSession, endRecordingSession } from "@/capture/audioSession";
import { reportError } from "@/observability/reporter";
import { ResolutionResult } from "@/components/ResolutionResult";
import { FoodPicker } from "@/components/meal/FoodPicker";
import { withAlpha } from "@/lib/color";
import { useToast } from "@/components/Toast";
import { INSTRUMENT_DARK_FIXED } from "@/theme";
import { haptics, PressableScale, useMotionPrefs } from "@/motion";
import {
  useAcceptMealPlan,
  useCreateLog,
  useProfile,
  useResolveBarcode,
  useResolvePhoto,
  useCaptureMessage,
  useResolveVoice,
} from "@/api/hooks";
import { ApiError, AuthTokenError, NetworkError, ResponseParseError, TimeoutError } from "@/lib/api";
import { OfflineUnknownBarcodeError } from "@/offline/cachedResolution";
import { CaptureQueueFullError } from "@/offline/captureQueue";
import { enqueueCapture, enqueueTextCapture, type CaptureFile } from "@/offline/enqueueCapture";
import { NoOwnerError } from "@/offline/owner";
import { QUEUED_CAPTURES_KEY } from "@/offline/queryKeys";
import { isLoggable } from "@/lib/candidateTier";
import { runRetryLedger } from "@/lib/retryLedger";
import { servingEntryFor } from "@/units/portion";
import type { FoodItem, MealPlanProposal, Resolution, ResolutionSource } from "@/api/types";
import { mealSlotForHour, type MealSlot } from "@/lib/mealSlot";
import { initialPortionFor } from "@/lib/promotedPortion";

export type CaptureMode = "photo" | "voice" | "scan" | "type";
export type CaptureStage = "idle" | "analyzing" | "result";

// The food-log `source` value. Stamped from whichever resolve actually
// produced the current resolution (see applyResolution) — never from the
// capture tab that happened to be open, since the composer is reachable from
// every tab and a user can type on the Photo tab, etc.
//
// Defined in src/api/types.ts (the server's actual allowlist) and re-exported
// here so every existing importer of `ResolutionSource` from this module
// keeps working unchanged.
export type { ResolutionSource };

// Instrument Glass, dark-fixed. Capture is exempt from theming (spec: "Dark
// capture screen is exempt from theming: camera surfaces are always dark"),
// so every chrome color below comes from the INSTRUMENT_DARK_FIXED constant
// — never from useTheme().instrument, which would follow the device's
// light/dark scheme and go light. The chat bubbles/waveform/voice composer
// are now also migrated to INSTRUMENT_DARK_FIXED (see OttoBubble, UserBubble,
// Waveform, VoiceComposer) rather than the older fixed capture palette,
// which has been deleted now that nothing references it.
const T = INSTRUMENT_DARK_FIXED;

// How long a cancelled barcode is suppressed from re-triggering a resolve of
// its own accord (see cancelledCodeRef above). Long enough to outlast the
// code still sitting in frame at the moment Cancel is pressed, short enough
// that the scanner isn't left deaf to a legitimately re-presented code.
const CANCELLED_CODE_COOLDOWN_MS = 2000;

const MODE_PILLS: ReadonlyArray<{ mode: CaptureMode; icon: string; label: string }> = [
  { mode: "photo", icon: "camera", label: "Photo" },
  { mode: "voice", icon: "mic", label: "Voice" },
  { mode: "scan", icon: "scan-barcode", label: "Scan" },
  { mode: "type", icon: "type", label: "Type" },
];

// The composer's left control, per mode. Voice is absent because it renders
// VoiceComposer instead of a plain Pressable.
//
// One rule, no exceptions: the button mirrors the active mode and does what
// that mode's icon implies. Photo captures, Scan scans, Type focuses the field.
//
// This went through two wrong answers first. `camera` in Type duplicated the
// Photo icon; `images` was distinguishable but still promised a photo action in
// a text mode. Both were attempts to preserve a quick-capture shortcut that
// simply does not belong under a keyboard glyph — an icon that lies about its
// behaviour is worse than a lost shortcut.
export const COMPOSER_BUTTON: Record<Exclude<CaptureMode, "voice">, { icon: string; label: string }> = {
  photo: { icon: "camera", label: "Quick photo capture" },
  scan: { icon: "scan-barcode", label: "Scan a barcode" },
  type: { icon: "keyboard", label: "Focus the message field" },
};

// The server refuses a shorter phrase outright (ResolveText in
// api/internal/resolve/handler.go), so the client agrees with it at the point
// of send. Without this a single character could be typed offline, queued, and
// then 400 on every drain until it was marked permanently failed — since
// kora#196 that is a persisted row the user has to deal with, not an error
// bubble that scrolls away (kora#243).
//
// Deliberately NOT enforced in captureQueue's isValid: that is the upgrade
// contract, not the entry rule, and tightening it there would silently delete
// single-character rows an older build already queued.
export const MIN_PHRASE_CHARS = 2;

const ROUND_BUTTON = {
  width: 36,
  height: 36,
  borderRadius: 9999,
  backgroundColor: T.glass,
  borderWidth: 1,
  borderColor: T.glassBorder,
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

// Rotating "loader" icon for the analyzing stage. Honors reduce-motion by
// freezing at 0deg instead of looping the rotation — mirrors the mockup's
// `tsx-spin` keyframes and Waveform's reduce-motion pattern.
function AnalyzingSpinner() {
  // useMotionPrefs, not a mount-only AccessibilityInfo.isReduceMotionEnabled()
  // query: that read the preference once and never subscribed to
  // `reduceMotionChanged`, so turning Reduce Motion on mid-session left this
  // spinning until the next mount. Same fix as Waveform.
  const { reduceMotion } = useMotionPrefs();
  const rotation = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) {
      rotation.setValue(0);
      return undefined;
    }
    const animation = Animated.loop(
      Animated.timing(rotation, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }),
    );
    animation.start();
    return () => animation.stop();
  }, [reduceMotion, rotation]);

  const spin = rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });

  return (
    <Animated.View testID="capture-analyzing-spinner" style={{ transform: [{ rotate: spin }] }}>
      <Icon name="loader" size={16} color={T.accent} />
    </Animated.View>
  );
}

// Lume reticle corners + a static accent scan line over the photo viewfinder
// (spec: Screens.3, Capture — "Lume reticle corners + accent scan line over
// the viewfinder"). Four 34pt corner Views, each showing only its two outer
// edges (a 2.5px border on those two sides, radius 10 on the outer corner),
// plus one 1.5px horizontal accent line at the vertical center. No
// animation — this is a static instrument marking, not a scanning effect.
function ViewfinderReticle() {
  const CORNER = 34;
  const BORDER = 2.5;
  const RADIUS = 10;
  const corner = {
    position: "absolute" as const,
    width: CORNER,
    height: CORNER,
    borderColor: withAlpha(T.ink, 0.9),
  };
  return (
    <>
      <View
        testID="viewfinder-corner-tl"
        style={[corner, { top: 10, left: 10, borderTopWidth: BORDER, borderLeftWidth: BORDER, borderTopLeftRadius: RADIUS }]}
      />
      <View
        testID="viewfinder-corner-tr"
        style={[corner, { top: 10, right: 10, borderTopWidth: BORDER, borderRightWidth: BORDER, borderTopRightRadius: RADIUS }]}
      />
      <View
        testID="viewfinder-corner-bl"
        style={[corner, { bottom: 10, left: 10, borderBottomWidth: BORDER, borderLeftWidth: BORDER, borderBottomLeftRadius: RADIUS }]}
      />
      <View
        testID="viewfinder-corner-br"
        style={[corner, { bottom: 10, right: 10, borderBottomWidth: BORDER, borderRightWidth: BORDER, borderBottomRightRadius: RADIUS }]}
      />
      <View
        testID="viewfinder-scan-line"
        style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 1.5, backgroundColor: T.accent }}
      />
    </>
  );
}

// A denied camera/mic permission used to be a dead end — the affordance kept
// pretending it could still capture (see the fake barcode scan line this
// replaced). This is the ONE recovery surface reused across all three denial
// sites (Scan's camera, Photo's camera/library, Voice's mic): a plain
// explanation, a primary route to the OS Settings pane (the only place a
// re-prompt can come from once iOS has denied it), and a secondary route
// that keeps the capture going without a camera or mic at all — describing
// the meal in words. Mirrors the pattern already used for denied
// notification permission (src/reminders/notificationAccess.ts's "Open
// Settings" toast action) rather than inventing a second style.
interface PermissionDeniedProps {
  message: string;
  /** Icon name matching the permission this denial is about — "barcode" for
   *  Scan, "camera" for Photo, "mic" for Voice — so the card still reads as
   *  belonging to the mode it replaced, not a single generic dead end. */
  icon: string;
  onDescribeInstead: () => void;
  /** Only the CAMERA denial passes this: the photo library is a real
   *  alternative there, and offering it as a labelled choice is what stops it
   *  being the surprise prompt of kora#201. A denied LIBRARY has no such
   *  second route, so it omits this and keeps two actions. */
  onChooseFromLibrary?: () => void;
}

function PermissionDenied({ message, icon, onDescribeInstead, onChooseFromLibrary }: PermissionDeniedProps) {
  return (
    <View
      testID="capture-permission-denied"
      style={{
        // minHeight, not height: the camera denial carries a THIRD action
        // ("Choose from library", kora#201) and a fixed 200 clipped it against
        // the card's own bottom edge. A floor keeps every other denial card
        // exactly the size it was.
        minHeight: 200,
        paddingVertical: 20,
        borderRadius: 20,
        backgroundColor: T.glass,
        borderWidth: 1,
        borderColor: T.glassBorder,
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        paddingHorizontal: 24,
      }}
    >
      <Icon name={icon} size={40} color={T.mut} />
      <AppText style={{ color: T.mut, fontSize: 13, fontWeight: "600", textAlign: "center" }}>
        {message}
      </AppText>
      {/* Primary action — the only place a re-prompt can come from once iOS
          has denied a permission once, so accent is correct here. */}
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Open Settings"
        onPress={() => void Linking.openSettings()}
        style={{
          backgroundColor: T.accent,
          paddingHorizontal: 20,
          paddingVertical: 10,
          borderRadius: 9999,
        }}
      >
        <AppText style={{ color: T.accentOn, fontWeight: "700", fontSize: 14 }}>Open Settings</AppText>
      </PressableScale>
      {/* Present only for a denied camera. Not accent — Open Settings is the
          route that actually fixes the problem; this one works around it. */}
      {onChooseFromLibrary ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose from library"
          onPress={onChooseFromLibrary}
          style={(s) => ({ opacity: s.pressed ? 0.6 : 1 })}
        >
          <AppText style={{ color: T.mut, fontSize: 13, fontWeight: "600", textDecorationLine: "underline" }}>
            Choose from library
          </AppText>
        </Pressable>
      ) : null}
      {/* Secondary route — not accent. Text resolution needs no camera, so a
          denied permission still doesn't have to be a dead end. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Describe it instead"
        onPress={onDescribeInstead}
        style={(s) => ({ opacity: s.pressed ? 0.6 : 1 })}
      >
        <AppText style={{ color: T.mut, fontSize: 13, fontWeight: "600", textDecorationLine: "underline" }}>
          Describe it instead
        </AppText>
      </Pressable>
    </View>
  );
}

interface IdleAffordanceProps {
  mode: CaptureMode;
  onCapturePhoto: () => void;
  isRecordingVoice: boolean;
  cameraPermissionGranted: boolean;
  cameraPermissionDenied: boolean;
  /** Set once expo-image-picker's camera+library request has actually come
   *  back denied (see handleCapturePhoto) — Photo has no equivalent of
   *  useCameraPermissions' proactive hook, so this is only known after a tap. */
  photoPermissionDenied: boolean;
  /** Photo mode's own camera denial (kora#201). Separate from
   *  `cameraPermissionDenied`, which Scan reads: this one is ALSO set by a
   *  tap whose request came back denied, so the composer's photo button
   *  reaches the same explanation the viewfinder does. */
  cameraForPhotoDenied: boolean;
  onChooseFromLibrary: () => void;
  /** Set once expo-audio's requestRecordingPermissionsAsync has actually come
   *  back denied (see handleStartVoice) — same "only known after a tap" story
   *  as photoPermissionDenied. */
  micPermissionDenied: boolean;
  onBarcodeScanned: (data: string) => void;
  onDescribeInstead: () => void;
}

// The per-mode "empty" affordance shown in the thread before a capture
// starts. Photo, voice, and scan all wire into their real capture flows;
// type falls through to the static prompt bubble below.
function IdleAffordance({
  mode,
  onCapturePhoto,
  isRecordingVoice,
  cameraPermissionGranted,
  cameraPermissionDenied,
  photoPermissionDenied,
  cameraForPhotoDenied,
  onChooseFromLibrary,
  micPermissionDenied,
  onBarcodeScanned,
  onDescribeInstead,
}: IdleAffordanceProps) {
  if (mode === "photo") {
    // Camera first: it is the permission the affordance actually promises, so
    // it gets named. Checked BEFORE any tap — a tappable viewfinder over a
    // camera the user switched off is the false affordance of kora#201.
    if (cameraForPhotoDenied) {
      return (
        <PermissionDenied
          message="Camera access is off, so I can't see your meal. Turn it on in Settings, choose an existing photo, or tell me what you ate."
          icon="camera"
          onDescribeInstead={onDescribeInstead}
          onChooseFromLibrary={onChooseFromLibrary}
        />
      );
    }
    if (photoPermissionDenied) {
      return (
        <PermissionDenied
          message="I need photo access to see your meal. Turn it on in Settings, or tell me what you ate instead."
          icon="camera"
          onDescribeInstead={onDescribeInstead}
        />
      );
    }
    return (
      // The app's central action. A raw Pressable here meant the tap had no
      // acknowledgement at all until the camera fired.
      <PressableScale
        testID="capture-idle-photo"
        accessibilityRole="button"
        accessibilityLabel="Photo viewfinder"
        onPress={onCapturePhoto}
        style={{
          height: 200,
          borderRadius: 20,
          overflow: "hidden",
          backgroundColor: T.glass,
          borderWidth: 1,
          borderColor: T.glassBorder,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="utensils" size={54} color={T.mut} />
        <ViewfinderReticle />
        <View style={{ position: "absolute", bottom: 12, left: 0, right: 0 }}>
          <AppText style={{ textAlign: "center", color: T.mut, fontSize: 13, fontWeight: "600" }}>
            Tap the viewfinder to capture
          </AppText>
        </View>
      </PressableScale>
    );
  }

  if (mode === "voice") {
    if (micPermissionDenied) {
      return (
        <PermissionDenied
          message="I need mic access to hear what you ate. Turn it on in Settings, or tell me what you ate instead."
          icon="mic"
          onDescribeInstead={onDescribeInstead}
        />
      );
    }
    return (
      <View
        testID="capture-idle-voice"
        style={{
          height: 200,
          borderRadius: 20,
          backgroundColor: T.glass,
          borderWidth: 1,
          borderColor: T.glassBorder,
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
        }}
      >
        <Waveform active={isRecordingVoice} />
        <AppText style={{ color: T.mut, fontSize: 13, fontWeight: "600" }}>
          {isRecordingVoice ? "Listening… tell Otto what you ate" : "Hold the mic below to record"}
        </AppText>
      </View>
    );
  }

  if (mode === "scan") {
    if (cameraPermissionDenied) {
      return (
        <PermissionDenied
          message="I need camera access to scan barcodes. Turn it on in Settings, or tell me what you ate instead."
          icon="barcode"
          onDescribeInstead={onDescribeInstead}
        />
      );
    }
    return (
      <View
        testID="capture-idle-scan"
        style={{
          height: 200,
          borderRadius: 20,
          backgroundColor: T.glass,
          borderWidth: 1,
          borderColor: T.glassBorder,
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
            borderColor: T.glassBorder,
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          {cameraPermissionGranted ? (
            // No camera on the iOS simulator — this renders but won't scan
            // there; live barcode detection is device-only (see report).
            <>
              <CameraView
                testID="barcode-scanner"
                style={{ width: "100%", height: "100%" }}
                barcodeScannerSettings={{ barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e"] }}
                onBarcodeScanned={({ data }) => onBarcodeScanned(data)}
              />
              {/* The real scan line — over the live camera feed this screen
                  can actually scan with. Distinct from (and not to be
                  confused with) the fake one this replaced, which drew the
                  same line while camera access was denied. */}
              <View
                testID="scan-line"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: "50%",
                  height: 1.5,
                  backgroundColor: T.accent,
                }}
              />
            </>
          ) : (
            <Icon name="barcode" size={64} color={T.mut} />
          )}
        </View>
        <AppText style={{ marginTop: 12, color: T.mut, fontSize: 13, fontWeight: "600" }}>
          Point at a barcode
        </AppText>
      </View>
    );
  }

  return <View testID="capture-idle-type" />;
}

/** One settled turn in the Ask Otto thread, oldest first. */
export type ThreadEntry =
  | { role: "user"; text: string }
  /** `plan` is the reviewed meal plan in its structured form — the text says
   *  why it fits, the card is what the user can approve (kora#264). */
  | { role: "otto"; text: string; agent?: string; reviewedBy?: string; plan?: MealPlanProposal | null };

interface CaptureBodyProps {
  displayName: string;
  insetTop: number;
  insetBottom: number;
  mode: CaptureMode;
  onModeChange: (mode: CaptureMode) => void;
  stage: CaptureStage;
  resolution: Resolution | null;
  errorMsg: string | null;
  /**
   * Every turn so far — the user's messages (kora#199) and Otto's replies
   * (kora#264). Append-only: a second question must not erase the exchange it
   * follows, or "also include breakfast" loses the plan it refers to.
   */
  transcript: readonly ThreadEntry[];
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
  onStartVoice: () => void;
  onFinishVoice: () => void;
  onCancelVoice: () => void;
  cameraPermissionGranted: boolean;
  /** True only once the OS has actually refused camera access — distinct
   *  from "not yet granted", which also covers the not-yet-requested and
   *  still-requesting states. Drives the Scan idle affordance's denied UI. */
  cameraPermissionDenied?: boolean;
  /** True once expo-image-picker's photo-LIBRARY request has actually come
   *  back denied. Drives the Photo idle affordance's denied UI. */
  photoPermissionDenied?: boolean;
  /** True when the CAMERA is denied and Photo mode should say so (kora#201). */
  cameraForPhotoDenied?: boolean;
  /** Explicit photo-library route offered by the camera-denied card. */
  onChooseFromLibrary?: () => void;
  /** True once expo-audio's mic permission request has actually come back
   *  denied. Drives the Voice idle affordance's denied UI. */
  micPermissionDenied?: boolean;
  onBarcodeScanned: (data: string) => void;
  onClose: () => void;
  /** Forwarded to DetectedCard — asked when the user taps an uncertain row. */
  onResolveUncertain?: (index: number) => void;
  /** Rows the user unchecked, forwarded to DetectedCard (kora#183). */
  excluded: ReadonlySet<number>;
  onToggleExclude: (index: number) => void;
  /** Sets a hand-picked row's portion — see DetectedCard (kora#190). */
  onChangePortion?: (index: number, baseQuantity: number) => void;
  /** Bails out of the in-flight resolve and returns to idle. Analyzing-state only. */
  onCancelResolve?: () => void;
  /** Approves the plan on one of the thread's Otto turns. The index is the
   *  turn's position, so a repeated plan in a long thread still updates the
   *  turn the user tapped. */
  onApprovePlan?: (planID: string, turnIndex: number) => void;
  /** The plan currently being approved, so only its own button spins. */
  approvingPlanID?: string | null;
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
  transcript,
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
  onStartVoice,
  onFinishVoice,
  onCancelVoice,
  cameraPermissionGranted,
  cameraPermissionDenied = false,
  photoPermissionDenied = false,
  cameraForPhotoDenied = false,
  onChooseFromLibrary = () => {},
  micPermissionDenied = false,
  onBarcodeScanned,
  onClose,
  onResolveUncertain,
  excluded,
  onToggleExclude,
  onChangePortion,
  onCancelResolve,
  onApprovePlan = () => {},
  approvingPlanID = null,
}: CaptureBodyProps) {
  const scrollViewRef = useRef<ScrollView>(null);
  const composerFieldRef = useRef<TextInput>(null);
  // Typing is an input only where it is the point. In voice and scan the
  // middle of the composer is static guidance, so there is no dead field.
  const showsTextField = mode === "photo" || mode === "type";

  // Send is unavailable below MIN_PHRASE_CHARS rather than accepting a press
  // that could only ever fail — the rule is visible in the affordance, which
  // is how every other unavailable control on this screen behaves (kora#243).
  const canSend = text.trim().length >= MIN_PHRASE_CHARS;

  // Bring the newest Otto message (an error bubble or the detected-food
  // result) into view — on short viewports or with the keyboard open, the
  // in-thread bubble can otherwise land below the fold with no signal.
  useEffect(() => {
    if (errorMsg || resolution || transcript.length > 0) {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }
  }, [errorMsg, resolution, transcript.length]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: "transparent" }}
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
        <PressableScale accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={ROUND_BUTTON}>
          <Icon name="x" size={20} color={T.ink} />
        </PressableScale>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Icon name="sparkles" size={17} color={T.accent} />
          <AppText style={{ color: T.ink, fontWeight: "700" }}>Ask Otto</AppText>
        </View>
        {/* Balances the Close button on the left so the title stays centered
            now that the no-op photo-library button (it did nothing on press)
            is gone. */}
        <View style={{ width: ROUND_BUTTON.width, height: ROUND_BUTTON.height }} />
      </View>

      <ScrollView
        ref={scrollViewRef}
        contentContainerStyle={{ padding: 18, paddingTop: 8, gap: 14 }}
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
      >
        <OttoBubble>
          Hi {displayName} — show me your meal or just tell me what you ate. A photo works great — words work too.
        </OttoBubble>

        {stage === "idle" && (
          <IdleAffordance
            mode={mode}
            onCapturePhoto={onCapturePhoto}
            isRecordingVoice={isRecordingVoice}
            cameraPermissionGranted={cameraPermissionGranted}
            cameraPermissionDenied={cameraPermissionDenied}
            photoPermissionDenied={photoPermissionDenied}
            cameraForPhotoDenied={cameraForPhotoDenied}
            onChooseFromLibrary={onChooseFromLibrary}
            micPermissionDenied={micPermissionDenied}
            onBarcodeScanned={onBarcodeScanned}
            onDescribeInstead={() => onModeChange("type")}
          />
        )}

        {/* The conversation so far, oldest first. The user's turn is appended
            optimistically on send (kora#199) and Otto's reply when it lands, so
            the thread reads back the way the server already remembers it —
            /v1/coach/message replays the last turns into every prompt. */}
        {transcript.map((entry, index) =>
          entry.role === "user" ? (
            <UserBubble key={index}>{entry.text}</UserBubble>
          ) : (
            <View key={index} style={{ gap: 10 }}>
              <OttoBubble
                agent={
                  entry.agent
                    ? entry.agent + (entry.reviewedBy ? ` · reviewed by ${entry.reviewedBy}` : "")
                    : undefined
                }
              >
                {entry.text}
              </OttoBubble>
              {entry.plan ? (
                <PlanCard
                  plan={entry.plan}
                  onApprove={() => onApprovePlan(entry.plan!.id, index)}
                  approving={approvingPlanID === entry.plan.id}
                />
              ) : null}
            </View>
          ),
        )}

        {stage === "analyzing" && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              paddingLeft: 40,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <AnalyzingSpinner />
              <AppText style={{ color: T.mut, fontSize: 13 }}>Otto is analyzing…</AppText>
            </View>
            {/* Secondary control — a resolve is bounded by REQUEST_TIMEOUT_MS
                either way (api.ts), so Cancel is purely for the user who
                doesn't want to wait; it must never read as the primary
                action, hence T.mut/T.glass rather than T.accent. */}
            <PressableScale
              testID="capture-cancel-resolve"
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={onCancelResolve}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 9999,
                backgroundColor: T.glass,
                borderWidth: 1,
                borderColor: T.glassBorder,
              }}
            >
              <AppText style={{ color: T.mut, fontSize: 13, fontWeight: "600" }}>Cancel</AppText>
            </PressableScale>
          </View>
        )}

        {stage === "result" && resolution && (
          <ResolutionResult
            resolution={resolution}
            mealSlot={mealSlot}
            onChangeMealSlot={onChangeMealSlot}
            onAdd={onAdd}
            adding={adding}
            onSearchManually={onSearchManually}
            onResolveUncertain={onResolveUncertain}
            excluded={excluded}
            onToggleExclude={onToggleExclude}
            onChangePortion={onChangePortion}
          />
        )}

        {errorMsg ? <OttoBubble>{errorMsg}</OttoBubble> : null}
      </ScrollView>

      <View
        style={{
          paddingHorizontal: 14,
          paddingTop: 10,
          paddingBottom: Math.max(insetBottom, 12),
          backgroundColor: T.glass,
          borderTopWidth: 1,
          borderTopColor: T.glassBorder,
        }}
      >
        {/* flexWrap, because a clipped chip is a mode the user cannot reach.
            The trimmed pill padding gets all four onto one line at `medium`
            (395pt of 412), but Dynamic Type keeps growing past that: at
            accessibility-extra-large the same four measured 520pt, and TYPE
            started at x=419 on a 440pt screen — its tap centre off the display
            entirely, the kora#276 failure mode. Wrapping spills the overflow
            onto a second line where every chip stays whole and hittable, which
            a horizontal scroll would not (it hides one by default). `gap: 8`
            is both axes in RN, so the wrapped line gets its own 8pt of air.
            Same mechanism DetectedCard already uses for these pills. */}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          {MODE_PILLS.map(({ mode: m, icon, label }) => (
            <ModePill key={m} icon={icon} label={label} active={mode === m} onPress={() => onModeChange(m)} />
          ))}
        </View>

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            backgroundColor: T.inset,
            borderRadius: 9999,
            paddingVertical: 6,
            paddingHorizontal: 6,
            paddingLeft: 8,
          }}
        >
          {/* Mode-aware primary control. This was a camera icon in EVERY mode,
              which is what made Voice read as a photo capture: selecting Voice
              changed the pills and the thread affordance but left a camera
              button and a text field sitting in the composer. Voice owns its
              own control (hold-to-record); the others share one Pressable. */}
          {mode === "voice" ? (
            <VoiceComposer
              isRecording={isRecordingVoice}
              onStart={onStartVoice}
              onFinish={onFinishVoice}
              onCancel={onCancelVoice}
            />
          ) : (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={COMPOSER_BUTTON[mode].label}
              onPress={mode === "type" ? () => composerFieldRef.current?.focus() : onCapturePhoto}
              style={{
                width: 38,
                height: 38,
                borderRadius: 9999,
                backgroundColor: T.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name={COMPOSER_BUTTON[mode].icon} size={19} color={T.accentOn} />
            </PressableScale>
          )}
          {/* Typing is only an input in photo/type. In voice and scan the middle
              is static guidance, so there is no dead field to tab into. */}
          {showsTextField ? (
            <TextInput
              ref={composerFieldRef}
              accessibilityLabel="Tell Otto what you ate"
              value={text}
              onChangeText={onChangeText}
              autoCorrect
              spellCheck
              returnKeyType="send"
              onSubmitEditing={onSend}
              placeholder="Tell Otto what you ate…"
              placeholderTextColor={T.mut}
              style={{ flex: 1, color: T.ink, fontSize: 15 }}
            />
          ) : (
            <AppText variant="subheadline" style={{ flex: 1, color: T.mut }}>
              {mode === "voice" ? "Hold the mic to record" : "Point at a barcode"}
            </AppText>
          )}
          {/* Send — posts the typed phrase via useCaptureMessage. */}
          {showsTextField ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Send"
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            onPress={onSend}
            style={{
              width: 38,
              height: 38,
              borderRadius: 9999,
              backgroundColor: canSend ? T.accent : withAlpha(T.ink, 0.15),
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="arrow-up" size={19} color={canSend ? T.accentOn : T.ink} />
          </PressableScale>
          ) : null}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

type PhotoFile = { uri: string; name: string; type: string };

type PhotoPickOutcome =
  | { status: "success"; file: PhotoFile }
  | { status: "canceled" }
  /** The photo LIBRARY was denied. */
  | { status: "denied" }
  /** The CAMERA was denied. Distinct from `denied` because the two want
   *  opposite treatment, which is the whole of kora#201. */
  | { status: "camera-denied" }
  | { status: "failed" };

function assetOutcome(result: ImagePicker.ImagePickerResult): PhotoPickOutcome {
  if (result.canceled) return { status: "canceled" };
  const asset = result.assets[0];
  if (!asset) return { status: "canceled" };
  return {
    status: "success",
    file: { uri: asset.uri, name: asset.fileName ?? "meal.jpg", type: asset.mimeType ?? "image/jpeg" },
  };
}

// The explicit library route, reached only when the user ASKS for it from the
// camera-denied card. Before kora#201 this ran silently as a fallback, so a
// camera icon produced a photo-library dialog nobody had requested.
async function pickMealFromLibrary(): Promise<PhotoPickOutcome> {
  try {
    const libraryPermission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!libraryPermission.granted) return { status: "denied" };
    return assetOutcome(await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.7 }));
  } catch {
    return { status: "failed" };
  }
}

// Camera first. The two ways the camera can fail want OPPOSITE treatment, and
// collapsing them was kora#201:
//
//   - DENIED — the user switched it off. Say so, and offer Settings. Falling
//     through to a photo-library prompt asks for something they did not ask
//     for, and never names the thing that is actually wrong. iOS will not
//     re-prompt for a denied permission, so silence here is permanent.
//   - THREW — there is no camera (the simulator, or genuinely absent
//     hardware). Nothing the user can fix, so the silent library fallback is
//     exactly right and is kept.
//
// The outer try/catch is a last-resort net: ANY unexpected throw must still
// surface an Otto bubble rather than fail silently.
async function pickMealPhoto(): Promise<PhotoPickOutcome> {
  try {
    // `requestCameraPermissionsAsync` has already prompted by the time it
    // returns, so "not granted" here cannot still be undetermined — it is a
    // denial (or a restriction), and either way the card is the right answer.
    const cameraPermission = await ImagePicker.requestCameraPermissionsAsync();
    if (!cameraPermission.granted) return { status: "camera-denied" };

    try {
      return assetOutcome(await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.7 }));
    } catch {
      // No camera hardware — fall back to the library silently, as before.
      return await pickMealFromLibrary();
    }
  } catch {
    return { status: "failed" };
  }
}

// Full-bleed dark canvas backdrop — sits behind the header/thread/composer.
// Purely decorative (no data, no text), so it carries no nutrition-invariant
// risk; the composer keeps its own opaque bar on top of it. Uses
// react-native-svg (expo-linear-gradient isn't installed) with a percentage
// viewBox so the Rect always fills its container regardless of screen size.
//
// Instrument Glass: a faint accent-tinted ambient pool fading into the fixed
// dark `bg`, echoing the spec's ambient-pool treatment (orange upper-left,
// static, no parallax) without competing with the thread/composer on top.
//
// The alpha MUST come from a separate `stopOpacity` prop, not baked into an
// rgba() `stopColor` string (see AppBackground's pools for the same
// pattern) — react-native-svg does not reliably honor the alpha channel of
// an rgba() stopColor, which previously rendered this as a full-saturation
// orange wall instead of a faint pool.
function CaptureCanvasBackground() {
  return (
    <Svg
      testID="capture-canvas-background"
      style={StyleSheet.absoluteFill}
      width="100%"
      height="100%"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <Defs>
        <LinearGradient id="captureCanvas" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor={T.accent} stopOpacity={0.14} />
          <Stop offset="30%" stopColor={T.accent} stopOpacity={0} />
          <Stop offset="100%" stopColor={T.accent} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Rect x={0} y={0} width={100} height={100} fill={T.bg} />
      <Rect x={0} y={0} width={100} height={100} fill="url(#captureCanvas)" />
    </Svg>
  );
}

// Three very different failures used to collapse into one opaque sentence
// here — the server saying no, the request never reaching the server, and
// the server answering with something unreadable. Each gets its own copy so
// which one happened is legible from the screen alone, without surfacing
// raw error text or the request id (that's for logs, via api.ts's
// ApiError.requestId — not for the user).
function ottoErrorMessage(error: Error): string {
  // Checked before NetworkError below: this is not "the request failed", it is
  // "we looked, and this device has no answer". Telling the user to try again
  // would be advice that cannot work until the network returns, and "I couldn't
  // identify that" would claim the food does not exist when we simply cannot
  // see the index from here.
  if (error instanceof OfflineUnknownBarcodeError) {
    // Says what is true and what the user can do — it does NOT promise to
    // handle it later.
    //
    // This read "I'll recognise it once you're back online", which describes a
    // capture that has been SAVED and will be replayed. Nothing is saved: the
    // barcode path never calls enqueueCapture (only handleResolveFailure does,
    // and only photo/voice reach it). So the user put the phone away, came back
    // online, and found no meal and no record they had tried — a promise the
    // code does not keep, which is worse than a plain failure because it stops
    // them doing the one thing that would have worked: scanning again later
    // (kora#191).
    //
    // Queueing the scan properly is the better fix and is tracked as kora#196;
    // the capture queue is media-shaped (kind: photo | voice, storedName,
    // mimeType) and has no text/barcode variant yet.
    return "You're offline, and this isn't a barcode you've scanned before. Scan it again once you're back online.";
  }
  if (error instanceof ApiError) {
    return `Hmm, I couldn't tell — ${error.message}. Mind trying again?`;
  }
  if (error instanceof AuthTokenError) {
    // Deliberately does NOT tell the user to sign in again. This wraps
    // getIdToken() rejecting, whose most common cause is a dropped
    // connection (auth/network-request-failed), not an unusable session —
    // and sending someone to re-authenticate over a flaky network costs
    // them their session for nothing. A session that genuinely cannot be
    // used already has its own path: a 401 surviving the refresh-and-retry
    // in api.ts triggers signOutForExpiredSession, which redirects to
    // /sign-in with an explanation. Keep this copy action-neutral.
    return "I couldn't confirm your session just then — mind trying again?";
  }
  if (error instanceof NetworkError) {
    return "I couldn't reach the server. Check your connection and try again.";
  }
  if (error instanceof ResponseParseError) {
    return "The server answered, but I couldn't make sense of it. Mind trying again?";
  }
  if (error instanceof TimeoutError) {
    // Reached from the BARCODE path (handleBarcodeScanned), which still does
    // not queue — kora#241 tracks giving it one — and from the typed path,
    // which deliberately stopped queueing timeouts (see handleSend's onError,
    // kora#264). handleResolveFailure still queues photo and voice timeouts
    // and sets its own copy, so this text is only ever seen by a caller with
    // nothing saved. It therefore stays honest about the timeout itself and
    // promises no save.
    return "That took too long — mind trying again?";
  }
  return "Something went wrong while I looked at that. Please try again.";
}

export default function CaptureScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const toast = useToast();
  const profile = useProfile();
  const captureMessage = useCaptureMessage();
  const resolvePhoto = useResolvePhoto();
  const resolveVoice = useResolveVoice();
  const resolveBarcode = useResolveBarcode();
  const createLog = useCreateLog();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  // Photo (expo-image-picker) and Voice (expo-audio) have no proactive
  // permission hook the way Scan's useCameraPermissions does — their denial
  // is only ever learned imperatively, at the moment the user taps to
  // capture/record (see handleCapturePhoto/handleStartVoice). These flags are
  // how that one-shot fact becomes persistent UI instead of a bubble that
  // scrolls away, mirroring cameraPermissionDenied's role for Scan.
  const [photoPermissionDenied, setPhotoPermissionDenied] = useState(false);
  // kora#201. Set by a tap whose camera request came back denied, so the
  // composer's photo button reaches the same explanation the viewfinder does.
  // OR'd with the proactive `cameraPermission.status` read below, which is
  // what lets the card appear before any tap at all.
  const [cameraDeniedOnTap, setCameraDeniedOnTap] = useState(false);
  const [micPermissionDenied, setMicPermissionDenied] = useState(false);

  // #137: the denied card REPLACES the tappable viewfinder, so there is no
  // in-place retry — the flag is otherwise cleared only by a mode change or a
  // fresh tap. For camera and mic that is masked, because iOS terminates the
  // app when either permission changes and it relaunches with fresh state. A
  // photo-library grant does NOT restart the app, so without this the user
  // taps "Open Settings", grants access, comes back, and the dead end is still
  // there.
  //
  // getMediaLibraryPermissionsAsync is the NON-prompting read. Using the
  // request* variant here would pop a second dialog on every foreground.
  //
  // Mirrors app/_layout.tsx's reconcileWeightReminder foreground listener
  // rather than introducing a second mechanism.
  useEffect(() => {
    if (!photoPermissionDenied && !cameraDeniedOnTap) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void ImagePicker.getMediaLibraryPermissionsAsync()
        .then((permission) => {
          if (permission.granted) setPhotoPermissionDenied(false);
        })
        .catch((err) => console.warn("capture: photo permission re-check failed", err));
      // Belt-and-braces for the camera (kora#201). iOS terminates the app when
      // the camera permission changes, so this usually never fires — but the
      // card is now reachable without a tap, and a stale one is a dead end.
      void ImagePicker.getCameraPermissionsAsync()
        .then((permission) => {
          if (permission.granted) setCameraDeniedOnTap(false);
        })
        .catch((err) => console.warn("capture: camera permission re-check failed", err));
    });
    return () => sub.remove();
  }, [photoPermissionDenied, cameraDeniedOnTap]);

  const [mode, setMode] = useState<CaptureMode>("photo");
  // idle<->result is driven by the four capture flows below; "analyzing" is
  // derived from the mutations' isPending rather than tracked separately.
  const [stage, setStage] = useState<CaptureStage>("idle");
  const [resolution, setResolution] = useState<Resolution | null>(null);
  // Which modality actually produced `resolution` — set alongside it in
  // applyResolution, never derived from `mode`. The tab a user has open says
  // nothing about which resolve fired; the composer is reachable from every
  // tab, so a user can type while on the Photo tab and the log must still
  // read `ai_text`.
  const [resolutionSource, setResolutionSource] = useState<ResolutionSource | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // The conversation, not the latest line of it. Kept separate from errorMsg
  // because these are ANSWERS, not failures, and each carries who answered.
  const [transcript, setTranscript] = useState<readonly ThreadEntry[]>([]);
  const [mealSlot, setMealSlot] = useState<MealSlot>(() => mealSlotForHour(new Date().getHours()));
  const [adding, setAdding] = useState(false);
  // Candidate keys (see candidateKey) already logged successfully across
  // add-to-diary attempts for the *current* resolution — reset whenever a
  // fresh resolution replaces it, so a retry only re-submits what actually
  // failed instead of re-logging (duplicating) the ones that already succeeded.
  const [loggedCandidateKeys, setLoggedCandidateKeys] = useState<Set<string>>(new Set());
  // Candidate index -> the food the user hand-picked for an uncertain row, and
  // the row whose picker is currently open. Both are local to the *current*
  // resolution and are cleared alongside loggedCandidateKeys — a promotion that
  // survived into the next capture would silently relabel a different food.
  const [promoted, setPromoted] = useState<Record<number, FoodItem>>({});
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);
  // The portion for a hand-picked row, keyed by candidate index. Held here
  // rather than derived, because it has two sources — the replacement food's
  // own serving when it was picked, and whatever the user then set — and the
  // card must not have to tell them apart. `assumed` is carried alongside so
  // the row can say "portion is a guess" honestly: true only while it is the
  // flat default, false once the food's own serving applied OR the user chose.
  const [promotedPortion, setPromotedPortion] = useState<
    Record<number, { grams: number; assumed: boolean }>
  >({});
  // Rows the user unchecked, by index into the CURRENT resolution — so it is
  // cleared alongside `promoted` for the same reason: indices are meaningless
  // against a different capture, and a stale exclusion would silently drop a
  // food the user never touched.
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(() => new Set());

  // A new Set rather than mutating in place — see the immutability rule in the
  // repo's coding style; a mutated Set is the same reference and React would
  // not re-render the checkbox that was just tapped.
  function toggleExcluded(index: number) {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }
  const [text, setText] = useState("");
  // The phrase that produced the current resolution. `text` is cleared as soon
  // as the resolve fires, so it cannot be read at add-to-diary time — but the
  // correction loop needs the exact words the user used, since that is the key
  // a later correction teaches the food index under. Set (or explicitly
  // cleared to null) in the same onSuccess handler that calls applyResolution,
  // so it can never lag behind — and never a later, unrelated resolution.
  const [resolvedPhrase, setResolvedPhrase] = useState<string | null>(null);
  // Cancel means the in-flight message never became an exchange, so it leaves
  // the thread with the request it belonged to. A failed request does NOT go
  // through here: its bubble stays as the retry context (see handleSend).
  function dropPendingUserTurn() {
    setTranscript((turns) =>
      turns.length > 0 && turns[turns.length - 1].role === "user" ? turns.slice(0, -1) : turns,
    );
  }
  const acceptPlan = useAcceptMealPlan();
  const [approvingPlanID, setApprovingPlanID] = useState<string | null>(null);
  // Approval is a decision, not a log: the card flips to "approved" and the
  // thread keeps the plan exactly as reviewed. A failure leaves the button
  // where it was, so the user can simply tap again.
  function handleApprovePlan(planID: string, turnIndex: number) {
    setApprovingPlanID(planID);
    acceptPlan.mutate(planID, {
      onSuccess: (plan) => {
        setTranscript((turns) =>
          turns.map((turn, index) =>
            index === turnIndex && turn.role === "otto" ? { ...turn, plan } : turn,
          ),
        );
      },
      onError: () => setErrorMsg("I couldn't save that approval — try again."),
      onSettled: () => setApprovingPlanID(null),
    });
  }
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  // Guards a single CameraView against firing onBarcodeScanned repeatedly
  // for the same physical scan while the camera keeps detecting the code.
  const scannedRef = useRef(false);
  // Cancel must mean "stop this scan", not "stop scanning". Once the resolve
  // genuinely aborts (#136), scannedRef releases immediately — with the
  // cancelled code still in frame, and CameraView firing dozens of times a
  // second. Suppressing only THAT code for a moment lets a different barcode
  // scan instantly while stopping the cancelled one from re-firing on its own.
  const cancelledCodeRef = useRef<string | null>(null);
  const cancelledAtRef = useRef(0);
  // The last barcode scanned, if a barcode resolve is what's currently in
  // flight — set at the top of handleBarcodeScanned (after beginResolve,
  // which clears it for every OTHER modality), read by handleCancelResolve
  // so it knows what to suppress. A Cancel on a photo/voice/text resolve
  // must not arm the barcode cooldown with whatever barcode was scanned
  // earlier, hence the clear-by-default in beginResolve. Distinct from
  // cancelledCodeRef, which only records a code once it has actually been
  // cancelled.
  const lastScannedCodeRef = useRef<string | null>(null);

  // The in-flight resolve's cancellation token. `.signal` is threaded into
  // the mutation variables (see ResolveVars in src/api/hooks.ts) and reaches
  // apiFetch/apiFetchMultipart's `signal`, so `.abort()` here really does
  // cancel the underlying request — the socket stops, not just the UI. See
  // #136: before that threading existed, this controller was a purely local
  // token and Cancel kept burning bandwidth and the server's AI budget until
  // completion or the 25s deadline.
  //
  // It still does the two things that matter independently of whether the
  // abort reaches the network in time: gate a late-arriving onSuccess/onError
  // from writing to state, and force displayStage back to "idle" immediately
  // rather than waiting on isPending to catch up. And the unmount cleanup
  // effect below now genuinely kills an in-flight upload rather than merely
  // dropping a reference to one.
  const resolveControllerRef = useRef<AbortController | null>(null);
  // Set the moment Cancel fires, cleared the moment a new resolve starts —
  // overrides displayStage below so the UI returns to idle even while the
  // hook's own isPending is still (harmlessly) true.
  const [cancelledResolve, setCancelledResolve] = useState(false);

  // Called at the top of every resolve-triggering handler, before the
  // corresponding mutate(). Returns the controller so the caller's
  // onSuccess/onError can check `.signal.aborted` before touching state.
  //
  // Clears lastScannedCodeRef by default — only handleBarcodeScanned sets it
  // back (immediately after calling this), so a Cancel on a photo/voice/text
  // resolve never arms the barcode cooldown with a stale code from an
  // earlier, unrelated scan (see #136 part 2 follow-up review).
  function beginResolve(): AbortController {
    const controller = new AbortController();
    resolveControllerRef.current = controller;
    setCancelledResolve(false);
    lastScannedCodeRef.current = null;
    return controller;
  }

  function handleCancelResolve() {
    // Cancel means "I've moved on" — the message goes with the request.
    dropPendingUserTurn();
    resolveControllerRef.current?.abort();
    // Do NOT reset scannedRef here — the abort above releases it through
    // handleBarcodeScanned's onError (see #136 part 1). Resetting it a
    // second time here would just re-open the same door faster; the
    // cooldown below is what actually stops the still-in-frame code from
    // re-triggering on its own.
    cancelledCodeRef.current = lastScannedCodeRef.current;
    cancelledAtRef.current = Date.now();
    setCancelledResolve(true);
    setStage("idle");
  }

  // Leaving the screen genuinely kills the in-flight resolve: the signal is
  // threaded all the way to fetch (see resolveControllerRef above), so this
  // stops the upload and the server-side AI work rather than merely dropping a
  // reference to a request that would run to completion regardless. Mirrors the
  // voice-recorder cleanup effect above — same "leaving the screen must not
  // leave work running unbounded behind it" concern, applied to the resolve
  // instead of the mic. There is no state left to update afterwards, so the
  // rejection this raises has nowhere to surface and nothing to say: it is a
  // CancelledError, which the reporter deliberately does not treat as a fault.
  useEffect(() => {
    return () => {
      resolveControllerRef.current?.abort();
    };
  }, []);

  const displayStage: CaptureStage =
    !cancelledResolve &&
    (captureMessage.isPending || resolvePhoto.isPending || resolveVoice.isPending || resolveBarcode.isPending)
      ? "analyzing"
      : stage;

  // The resolution as the user has amended it: a promoted row carries the food
  // they picked and becomes loggable, but keeps NO kcal. kcal is only ever
  // server-computed (see the resolver's invariant guard) and this client is
  // forbidden from deriving nutrition, so `kcal_unknown` makes the row render
  // "—" and drop out of the total. The `0` is only there to keep the field a
  // number; it is never displayed. The real figure lands in the diary the
  // moment the row is logged and the server recomputes it.
  const effectiveResolution = useMemo(() => {
    if (!resolution || Object.keys(promoted).length === 0) return resolution;
    return {
      ...resolution,
      candidates: resolution.candidates.map((candidate, i) => {
        const item = promoted[i];
        if (!item) return candidate;
        // portion_grams MUST be replaced, not spread through. It previously
        // inherited the REPLACED food's portion, so swapping "1 breast" (170 g)
        // for a drink logged 170 g of the drink, and nothing on screen said so
        // — the row renders "—" for kcal, which reads as "the number is coming
        // later" rather than "this portion belongs to a different food"
        // (kora#190).
        const portion = promotedPortion[i] ?? initialPortionFor(item);
        return {
          ...candidate,
          item,
          kcal: 0,
          tier: "confirm" as const,
          kcal_unknown: true,
          portion_grams: portion.grams,
          portion_assumed: portion.assumed,
        };
      }),
    };
  }, [resolution, promoted, promotedPortion]);

  // Request camera access as soon as the user switches into Scan mode. A
  // denial surfaces through the idle affordance itself (cameraPermissionDenied
  // -> the PermissionDenied card with its Open Settings / Describe it instead
  // routes), not an Otto bubble — a bubble scrolls away, leaving no persistent
  // way out, which is the dead end this replaced. An unexpected native failure
  // is a different, transient problem and still gets its own bubble.
  useEffect(() => {
    if (mode !== "scan" || cameraPermission?.granted) return;
    requestCameraPermission().catch(() => {
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
        // Hand the audio session back on the way out too, or the app is left
        // in a capture category with no screen to ever release it.
        void endRecordingSession();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Applies a newly-resolved capture result and clears every piece of state
  // that belonged to the previous resolution — add-to-diary success tracking,
  // hand-picked promotions, and any open picker. A fresh capture always starts
  // with a clean retry slate and no promotion leaking in from the last one.
  function applyResolution(data: Resolution, source: ResolutionSource) {
    setResolution(data);
    setResolutionSource(source);
    setStage("result");
    setLoggedCandidateKeys(new Set());
    setPromoted({});
    setPromotedPortion({});
    setExcluded(new Set());
    setPickerIndex(null);
  }

  function handleModeChange(next: CaptureMode) {
    // The thread belongs to the mode being left behind.
    setTranscript([]);
    // Switching away from Voice mid-recording must not leave the native
    // recorder running in the background — stop it (best-effort) and reset
    // the mic button back to its start state.
    if (next !== "voice" && isRecordingVoice) {
      recorder.stop().catch(() => {});
      void endRecordingSession();
      setIsRecordingVoice(false);
    }
    setMode(next);
    setStage("idle");
    setErrorMsg(null);
    // A denial recorded against the mode being left must not linger — coming
    // back later (e.g. after fixing it in Settings) should get a clean retry,
    // not a stale card.
    setPhotoPermissionDenied(false);
    setMicPermissionDenied(false);
    scannedRef.current = false;
  }

  function handleSend() {
    const phrase = text.trim();
    // The same gate the Send button renders, enforced here too: the keyboard's
    // own return key reaches this without going through that button.
    if (phrase.length < MIN_PHRASE_CHARS) return;
    setErrorMsg(null);
    // Optimistic, and deliberately BEFORE the request: the message belongs in
    // the thread the instant it is sent, exactly as every messaging app
    // behaves. Clearing inside onSuccess (as this did) left the text sitting in
    // the composer for the whole resolve with nothing else on screen changing.
    setTranscript((turns) => [...turns, { role: "user", text: phrase }]);
    setText("");
    // Fires right as send is pressed — the composer's own keyboard should
    // not stay up covering the result thread once a send is in flight.
    Keyboard.dismiss();
    const controller = beginResolve();
    // Not resolveText: the server decides what the message IS first. Posting
    // straight to food resolution asked a model to name the foods in "help me
    // build a meal plan", and it duly invented four and offered to log them
    // (kora#264).
    captureMessage.mutate({ input: phrase, signal: controller.signal }, {
      onSuccess: (data) => {
        // A cancel that lands between mutate() firing and this callback
        // means the user has already moved on — applying it now would
        // resurrect a result onto a screen that told them it was abandoned.
        if (controller.signal.aborted) return;
        if (data.kind === "answer") {
          // Conversation, so nothing to confirm and nothing to log: the thread
          // keeps the user's message and gains Otto's reply, and the screen
          // goes back to idle rather than to the add-to-diary card.
          setTranscript((turns) => [
            ...turns,
            {
              role: "otto",
              text: data.answer,
              agent: data.agent?.name,
              reviewedBy: data.agent?.reviewed_by,
              plan: data.plan,
            },
          ]);
          setStage("idle");
          return;
        }
        applyResolution(data.resolution, "ai_text");
        setResolvedPhrase(phrase);
      },
      onError: async (error) => {
        // Cancel stops the WAITING, not the words (kora#242) — the rule the
        // media path already states at runPhotoPick's onError, applied here.
        // Returning at this guard skipped the classifier below, so a phrase
        // typed offline and then cancelled was destroyed: gone from the thread
        // (handleCancelResolve clears sentPhrase) and gone from the composer.
        // No connectivity snapshot is consulted — an online Cancel arrives as
        // CancelledError, which the classifier below does not queue, so there
        // is nothing to preserve in that case and nothing to decide.
        //
        // `cancelled` suppresses COPY only — the same division
        // handleResolveFailure's `silent` draws. Cancel already took the
        // screen to idle and does not also get to raise a fresh bubble about
        // the request it just stopped, neither the reassurance nor the
        // failure's own message. It never suppresses the enqueue, and never
        // suppresses a queue refusal: a phrase that could not be saved must
        // say so (see the catch below).
        const cancelled = controller.signal.aborted;
        // Same classifier handleResolveFailure uses, MINUS TimeoutError: these
        // two mean the request never arrived, so the phrase is still good and
        // belongs in the queue (kora#196). Anything else is a genuine refusal
        // that would fail identically on replay.
        //
        // TimeoutError is excluded here alone (kora#264). This endpoint runs
        // the agent chain — classify, draft, review — so a timeout means the
        // request DID arrive and is still being worked on, which is the
        // opposite of what the queue is for. Two things went wrong when it was
        // treated as offline: a week-long plan request was told "You're
        // offline" on a device with full signal, and the question itself was
        // enqueued as a FOOD capture, so "plan my meals for the week" came
        // back later as an attempt to name the foods in it. The deadline that
        // makes a timeout here rare is AGENT_REQUEST_TIMEOUT_MS in
        // src/lib/api.ts; when one still happens, the honest thing is to say
        // it took too long and let the user ask again.
        const recoverable = error instanceof NetworkError || error instanceof AuthTokenError;
        if (!recoverable) {
          // Hand the words back. The bubble goes with them: a message that
          // never arrived should not sit in the thread as though it did.
          // Keep the submitted phrase in the thread as the retry context and
          // leave the composer empty; restoring it here made a failed request
          // look like it had never been sent and duplicated the prompt.
          setText("");
          if (!cancelled) setErrorMsg(ottoErrorMessage(error));
          return;
        }
        try {
          await enqueueTextCapture(phrase, mealSlot);
          // The bubble STAYS and the composer stays empty: the capture was
          // accepted, so returning the text would be the misleading state.
          if (!cancelled) {
            setErrorMsg(
              "You're offline — I've saved that, and I'll identify it as soon as you're back online.",
            );
          }
          void queryClient.invalidateQueries({ queryKey: [QUEUED_CAPTURES_KEY] });
        } catch (queueError) {
          // The queue refused (full, or nobody signed in), so the phrase is
          // now saved NOWHERE and survives only if something on screen still
          // holds it. The optimistic thread bubble does — unless this resolve
          // was cancelled, because handleCancelResolve clears sentPhrase. So
          // the composer is restored in exactly that case.
          //
          // Not unconditionally: with the bubble still up, putting the words
          // back too duplicates the prompt, which the non-recoverable branch
          // above rejects for the same reason.
          //
          // This path was unreachable while a cancelled resolve returned at
          // the abort guard; routing it through the classifier (kora#242) is
          // what exposed it, and a cancelled capture the queue then refused
          // was the one remaining way to lose the phrase outright.
          setText(cancelled ? phrase : "");
          setErrorMsg(
            queueError instanceof CaptureQueueFullError || queueError instanceof NoOwnerError
              ? queueError.message
              : ottoErrorMessage(error),
          );
        }
      },
    });
  }

  // Both of these mean the request never arrived — the capture is still good,
  // so queue it rather than telling the user it failed. Any other error is a
  // genuine refusal and keeps the existing message.
  //
  // AuthTokenError belongs here, and leaving it out very nearly made this whole
  // feature dead in the only condition it exists for. api.ts's fetchWithRetry
  // awaits getToken(user) BEFORE it ever calls fetch (src/lib/api.ts), and
  // src/lib/__tests__/api-error-modes.test.ts pins that ordering: when
  // getIdToken rejects, fetch is never attempted, so NO NetworkError is ever
  // produced. Firebase serves getIdToken() from cache while the ID token is
  // still valid — roughly an hour — but the moment it needs refreshing it goes
  // to the network, and offline that rejects with auth/network-request-failed.
  // So a user offline for more than an hour (a flight, a hike: precisely the
  // scenario this queue was designed for) hit AuthTokenError, fell through to
  // the plain-message branch, and lost the capture entirely.
  //
  // The same reasoning the log queue already records for its own classifier
  // (see countsAsAttempt in src/offline/queue.ts, which groups NetworkError and
  // AuthTokenError for exactly this cause) — this path had simply not adopted
  // it. Treating a genuinely broken session as "offline" is the safe direction
  // of error: the capture is preserved rather than discarded, and api.ts still
  // owns real session expiry via signOutForExpiredSession.
  //
  // TimeoutError joins the same group for the same reason. Before this
  // client-side deadline existed, a resolve that outlived Istio's 30s cut
  // rejected as a fetch failure — a NetworkError, already queued below. Now
  // api.ts's own REQUEST_TIMEOUT_MS (25s) fires first and throws
  // TimeoutError instead, which matched neither branch here and silently
  // dropped the capture. That's precisely the slow/flaky-cellular scenario
  // this queue exists for, so a timeout gets the same "preserve it" treatment
  // as a network failure.
  // `silent` is set only by the cancelled-resolve path below: Cancel already
  // told the user the screen is going idle, so it does not also get to pop a
  // new Otto bubble about a request it just told capture.tsx to stop waiting
  // on. The capture is still worth preserving — silent controls COPY only:
  // the reassurance on the queued path AND the failure's own message on the
  // non-recoverable one, since a request the user deliberately stopped should
  // not report itself as having gone wrong. (This said "the SUCCESS message
  // only", which was narrower than what the code below has always done —
  // corrected in kora#242, which gave the typed path the same treatment.)
  // It never suppresses the enqueue, and never suppresses a queue refusal: a
  // capture that could not be saved must say so (see the catch below).
  async function handleResolveFailure(
    error: Error,
    file: CaptureFile,
    kind: "photo" | "voice",
    { silent = false }: { silent?: boolean } = {},
  ) {
    if (
      !(error instanceof NetworkError) &&
      !(error instanceof AuthTokenError) &&
      !(error instanceof TimeoutError)
    ) {
      if (!silent) setErrorMsg(ottoErrorMessage(error));
      return;
    }
    try {
      await enqueueCapture(file, kind, mealSlot);
      // Generalises the promise the barcode path already makes at :729.
      if (!silent) {
        setErrorMsg(
          "You're offline — I've saved that, and I'll identify it as soon as you're back online.",
        );
      }
      void queryClient.invalidateQueries({ queryKey: [QUEUED_CAPTURES_KEY] });
    } catch (queueError) {
      // The queue itself refused (full, or nobody signed in) — the capture is
      // GONE. `silent` deliberately does not apply here: it suppresses the
      // reassurance, never the bad news. A refusal swallowed on the cancelled
      // path destroyed the photo or clip with zero indication, which is the one
      // outcome this whole path exists to prevent — the user must either keep
      // the capture or be told plainly that it was discarded.
      //
      // CaptureQueueFullError and NoOwnerError both carry user-facing copy on
      // `message`, so surface it verbatim rather than collapsing to a generic
      // failure; anything else falls back to the original failure's own copy.
      setErrorMsg(
        queueError instanceof CaptureQueueFullError || queueError instanceof NoOwnerError
          ? queueError.message
          : ottoErrorMessage(error),
      );
    }
  }

  async function handleCapturePhoto() {
    await runPhotoPick(pickMealPhoto);
  }

  // The explicit library route offered by the camera-denied card (kora#201).
  // Same outcome handling — only the source of the asset differs.
  async function handleChooseFromLibrary() {
    await runPhotoPick(pickMealFromLibrary);
  }

  async function runPhotoPick(pick: () => Promise<PhotoPickOutcome>) {
    setErrorMsg(null);
    // A retry after fixing the permission in Settings deserves a clean slate,
    // not a stale denied card sitting under whatever this attempt finds.
    setPhotoPermissionDenied(false);
    setCameraDeniedOnTap(false);
    const outcome = await pick();
    if (outcome.status === "canceled") return;
    if (outcome.status === "camera-denied") {
      setCameraDeniedOnTap(true);
      return;
    }
    if (outcome.status === "denied") {
      // A persistent card with a Settings route, not a bubble that scrolls
      // away — the same reasoning as Scan's cameraPermissionDenied.
      setPhotoPermissionDenied(true);
      return;
    }
    if (outcome.status === "failed") {
      setErrorMsg("Something went wrong opening your photos — try again.");
      return;
    }
    const controller = beginResolve();
    resolvePhoto.mutate({ input: outcome.file, signal: controller.signal }, {
      onSuccess: (data) => {
        if (controller.signal.aborted) return;
        applyResolution(data, "ai_photo");
        setResolvedPhrase(null);
      },
      onError: (error) => {
        if (controller.signal.aborted) {
          // Cancel stops the WAITING, not the capture (#136 task 3): route the
          // failure through the same classifier the non-cancelled path uses
          // rather than destroying the photo the user just took. No
          // connectivity snapshot is consulted — an online Cancel arrives as
          // CancelledError, which handleResolveFailure's NetworkError /
          // TimeoutError / AuthTokenError classifier does not queue (there is
          // nothing to resolve later), while a capture that failed because the
          // connection was gone is preserved exactly as an uncancelled one is.
          // silent: true suppresses only the "I've saved that" message; Cancel
          // already took the screen to idle and does not also get to raise a
          // new Otto bubble about the request it just told to stop.
          void handleResolveFailure(error, outcome.file, "photo", { silent: true });
          return;
        }
        void handleResolveFailure(error, outcome.file, "photo");
      },
    });
  }

  // Stop path first (recorder.stop() can throw — a "real" failure, not just
  // a denial — so both branches surface an Otto bubble rather than failing
  // silently, mirroring pickMealPhoto's discipline above).
  async function handleStartVoice() {
    setErrorMsg(null);
    if (isRecordingVoice) return;
    // Same clean-retry reasoning as handleCapturePhoto's reset above.
    setMicPermissionDenied(false);

    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        // A persistent card with a Settings route, not a bubble — see
        // handleCapturePhoto's photoPermissionDenied for the same reasoning.
        setMicPermissionDenied(true);
        return;
      }
      // MUST precede prepareToRecordAsync — see beginRecordingSession. Without
      // it the iOS session is in a playback category and prepare throws.
      await beginRecordingSession();
      await recorder.prepareToRecordAsync();
      recorder.record();
      setIsRecordingVoice(true);
    } catch (error) {
      // Reported, not just shown. The previous `catch {}` discarded the only
      // evidence of WHY recording failed, which is why kora#186 reached a
      // device as an unexplained message rather than a stack trace — the whole
      // mic path looked fine from here. The user-facing copy stays deliberately
      // vague; the diagnosis goes to Sentry.
      reportError(error, { route: "capture/voice-start" });
      void endRecordingSession();
      setErrorMsg("Something went wrong starting the recording — please try again.");
    }
  }

  async function handleFinishVoice() {
    if (!isRecordingVoice) return;
    setErrorMsg(null);

    try {
      await recorder.stop();
    } catch (error) {
      reportError(error, { route: "capture/voice-stop" });
      void endRecordingSession();
      setIsRecordingVoice(false);
      setErrorMsg("Something went wrong recording that — please try again.");
      return;
    }
    void endRecordingSession();
    setIsRecordingVoice(false);

    const uri = recorder.uri;
    if (!uri) {
      setErrorMsg("I didn't catch that — mind trying again?");
      return;
    }
    const file = { uri, name: "clip.m4a", type: "audio/mp4" };
    const controller = beginResolve();
    resolveVoice.mutate({ input: file, signal: controller.signal }, {
      onSuccess: (data) => {
        if (controller.signal.aborted) return;
        applyResolution(data, "ai_voice");
        setResolvedPhrase(data.transcript ?? null);
      },
      onError: (error) => {
        if (controller.signal.aborted) {
          // See handleCapturePhoto's onError above — same reasoning (#136
          // task 3): Cancel preserves the clip via the offline queue instead
          // of destroying it, with handleResolveFailure's own classifier
          // deciding, so an online Cancel (CancelledError) queues nothing.
          void handleResolveFailure(error, file, "voice", { silent: true });
          return;
        }
        void handleResolveFailure(error, file, "voice");
      },
    });
  }

  // Abandon the clip. This is the ONE voice transition with a direct cost
  // consequence if it is wrong: the recorder is stopped and its uri is dropped
  // on the floor, so nothing reaches resolveVoice and no transcription is
  // billed. A stop() failure is swallowed rather than surfaced — the user asked
  // to discard, so there is nothing to tell them.
  async function handleCancelVoice() {
    if (!isRecordingVoice) return;
    setErrorMsg(null);
    try {
      await recorder.stop();
    } catch {
      // deliberately ignored — see above
    }
    void endRecordingSession();
    setIsRecordingVoice(false);
  }

  // The latch (scannedRef) exists so CameraView firing onBarcodeScanned
  // dozens of times a second while a code is in frame doesn't fire dozens of
  // concurrent resolves — it is NOT meant to make scanning one-shot. It must
  // therefore be released on every terminal outcome of the in-flight resolve:
  // success, failure, AND the server's "not recognized" answer (a 200 with a
  // follow-up question, not an error — see barcodeUnknownQuestion in
  // api/internal/resolve/handler.go), which lands in onSuccess like any other
  // resolution. Resetting only in onError (the previous version) left the
  // scanner dead after the very first successful — or unrecognised — scan.
  function handleBarcodeScanned(data: string) {
    if (scannedRef.current) return;
    // The cooldown left by a just-cancelled resolve of THIS code (see
    // handleCancelResolve) — scannedRef has already released by the time
    // this fires again (Task 1's abort resolves onError immediately), so
    // without this check the cancelled code would instantly restart itself.
    if (
      cancelledCodeRef.current === data &&
      Date.now() - cancelledAtRef.current < CANCELLED_CODE_COOLDOWN_MS
    ) {
      return;
    }
    scannedRef.current = true;
    setErrorMsg(null);
    // beginResolve() clears lastScannedCodeRef by default (for every OTHER
    // modality) — set it back to this scan's code immediately after, not
    // before, so this write is the one that survives.
    const controller = beginResolve();
    lastScannedCodeRef.current = data;
    resolveBarcode.mutate({ input: data, signal: controller.signal }, {
      onSuccess: (result) => {
        scannedRef.current = false;
        if (controller.signal.aborted) return;
        // Any barcode succeeding means whatever suppression a prior cancel
        // may have left behind has served its purpose — clear it
        // unconditionally rather than only when the codes differ, so a
        // cancelled-then-later-successful code can't leave a stale entry
        // for a future cancel to re-arm with a fresh timestamp.
        cancelledCodeRef.current = null;
        // A cache hit still means the modality was a barcode scan — no AI
        // ran, but that's a COGS distinction (see #43), not a modality one.
        applyResolution(result, "ai_barcode");
        setResolvedPhrase(null);
      },
      onError: (error) => {
        scannedRef.current = false;
        if (controller.signal.aborted) return;
        setErrorMsg(ottoErrorMessage(error));
      },
    });
  }

  // Logs every not-yet-succeeded candidate in the current resolution as its
  // own diary entry. Only the id/grams/slot/source/timestamp quintet is ever
  // sent — the backend recomputes kcal/macros from the food_item row.
  //
  // Which candidates that is — allSettled, the exclusions, and above all
  // skipping the ones an earlier press already logged (re-logging them is how
  // a retry after a partial failure duplicates diary entries) — is
  // runRetryLedger's, shared verbatim with capture-review.tsx. See
  // src/lib/retryLedger for the rule and why it lives in one place.
  //
  // Candidates the server flagged as uncertain (`tier: "follow_up"`) ARE
  // logged: the server priced them like any other row and the card preselected
  // that top match, captioned as a guess with "tap to change", so the user has
  // already been shown exactly what this writes. Dropping them instead is what
  // left an all-uncertain capture with nothing to log at all.
  async function handleAddToDiary() {
    // effectiveResolution, not resolution: a row the user resolved by hand must
    // log the food they picked, not the guess it replaced.
    const loggableCount =
      effectiveResolution?.candidates.filter((c, i) => isLoggable(c) && !excluded.has(i)).length ?? 0;
    // resolutionSource is set by applyResolution in the same call that sets
    // resolution/effectiveResolution, so a truthy effectiveResolution always
    // implies a truthy resolutionSource — the null check here is just to
    // narrow the type, not a reachable early-return.
    if (!effectiveResolution || loggableCount === 0 || !resolutionSource) return;
    setErrorMsg(null);
    setAdding(true);
    const source = resolutionSource;

    // The retry ledger (src/lib/retryLedger) owns the filtering, the
    // allSettled and the union write — the rule shared with capture-review's
    // Confirm, whose backend is the offline queue rather than this mutation.
    // Only "how to log ONE candidate" is this screen's own (kora#144).
    const attempt = await runRetryLedger({
      candidates: effectiveResolution.candidates,
      // The user's own exclusions (kora#183). This is what makes the checkbox
      // real: without it the CTA count and the diary disagree.
      excluded,
      logged: loggedCandidateKeys,
      markLogged: setLoggedCandidateKeys,
      logCandidate: (candidate) => {
        // Record the portion as one of the food's own named servings when one
        // describes it exactly, so the diary reads "1 portion" instead of
        // "16.5 g" — the same entry the card just showed the user.
        //
        // quantity_grams is still sent. The server prefers the entered pair
        // and re-resolves grams from it (foodlog.resolveEnteredUnit), and
        // because servingEntryFor accepts only exact multiples the two figures
        // are the same number; keeping it means a server that ignores the pair
        // still logs the portion the engine resolved.
        const serving = servingEntryFor(candidate.portion_grams, candidate.item.serving_units ?? []);
        return createLog.mutateAsync({
          food_item_id: candidate.item.id,
          quantity_grams: candidate.portion_grams,
          // Sent explicitly as a real boolean, never left to the "omitted
          // means false" default: candidate.portion_assumed is known here,
          // and coercing it pins the value the card actually showed instead
          // of silently trusting whatever `undefined` happens to mean later.
          portion_assumed: candidate.portion_assumed === true,
          meal_slot: mealSlot,
          source,
          logged_at: new Date().toISOString(),
          ...(serving ? { entered_amount: serving.amount, entered_unit: serving.unit } : {}),
          ...(resolvedPhrase && (source === "ai_text" || source === "ai_voice")
            ? { input_phrase: resolvedPhrase }
            : {}),
        });
      },
    });
    setAdding(false);

    const failedNames = attempt.failed.map(({ candidate }) => candidate.item.name);
    // The count the user is told about — the ledger's own figure, taken
    // against the snapshot this press started from rather than re-read from
    // state, so the message cannot depend on when React flushes the write.
    const loggedSoFarCount = attempt.loggedCount;

    if (failedNames.length > 0) {
      haptics.error();
      setErrorMsg(
        `I logged ${loggedSoFarCount} of ${loggableCount} items, but couldn't log ${failedNames.join(
          ", ",
        )}. Please try again.`,
      );
      return;
    }

    haptics.success();
    // The root ToastProvider outlives this screen, so the confirmation
    // survives the router.back() — without it the only success signal is a
    // haptic, and the user lands on whichever tab they came from with no
    // visible evidence the log happened.
    const count = attempt.succeeded.length;
    toast.show({ message: `Logged ${count} ${count === 1 ? "item" : "items"} to your diary` });
    safeBack("/(tabs)");
  }

  return (
    <View testID="capture-screen-root" style={{ flex: 1, backgroundColor: T.bg }}>
      <CaptureCanvasBackground />
      <CaptureBody
        displayName={profile.data?.display_name?.trim().split(" ")[0] || "there"}
        insetTop={insets.top}
        insetBottom={insets.bottom}
        mode={mode}
        onModeChange={handleModeChange}
        stage={displayStage}
        resolution={effectiveResolution}
        errorMsg={errorMsg}
        transcript={transcript}
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
        onStartVoice={handleStartVoice}
        onFinishVoice={handleFinishVoice}
        onCancelVoice={handleCancelVoice}
        cameraPermissionGranted={cameraPermission?.granted ?? false}
        // `granted === false` is also true for "undetermined" (never asked
        // yet — useCameraPermissions auto-fetches on mount with its default
        // {get: true}, so this resolves before the OS prompt is ever shown).
        // Gate on the real PermissionStatus so a first-time user doesn't see
        // "Open Settings" for a permission that hasn't been requested.
        cameraPermissionDenied={cameraPermission?.status === "denied"}
        photoPermissionDenied={photoPermissionDenied}
        // Either the proactive read (camera already off when the screen
        // opened) or a tap whose request came back denied.
        cameraForPhotoDenied={cameraPermission?.status === "denied" || cameraDeniedOnTap}
        onChooseFromLibrary={handleChooseFromLibrary}
        micPermissionDenied={micPermissionDenied}
        onBarcodeScanned={handleBarcodeScanned}
        // safeBack, not router.back: a reminder tap REPLACES the current route
        // with capture (src/lib/push.ts, so repeated delivery cannot stack
        // capture screens), which leaves this screen mounted with an empty
        // stack. A bare router.back() there dispatches GO_BACK into nothing and
        // the Close button is dead (#171).
        onClose={() => safeBack("/(tabs)")}
        onResolveUncertain={setPickerIndex}
        excluded={excluded}
        onToggleExclude={toggleExcluded}
        onChangePortion={(index, grams) =>
          setPromotedPortion((prev) => ({ ...prev, [index]: { grams, assumed: false } }))
        }
        onCancelResolve={handleCancelResolve}
        onApprovePlan={handleApprovePlan}
        approvingPlanID={approvingPlanID}
      />
      {/* Opened from a row's "Change". Seeded from effectiveResolution, NOT
          `resolution` — otherwise a second visit to an already-corrected row
          re-seeds the search with the food the user just replaced, i.e. the one
          name they have already looked at and rejected (kora#189, found on
          device). `resolution` is the server's untouched answer;
          effectiveResolution carries the promotion, and is what the card
          itself renders — so this also stops the picker and the row disagreeing
          about what the row contains. */}
      <FoodPicker
        visible={pickerIndex !== null}
        initialQuery={
          pickerIndex !== null ? (effectiveResolution?.candidates[pickerIndex]?.item.name ?? "") : ""
        }
        onSelect={(item) => {
          if (pickerIndex !== null) {
            setPromoted((prev) => ({ ...prev, [pickerIndex]: item }));
            // Seed from the NEW food's own serving, so the row is right before
            // the user touches anything — most people will not open the editor.
            setPromotedPortion((prev) => ({ ...prev, [pickerIndex]: initialPortionFor(item) }));
          }
          setPickerIndex(null);
        }}
        onClose={() => setPickerIndex(null)}
        forceDark
      />
    </View>
  );
}
