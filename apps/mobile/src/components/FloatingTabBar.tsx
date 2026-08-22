import { useCallback, useEffect, useRef } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";
import { useReducedTransparency, REDUCED_TRANSPARENCY_FALLBACK } from "./instrument/GlassPanel";
import { PressableScale, springs, useMotionPrefs } from "@/motion";
import { useUnreadCount } from "@/api/hooks";

const TAB_META: Record<string, { icon: string; label: string }> = {
  index: { icon: "house", label: "Today" },
  diary: { icon: "book-open", label: "Diary" },
  progress: { icon: "chart-line", label: "Trends" },
  more: { icon: "grid-2x2", label: "More" },
};

const ORDER_LEFT = ["index", "diary"];
const ORDER_RIGHT = ["progress", "more"];

// Camera cap is raised above the pill (see CaptureButton). The pill spans the
// full width (24px side insets, per the instrument glass spec) with the tabs
// in equal flex slots and a flex slot in the middle reserved for the raised
// camera.
const CAMERA_SIZE = 52;
const CAMERA_RAISE = 16;

// Tab slot is 52x52 — above the 44pt a11y floor with room to spare, and the
// painted area the sliding well tracks.
const TAB_SIZE = 52;
// Vertical breathing room between the icon and the always-on label below it.
const ICON_LABEL_GAP = 4;
// Dynamic Type ceiling for the tab label — see the Text below for the
// arithmetic that picked it over the app's usual 1.6.
const TAB_LABEL_MAX_FONT_MULTIPLIER = 1.2;

// Dock v2 (spec 2026-08-16 "Panel architecture" + "dock v2"): the bar's own
// rim gradient, inlined rather than reused from BezelCluster — different
// radii/stops, so a shared abstraction would be premature.
const RIM_INSET = 1.5;
const PILL_RADIUS = 31;
const PILL_CONTENT_RADIUS = PILL_RADIUS - RIM_INSET;
// minHeight, not height (kora#177): the pill clips with overflow:"hidden",
// and its content includes a label that grows with Dynamic Type. It has to
// be free to grow with it. Dropped from 64 (kora#177) to 58 — dock v2's
// sliding well now carries most of the bar's visual weight itself.
const PILL_MIN_HEIGHT = 58;
// The row's own inset — also the well's pre-measurement default x (see
// `wellX` below), so the first frame lands where the first tab actually is.
const ROW_PADDING_HORIZONTAL = 6;

// Sliding well: the dock capsule silhouette miniaturized (spec "dock v2") —
// a full pill, not a rounded rectangle.
const WELL_HEIGHT = 44;
const WELL_RADIUS = 22;

// The pill's outer bottom edge, measured from the BOTTOM OF THE SCREEN — the
// same 24 as the left/right insets above, so the dock sits in a uniform 24pt
// frame inset rather than a three-sided one.
//
// SCREEN EDGE, NOT SAFE AREA — decided deliberately (kora#280), not by
// omission. On a 956pt iPhone 17 Pro Max the home-indicator inset is 34pt, so
// this bottom edge lands ~10pt inside that region (measured: y=932.2). That is
// fine, and switching to `insets.bottom` would be worse on three counts:
//
//   1. The home indicator is a HINT region, not an exclusion zone. What must
//      clear it is the interactive content, and it does. MEASURED from the
//      live accessibility tree: each tab button's frame is y=875.7 h=52, so
//      its lowest tappable row is 28.3pt above the screen bottom — comparable
//      to a system tab bar, whose own icon row bottoms out at the 34pt inset
//      and whose BACKGROUND runs all the way to the screen edge. It is the
//      pill's unpainted rim and shadow margin that dips into the region, not
//      anything a finger has to reach.
//   2. `insets.bottom` is 0 on a device with no home indicator, which would
//      drop the dock flush against the screen edge — the one outcome nobody
//      wants — so any safe-area form needs a max() floor and stops being
//      simpler than a constant.
//   3. 24 is a design value from the instrument glass spec, paired with the
//      24pt side insets. Safe-area-driving only the bottom breaks that pairing
//      per-device for no gain.
//
// If this ever does change, TAB_BAR_OCCUPIED_HEIGHT below follows it and every
// screen's scroll inset follows that — which is the whole point of kora#280.
const BAR_BOTTOM_INSET = 24;

