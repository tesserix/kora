import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
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
import * as ImagePicker from "expo-image-picker";
import { CameraView, useCameraPermissions } from "expo-camera";
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder } from "expo-audio";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { OttoBubble } from "@/components/capture/OttoBubble";
import { ModePill } from "@/components/capture/ModePill";
import { Waveform } from "@/components/capture/Waveform";
import { VoiceComposer } from "@/components/capture/VoiceComposer";
import { ResolutionResult, candidateKey } from "@/components/ResolutionResult";
import { FoodPicker } from "@/components/meal/FoodPicker";
import { withAlpha } from "@/lib/color";
import { useToast } from "@/components/Toast";
import { INSTRUMENT_DARK_FIXED } from "@/theme";
import { haptics } from "@/motion";
import {
  useCreateLog,
  useProfile,
  useResolveBarcode,
  useResolvePhoto,
  useResolveText,
  useResolveVoice,
} from "@/api/hooks";
import { ApiError, AuthTokenError, NetworkError, ResponseParseError, TimeoutError } from "@/lib/api";
import { OfflineUnknownBarcodeError } from "@/offline/cachedResolution";
import { CaptureQueueFullError } from "@/offline/captureQueue";
import { enqueueCapture, type CaptureFile } from "@/offline/enqueueCapture";
import { NoOwnerError } from "@/offline/owner";
import { QUEUED_CAPTURES_KEY } from "@/offline/queryKeys";
import { isLoggable } from "@/lib/candidateTier";
import { servingEntryFor } from "@/units/portion";
import type { FoodItem, Resolution, ResolutionSource } from "@/api/types";
import { mealSlotForHour, type MealSlot } from "@/lib/mealSlot";

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
}

