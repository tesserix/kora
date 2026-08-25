import { View } from "react-native";

import { Sheet } from "@/components/Sheet";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

import type { CircleMember } from "@/api/types";

interface Props {
  visible: boolean;
  members: CircleMember[];
  onCancel: () => void;
  onConfirm: () => void;
  pending?: boolean;
}

// Granting `body` asks first, and this is the asking (kora#326 §Surfaces).
//
// It is a Sheet rather than an inline panel, and that is a bug fix, not a
// style preference (kora#443). The first version rendered in normal document
// flow between the category toggles and the member list, so appearing pushed
// the member list, "Add someone" and the destructive "Delete circle" DOWNWARD
// by its own height. During on-device verification a tap aimed at a measured
// position landed on "Delete circle" because of that reflow. A Sheet displaces
// nothing.
//
// It also could not be missed the way an inline panel can: on a circle with
// many members the inline version could render below the fold, making the
// toggle look inert.
//
// The actions go in Sheet's `footer` so they stay pinned outside the scrolling
// body — the same reason that prop exists for BodyCompositionForm's Save.
export function ConfirmBodyShareSheet({ visible, members, onCancel, onConfirm, pending }: Props) {
  const { instrument, spacing } = useTheme();

  // By name, as an actual list. "3 members" is exactly the abstraction that
  // lets someone agree to something they have not pictured, which is why the
  // spec requires names and why this is asserted in tests.
  const names = members.map((m) => m.display_name).join(", ");

  return (
    <Sheet
      visible={visible}
      onClose={onCancel}
      footer={
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: spacing.lg }}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Cancel sharing body metrics"
            haptic="selection"
            onPress={onCancel}
          >
            <AppText style={{ fontSize: 16, color: instrument.mut }}>Cancel</AppText>
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Confirm sharing body metrics"
            haptic="selection"
            disabled={pending}
            onPress={onConfirm}
          >
            <AppText style={{ fontSize: 16, fontWeight: "700", color: instrument.accent }}>Share</AppText>
          </PressableScale>
        </View>
      }
    >
      {/* Sheet pads its own footer but not its children — every
          consumer supplies this itself (see CreateGroupSheet). */}
      <View style={{ paddingHorizontal: 22, paddingBottom: 30, gap: spacing.sm }}>
        <AppText style={{ fontSize: 17, fontWeight: "700", color: instrument.ink }}>
          Share your body metrics?
        </AppText>
        <AppText style={{ fontSize: 14, color: instrument.mut }}>
          This shares your weight, measurements, and body fat with:
        </AppText>
        <AppText testID="body-confirm-names" style={{ fontSize: 16, color: instrument.ink }}>
          {names}
        </AppText>
      </View>
    </Sheet>
  );
}