// How much of the screen, measured up from its bottom edge, the dock occupies.
// The top of the raised capture cap is the highest thing it paints, so it sets
// the ceiling:
//
//   BAR_BOTTOM_INSET  24    pill's outer bottom edge -> screen bottom
//   RIM_INSET * 2      3    the rim gradient's padding, top and bottom
//   PILL_MIN_HEIGHT   58    the glass pill itself
//   CAMERA_RAISE      16    how far the capture cap is lifted above the pill
//                    ---
//                    101
//
// Confirmed against the live accessibility tree (kora#277): on a 956pt screen
// the capture button's frame top measures y=855, i.e. exactly 101 up.
//
// This is a CONSTANT rather than a hook because every term is a constant. The
// one term that could plausibly react to something — BAR_BOTTOM_INSET — is
// deliberately not safe-area-derived (see above), and PILL_MIN_HEIGHT is a
// FLOOR, not a height: under Dynamic Type the pill can grow taller than 58, so
// the true occupied height is >= this. Screens add their own clearance on top
// (below), which absorbs that growth; a measured hook would make every tab
// screen re-render on a layout event to buy back a few points nothing needs.
export const TAB_BAR_OCCUPIED_HEIGHT =
  BAR_BOTTOM_INSET + RIM_INSET * 2 + PILL_MIN_HEIGHT + CAMERA_RAISE;

// Breathing room between the last pixel of scrollable content and the top of
// the dock, at the true scroll bottom.
const TAB_BAR_CONTENT_GAP = 39;
const TAB_BAR_CONTENT_GAP_TODAY = 44;

/**
 * `paddingBottom` for a tab screen's scroll content, so the last item clears
 * the dock. Used by Diary, Trends and More. (= 140)
 */
export const TAB_BAR_SCROLL_INSET = TAB_BAR_OCCUPIED_HEIGHT + TAB_BAR_CONTENT_GAP;

/**
 * The same, 5pt looser. Used ONLY by Today. (= 145)
 *
 * Today ends in a tappable row ("Log a meal") rather than a list, and an
 * overscroll bounce dragged it into the capture cap's glow. The extra clearance
 * parks it above the fade's start so the bounce fades it out instead.
 */
export const TAB_BAR_SCROLL_INSET_TODAY = TAB_BAR_OCCUPIED_HEIGHT + TAB_BAR_CONTENT_GAP_TODAY;

// REMOVED (kora#354): a "ground fade" scrim used to sit under the dock,
// fading transparent -> instrument.bg so content scrolling underneath faded
// out rather than colliding with the pill.
//
// It could never be invisible. AppBackground does not paint instrument.bg
// flat — it lays three radial pools over it, and bg-pool-3 sits at cy 96%,
// which is exactly where the dock is. So the scrim painted a flat cool grey
// over the warmest part of the background: a slab, edged where the gradient
// reached full opacity, across the whole screen width on every tab.
//
// Matching it was the wrong repair. A vertical linear gradient cannot equal a
// radial pool, and any scrim that has to mirror AppBackground's internals
// breaks again the moment those internals change. If the fade is wanted back,
// fade the CONTENT (a mask over the scrolling view) instead of painting a
// replica of the background over it.

// Domed capture face — precomputed [highlight, accent, shadow] mixes per
// scheme so the button reads as lit from above rather than a flat disc.
// Dark: base #FF4A00 lightened -> #FF8149, darkened -> #C93A00.
// Light: base #D23800 lightened -> #E2703D, darkened -> #A62C00.
const CAPTURE_FACE_GRADIENT = {
  dark: ["#FF8149", "#FF4A00", "#C93A00"],
  light: ["#E2703D", "#D23800", "#A62C00"],
} as const;

type FloatingTabBarProps = {
  state: { index: number; routes: ReadonlyArray<{ key: string; name: string }> };
  navigation: { navigate: (name: string) => void };
};

type TabButtonProps = {
  meta: { icon: string; label: string };
  active: boolean;
  showBadge: boolean;
  reduceMotion: boolean;
  onPress: () => void;
};

