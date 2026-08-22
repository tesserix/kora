import { View } from "react-native";
import { AppText } from "@/components/Text";
import { Icon } from "@/components/Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

interface Props {
  expanded: boolean;
  onToggle: () => void;
}

/**
 * The single row that reveals `BodyCompositionForm`'s nine composition
 * fields (kora#314 PR C, #45's own "two taps stays two taps" rule).
 *
 * Deliberately plain: one label, one chevron, no count badge or preview of
 * what's behind it — the product ask was "keep it plain", and a form this
 * information-dense doesn't need its own teaser copy.
 */
export function CompositionMoreToggle({ expanded, onToggle }: Props) {
  const { instrument } = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel="More fields"
      accessibilityState={{ expanded }}
      haptic="selection"
      onPress={onToggle}
      testID="composition-expand-toggle"
      style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }}
    >
      <AppText style={{ fontSize: 13, fontWeight: "600", color: instrument.mut }}>
        {expanded ? "Fewer fields" : "More fields"}
      </AppText>
      {/* Points right collapsed, down expanded — the one existing disclosure
          glyph (`chevron-right`) rotated rather than a second icon asset. */}
      <View style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}>
        <Icon name="chevron-right" size={13} color={instrument.mut} />
      </View>
    </PressableScale>
  );
}
