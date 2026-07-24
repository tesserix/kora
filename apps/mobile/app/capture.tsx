import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { OttoBubble } from "@/components/capture/OttoBubble";
import { UserBubble } from "@/components/capture/UserBubble";
import { ModePill } from "@/components/capture/ModePill";
import { Waveform } from "@/components/capture/Waveform";
import { DetectedCard } from "@/components/capture/DetectedCard";
import { captureColors } from "@/components/capture/captureTheme";
import { useProfile } from "@/api/hooks";
import type { Resolution } from "@/api/types";
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
}

// The per-mode "empty" affordance shown in the thread before a capture
// starts. Tapping these is intentionally a no-op in this task — the real
// camera/mic/scanner triggers are wired by later tasks.
function IdleAffordance({ mode }: IdleAffordanceProps) {
  if (mode === "photo") {
    return (
      <Pressable
        testID="capture-idle-photo"
        accessibilityRole="button"
        accessibilityLabel="Photo viewfinder"
        onPress={() => {}}
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
        <View
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
        </View>
        <Waveform active />
        <AppText style={{ color: captureColors.onSurfaceMuted, fontSize: 13, fontWeight: "600" }}>
          Listening… tell Otto what you ate
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

interface CaptureBodyProps {
  displayName: string;
  insetTop: number;
  mode: CaptureMode;
  onModeChange: (mode: CaptureMode) => void;
  stage: CaptureStage;
  resolution: Resolution | null;
  mealSlot: MealSlot;
  onChangeMealSlot: (slot: MealSlot) => void;
  onAdd: () => void;
  adding: boolean;
  text: string;
  onChangeText: (text: string) => void;
  onClose: () => void;
}

// Presentational capture surface — pure props in, no state, no API calls.
// Exported (in addition to the default route) so the result/analyzing stages
// can be exercised directly in tests without simulating a full capture flow.
export function CaptureBody({
  displayName,
  insetTop,
  mode,
  onModeChange,
  stage,
  resolution,
  mealSlot,
  onChangeMealSlot,
  onAdd,
  adding,
  text,
  onChangeText,
  onClose,
}: CaptureBodyProps) {
  return (
    <View style={{ flex: 1, backgroundColor: captureColors.surface }}>
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
          <Icon name="sparkles" size={17} color={captureColors.primary} />
          <AppText style={{ color: captureColors.onSurface, fontWeight: "700" }}>Ask Otto</AppText>
        </View>
        {/* Reserved for a future gallery/history view — no-op in this task. */}
        <Pressable accessibilityRole="button" accessibilityLabel="Photo library" onPress={() => {}} style={ROUND_BUTTON}>
          <Icon name="images" size={18} color={captureColors.onSurface} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 18, paddingTop: 8, gap: 14 }}
        style={{ flex: 1 }}
      >
        <OttoBubble>
          Hi {displayName} — show me your meal or just tell me what you ate. A photo works great. 📷 is optional; words
          work too.
        </OttoBubble>

        {stage === "idle" && <IdleAffordance mode={mode} />}

        {stage === "analyzing" && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 40 }}>
            <AnalyzingSpinner />
            <AppText style={{ color: captureColors.onSurfaceMuted, fontSize: 13 }}>Otto is analyzing…</AppText>
          </View>
        )}

        {stage === "result" && resolution && (
          <>
            <OttoBubble>
              Got it — I found {resolution.candidates.length} item{resolution.candidates.length === 1 ? "" : "s"}.
              Confirm and I&apos;ll log it to {mealSlot}.
            </OttoBubble>
            <DetectedCard
              resolution={resolution}
              mealSlot={mealSlot}
              onChangeMealSlot={onChangeMealSlot}
              onAdd={onAdd}
              adding={adding}
            />
          </>
        )}
      </ScrollView>

      <View
        style={{
          paddingHorizontal: 14,
          paddingTop: 10,
          paddingBottom: 26,
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
          {/* Quick-capture shortcut — no-op until Tasks 5/6 wire the camera. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Quick photo capture"
            onPress={() => {}}
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
          {/* Send — no-op until a future task wires text resolution. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            onPress={() => {}}
            style={{
              width: 38,
              height: 38,
              borderRadius: 9999,
              backgroundColor: text ? captureColors.primary : "rgba(255,255,255,0.15)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="arrow-up" size={19} color={captureColors.onSurface} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export default function CaptureScreen() {
  const insets = useSafeAreaInsets();
  const profile = useProfile();
  const [mode, setMode] = useState<CaptureMode>("photo");
  // Tasks 5-7 drive real stage/resolution/error transitions (photo/voice/scan
  // capture, text send, and the add-to-diary mutation); this task only wires
  // the shell so those can slot in without restructuring the screen.
  const [stage, setStage] = useState<CaptureStage>("idle");
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mealSlot, setMealSlot] = useState<MealSlot>(() => mealSlotForHour(new Date().getHours()));
  const [text, setText] = useState("");

  function handleModeChange(next: CaptureMode) {
    setMode(next);
    setStage("idle");
  }

  return (
    <View style={{ flex: 1, backgroundColor: captureColors.surface }}>
      <CaptureBody
        displayName={profile.data?.display_name?.split(" ")[0] ?? "there"}
        insetTop={insets.top}
        mode={mode}
        onModeChange={handleModeChange}
        stage={stage}
        resolution={resolution}
        mealSlot={mealSlot}
        onChangeMealSlot={setMealSlot}
        onAdd={() => {}}
        adding={false}
        text={text}
        onChangeText={setText}
        onClose={() => router.back()}
      />
      {errorMsg ? (
        <View style={{ position: "absolute", bottom: 100, left: 18, right: 18 }}>
          <AppText style={{ color: captureColors.onSurface, textAlign: "center" }}>{errorMsg}</AppText>
        </View>
      ) : null}
    </View>
  );
}