function TabButton({ meta, active, showBadge, reduceMotion, onPress }: TabButtonProps) {
  const { instrument } = useTheme();
  const scale = useSharedValue(1);

  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  // Icon pop on press (spec "dock v2"): a quick squash then a lively spring
  // back, distinct from the well's own slide. Skipped under Reduce Motion —
  // the well still jumps to the new tab, but nothing else pops.
  const handlePress = useCallback(() => {
    if (!reduceMotion) {
      scale.value = withSequence(withTiming(0.82, { duration: 140 }), withSpring(1, springs.lively));
    }
    onPress();
  }, [onPress, reduceMotion, scale]);

  return (
    <PressableScale
      accessibilityLabel={meta.label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      haptic="selection"
      onPress={handlePress}
      // minWidth, not width: 52 is the size of the PAINTED box (the icon and
      // the sliding well that tracks it), not the space available — each tab
      // sits in a flex:1 slot roughly 63-76pt wide depending on device. Pinning
      // the button to 52 constrained the label's measurement to 52 too, which
      // is what wrapped "TRENDS" to "TREN/DS" and let the pill clip it
      // (kora#173). Growing here costs nothing: the well is positioned from the
      // slot and a fixed TAB_SIZE (see handleSlotLayout), so it does not follow
      // this box, and at `medium` every label is narrower than 52 so the
      // rendering is byte-identical.
      style={{
        minWidth: TAB_SIZE,
        height: TAB_SIZE,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Animated.View testID="tab-icon" style={[{ marginBottom: ICON_LABEL_GAP }, iconStyle]}>
        <Icon name={meta.icon} size={22} color={active ? instrument.ink : instrument.mut} strokeWidth={active ? 2.5 : 2} />
      </Animated.View>
      {/* At 9px an engraved label separates by weight long before it
          separates by hue, so the inactive state is demoted twice over:
          `mut` at 500 and held back to 72% opacity, against full-opacity
          `ink` at 700. Always rendered (dock v2) — the label is no longer
          the active tab's exclusive tell, the sliding well is. */}
      <Text
        // Capping Dynamic Type is legitimate here — a six-letter label backed
        // by an icon carrying the same meaning, in a dock that must not grow
        // to twice its height at a 310% setting. But the old 1.6 ceiling did
        // not honour its own reasoning: MEASURED at accessibility-extra-large,
        // "TRENDS" wrapped to "TREN/DS" and the pill clipped it (kora#173).
        // 1.2 (9pt -> 10.8pt) is what the widest label actually fits in: at
        // 1.2 with the button free to grow (above) "TRENDS" measures ~55pt,
        // inside the ~63-76pt slot; at 1.6 it needs ~62pt and crowds its
        // neighbours on a 375pt-wide device. numberOfLines is the hard
        // guarantee behind the cap — a mid-word break misreads the label, so
        // anything that still cannot fit truncates visibly instead of
        // splitting. Verified on the simulator at both text sizes.
        maxFontSizeMultiplier={TAB_LABEL_MAX_FONT_MULTIPLIER}
        numberOfLines={1}
        style={{
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: 1.4,
          fontWeight: active ? "700" : "500",
          opacity: active ? 1 : 0.72,
          color: active ? instrument.ink : instrument.mut,
        }}
      >
        {meta.label}
      </Text>
      {showBadge ? (
        <View
          testID="more-unread-badge"
          style={{
            position: "absolute",
            top: -2,
            right: -2,
            width: 9,
            height: 9,
            borderRadius: 5,
            backgroundColor: instrument.accent,
            borderWidth: 1.5,
            borderColor: instrument.bg,
          }}
        />
      ) : null}
    </PressableScale>
  );
}

// Raised, glowing camera cap. Rendered as a SIBLING of the glass pill (not a
// child) — the pill uses overflow:"hidden" for its blur/border-radius, which
// would clip a button positioned above its top edge.
function CaptureButton() {
  const { instrument, scheme } = useTheme();

  return (
    <PressableScale
      accessibilityLabel="Capture"
      accessibilityRole="button"
      haptic="impactLight"
      onPress={() => router.push("/capture")}
      style={{
        width: CAMERA_SIZE,
        height: CAMERA_SIZE,
        borderRadius: CAMERA_SIZE / 2,
        alignItems: "center",
        justifyContent: "center",
        shadowColor: instrument.accent,
        shadowOpacity: 0.5,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 10 },
        elevation: 10,
      }}
    >
      <LinearGradient
        testID="capture-face"
        colors={CAPTURE_FACE_GRADIENT[scheme]}
        style={[StyleSheet.absoluteFill, { borderRadius: CAMERA_SIZE / 2 }]}
      />
      <Icon name="camera" size={22} color={instrument.accentOn} />
    </PressableScale>
  );
}

export function FloatingTabBar({ state, navigation }: FloatingTabBarProps) {
  const { instrument, scheme } = useTheme();
  const reducedTransparency = useReducedTransparency();
  const { reduceMotion } = useMotionPrefs();
  const activeName = state.routes[state.index]?.name;
  const unread = useUnreadCount();
  const unreadCount = unread.data?.count ?? 0;

  // Per-tab {x, width} within the row, measured via onLayout on each slot and
  // recentered onto the fixed TAB_SIZE box the well actually tracks (slots
  // are flex:1, so their own width varies with available space; the button
  // inside each is centered and fixed-size).
  const layouts = useRef<Record<string, { x: number; width: number }>>({});
  // Pre-`onLayout` default: the first tab sits right after the row's own
  // horizontal padding, so the well's first-frame position (before any slot
  // has measured) starts there rather than at the row's left edge.
  const wellX = useSharedValue(ROW_PADDING_HORIZONTAL);
  const wellWidth = useSharedValue(TAB_SIZE);

  const positionWell = useCallback(
    (name: string | undefined) => {
      const layout = name ? layouts.current[name] : undefined;
      if (!layout) return;
      if (reduceMotion) {
        wellX.value = withTiming(layout.x, { duration: 0 });
        wellWidth.value = withTiming(layout.width, { duration: 0 });
      } else {
        wellX.value = withSpring(layout.x, springs.lively);
        wellWidth.value = withSpring(layout.width, springs.lively);
      }
    },
    [reduceMotion, wellX, wellWidth],
  );

  useEffect(() => {
    positionWell(activeName);
  }, [activeName, positionWell]);

  const wellStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: wellX.value }],
    width: wellWidth.value,
  }));

  const handleSlotLayout = (name: string) => (e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    layouts.current[name] = { x: x + (width - TAB_SIZE) / 2, width: TAB_SIZE };
    if (name === activeName) positionWell(name);
  };

  const renderTab = (name: string) => {
    const meta = TAB_META[name];
    if (!meta) return null;
    return (
      <TabButton
        key={name}
        meta={meta}
        active={activeName === name}
        showBadge={name === "more" && unreadCount > 0}
        reduceMotion={reduceMotion}
        onPress={() => navigation.navigate(name)}
      />
    );
  };

  const slot = (name: string) => (
    <View key={name} style={{ flex: 1, alignItems: "center" }} onLayout={handleSlotLayout(name)}>
      {renderTab(name)}
    </View>
  );

  // The sliding well: absolutely positioned across the whole row so its
  // translateX lands in the same coordinate space the slots' onLayout
  // reports were measured in. `pointerEvents="none"` — it is a painted
  // indicator, not a tap target, and must not steal presses from the tabs
  // it sits behind.
  const dockWell = (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Animated.View
          testID="dock-well"
          style={[
            {
              height: WELL_HEIGHT,
              borderRadius: WELL_RADIUS,
              backgroundColor: instrument.inset,
              overflow: "hidden",
            },
            wellStyle,
          ]}
        >
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: instrument.wellShadow }} />
          <View
            testID="dock-well-dot"
            style={{
              position: "absolute",
              bottom: 4,
              alignSelf: "center",
              width: 4,
              height: 4,
              borderRadius: 2,
              backgroundColor: instrument.accent,
              shadowColor: instrument.accent,
              shadowOpacity: 0.7,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 0 },
            }}
          />
        </Animated.View>
      </View>
    </View>
  );

  const rowStyle = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingHorizontal: ROW_PADDING_HORIZONTAL,
    minHeight: PILL_MIN_HEIGHT,
    borderRadius: PILL_CONTENT_RADIUS,
    borderWidth: 1,
    borderColor: instrument.glassBorder,
    overflow: "hidden" as const,
  };

  return (
    <View
      testID="tab-bar-root"
      style={{ position: "absolute", left: 24, right: 24, bottom: BAR_BOTTOM_INSET }}
      pointerEvents="box-none"
    >
      <View style={{ position: "relative" }}>
        <LinearGradient
          testID="dock-rim"
          colors={[instrument.glassHighlight, "transparent", instrument.shade]}
          locations={[0, 0.3, 0.92]}
          style={{ borderRadius: PILL_RADIUS, padding: RIM_INSET }}
        >
          {reducedTransparency ? (
            // Reduce Transparency fallback (I3, same recipe as GlassPanel):
            // an opaque pill instead of a live BlurView.
            <View
              testID="tab-bar-pill"
              style={[rowStyle, { backgroundColor: REDUCED_TRANSPARENCY_FALLBACK[scheme] }]}
            >
              {dockWell}
              {ORDER_LEFT.map(slot)}
              <View style={{ flex: 1 }} />
              {ORDER_RIGHT.map(slot)}
            </View>
          ) : (
            <BlurView
              testID="tab-bar-pill-blur"
              intensity={scheme === "dark" ? 25 : 40}
              tint={scheme === "dark" ? "dark" : "light"}
              style={[rowStyle, { backgroundColor: instrument.glass }]}
            >
              {dockWell}
              {ORDER_LEFT.map(slot)}
              <View style={{ flex: 1 }} />
              {ORDER_RIGHT.map(slot)}
            </BlurView>
          )}
        </LinearGradient>
        <View
          style={{ position: "absolute", top: -CAMERA_RAISE, left: 0, right: 0, alignItems: "center" }}
          pointerEvents="box-none"
        >
          <CaptureButton />
        </View>
      </View>
    </View>
  );
}