function PermissionDenied({ message, icon, onDescribeInstead }: PermissionDeniedProps) {
  return (
    <View
      testID="capture-permission-denied"
      style={{
        height: 200,
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
      <Pressable
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
      </Pressable>
      {/* Secondary route — not accent. Text resolution needs no camera, so a
          denied permission still doesn't have to be a dead end. */}
      <Pressable accessibilityRole="button" accessibilityLabel="Describe it instead" onPress={onDescribeInstead}>
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
  micPermissionDenied,
  onBarcodeScanned,
  onDescribeInstead,
}: IdleAffordanceProps) {
  if (mode === "photo") {
    if (photoPermissionDenied) {
      return (
        <PermissionDenied
          message="I need camera or photo access to see your meal. Turn it on in Settings, or tell me what you ate instead."
          icon="camera"
          onDescribeInstead={onDescribeInstead}
        />
      );
    }
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
      </Pressable>
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
  onStartVoice: () => void;
  onFinishVoice: () => void;
  onCancelVoice: () => void;
  cameraPermissionGranted: boolean;
  /** True only once the OS has actually refused camera access — distinct
   *  from "not yet granted", which also covers the not-yet-requested and
   *  still-requesting states. Drives the Scan idle affordance's denied UI. */
  cameraPermissionDenied?: boolean;
  /** True once expo-image-picker's camera+library request has actually come
   *  back denied. Drives the Photo idle affordance's denied UI. */
  photoPermissionDenied?: boolean;
  /** True once expo-audio's mic permission request has actually come back
   *  denied. Drives the Voice idle affordance's denied UI. */
  micPermissionDenied?: boolean;
  onBarcodeScanned: (data: string) => void;
  onClose: () => void;
  /** Forwarded to DetectedCard — asked when the user taps an uncertain row. */
  onResolveUncertain?: (index: number) => void;
  /** Bails out of the in-flight resolve and returns to idle. Analyzing-state only. */
  onCancelResolve?: () => void;
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
  onStartVoice,
  onFinishVoice,
  onCancelVoice,
  cameraPermissionGranted,
  cameraPermissionDenied = false,
  photoPermissionDenied = false,
  micPermissionDenied = false,
  onBarcodeScanned,
  onClose,
  onResolveUncertain,
  onCancelResolve,
}: CaptureBodyProps) {
  const scrollViewRef = useRef<ScrollView>(null);
  const composerFieldRef = useRef<TextInput>(null);
  // Typing is an input only where it is the point. In voice and scan the
  // middle of the composer is static guidance, so there is no dead field.
  const showsTextField = mode === "photo" || mode === "type";

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
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={ROUND_BUTTON}>
          <Icon name="x" size={20} color={T.ink} />
        </Pressable>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Icon name="camera" size={17} color={T.accent} />
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
            micPermissionDenied={micPermissionDenied}
            onBarcodeScanned={onBarcodeScanned}
            onDescribeInstead={() => onModeChange("type")}
          />
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
            <Pressable
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
            </Pressable>
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
            <Pressable
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
            </Pressable>
          )}
          {/* Typing is only an input in photo/type. In voice and scan the middle
              is static guidance, so there is no dead field to tab into. */}
          {showsTextField ? (
            <TextInput
              ref={composerFieldRef}
              accessibilityLabel="Tell Otto what you ate"
              value={text}
              onChangeText={onChangeText}
              placeholder="Tell Otto what you ate…"
              placeholderTextColor={T.mut}
              style={{ flex: 1, color: T.ink, fontSize: 15 }}
            />
          ) : (
            <AppText style={{ flex: 1, color: T.mut, fontSize: 15 }}>
              {mode === "voice" ? "Hold the mic to record" : "Point at a barcode"}
            </AppText>
          )}
          {/* Send — resolves the typed phrase via useResolveText. */}
          {showsTextField ? (
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
              backgroundColor: text.trim() ? T.accent : withAlpha(T.ink, 0.15),
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="arrow-up" size={19} color={text.trim() ? T.accentOn : T.ink} />
          </Pressable>
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
    return "You're offline, and this isn't a barcode you've scanned before. I'll recognise it once you're back online.";
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
    // Deliberately does not promise "I've saved that" — this function is also
    // reached from the barcode and typed-text paths (handleBarcodeScanned,
    // handleSend), neither of which calls enqueueCapture. Only
    // handleResolveFailure's own branch (below) actually queues on timeout;
    // this copy stays honest about the timeout itself for every other caller.
    return "That took too long — mind trying again?";
  }
  return "Something went wrong while I looked at that. Please try again.";
}

export default function CaptureScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const toast = useToast();
  const profile = useProfile();
  const resolveText = useResolveText();
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
  const [micPermissionDenied, setMicPermissionDenied] = useState(false);
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
  const [text, setText] = useState("");
  // The phrase that produced the current resolution. `text` is cleared as soon
  // as the resolve fires, so it cannot be read at add-to-diary time — but the
  // correction loop needs the exact words the user used, since that is the key
  // a later correction teaches the food index under. Set (or explicitly
  // cleared to null) in the same onSuccess handler that calls applyResolution,
  // so it can never lag behind — and never a later, unrelated resolution.
  const [resolvedPhrase, setResolvedPhrase] = useState<string | null>(null);
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
    (resolveText.isPending || resolvePhoto.isPending || resolveVoice.isPending || resolveBarcode.isPending)
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
      candidates: resolution.candidates.map((candidate, i) =>
        promoted[i]
          ? { ...candidate, item: promoted[i], kcal: 0, tier: "confirm" as const, kcal_unknown: true }
          : candidate,
      ),
    };
  }, [resolution, promoted]);

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
    setPickerIndex(null);
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
    // A denial recorded against the mode being left must not linger — coming
    // back later (e.g. after fixing it in Settings) should get a clean retry,
    // not a stale card.
    setPhotoPermissionDenied(false);
    setMicPermissionDenied(false);
    scannedRef.current = false;
  }

  function handleSend() {
    const phrase = text.trim();
    if (!phrase) return;
    setErrorMsg(null);
    // Fires right as send is pressed — the composer's own keyboard should
    // not stay up covering the result thread once a send is in flight.
    Keyboard.dismiss();
    const controller = beginResolve();
    resolveText.mutate({ input: phrase, signal: controller.signal }, {
      onSuccess: (data) => {
        // A cancel that lands between mutate() firing and this callback
        // means the user has already moved on — applying it now would
        // resurrect a result onto a screen that told them it was abandoned.
        if (controller.signal.aborted) return;
        applyResolution(data, "ai_text");
        setResolvedPhrase(phrase);
        setText("");
      },
      onError: (error) => {
        if (controller.signal.aborted) return;
        setErrorMsg(ottoErrorMessage(error));
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
  // on. The capture is still worth preserving — silent controls the SUCCESS
  // message only. It never suppresses the enqueue, and never suppresses a
  // queue refusal: a capture that could not be saved must say so (see the
  // catch below).
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
    setErrorMsg(null);
    // A retry after fixing the permission in Settings deserves a clean slate,
    // not a stale denied card sitting under whatever this attempt finds.
    setPhotoPermissionDenied(false);
    const outcome = await pickMealPhoto();
    if (outcome.status === "canceled") return;
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
      await recorder.prepareToRecordAsync();
      recorder.record();
      setIsRecordingVoice(true);
    } catch {
      setErrorMsg("Something went wrong starting the recording — please try again.");
    }
  }

  async function handleFinishVoice() {
    if (!isRecordingVoice) return;
    setErrorMsg(null);

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
  // sent — the backend recomputes kcal/macros from the food_item row. Uses
  // allSettled (not Promise.all) so a single failing candidate doesn't hide
  // whether the *other* candidates were logged — required to avoid a
  // partial silent success per the task's error-handling discipline.
  //
  // Candidates already recorded in `loggedCandidateKeys` (from an earlier
  // press of this same card) are skipped entirely — otherwise re-pressing
  // "Add to diary" after a partial failure would re-log the ones that
  // already succeeded, duplicating diary entries.
  //
  // Candidates the server flagged as uncertain (`tier: "follow_up"`) ARE
  // logged: the server priced them like any other row and the card preselected
  // that top match, captioned as a guess with "tap to change", so the user has
  // already been shown exactly what this writes. Dropping them instead is what
  // left an all-uncertain capture with nothing to log at all.
  async function handleAddToDiary() {
    // effectiveResolution, not resolution: a row the user resolved by hand must
    // log the food they picked, not the guess it replaced.
    const loggableCount = effectiveResolution?.candidates.filter(isLoggable).length ?? 0;
    // resolutionSource is set by applyResolution in the same call that sets
    // resolution/effectiveResolution, so a truthy effectiveResolution always
    // implies a truthy resolutionSource — the null check here is just to
    // narrow the type, not a reachable early-return.
    if (!effectiveResolution || loggableCount === 0 || !resolutionSource) return;
    setErrorMsg(null);
    setAdding(true);
    const source = resolutionSource;

    const pending = effectiveResolution.candidates
      .map((candidate, index) => ({ candidate, key: candidateKey(candidate, index) }))
      .filter(({ candidate }) => isLoggable(candidate))
      .filter(({ key }) => !loggedCandidateKeys.has(key));

    const outcomes = await Promise.allSettled(
      pending.map(({ candidate }) => {
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
      }),
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
      haptics.error();
      setErrorMsg(
        `I logged ${updatedKeys.size} of ${loggableCount} items, but couldn't log ${failedNames.join(
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
    const count = newlySucceededKeys.length;
    toast.show({ message: `Logged ${count} ${count === 1 ? "item" : "items"} to your diary` });
    router.back();
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
        micPermissionDenied={micPermissionDenied}
        onBarcodeScanned={handleBarcodeScanned}
        onClose={() => router.back()}
        onResolveUncertain={setPickerIndex}
        onCancelResolve={handleCancelResolve}
      />
      {/* Opened from an uncertain row. Seeded with the phrase the server could
          not resolve, so the user starts from what they actually said. */}
      <FoodPicker
        visible={pickerIndex !== null}
        initialQuery={pickerIndex !== null ? (resolution?.candidates[pickerIndex]?.item.name ?? "") : ""}
        onSelect={(item) => {
          if (pickerIndex !== null) setPromoted((prev) => ({ ...prev, [pickerIndex]: item }));
          setPickerIndex(null);
        }}
        onClose={() => setPickerIndex(null)}
        forceDark
      />
    </View>
  );
}
