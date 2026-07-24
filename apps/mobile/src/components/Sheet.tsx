import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useTheme } from "@/theme";

type Props = { visible: boolean; onClose: () => void; children: ReactNode };

export function Sheet({ visible, onClose, children }: Props) {
  const { colors, radius, shadows } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(10,20,15,0.38)", justifyContent: "flex-end" }}>
        <Pressable
          onPress={() => {}}
          style={[
            { maxHeight: "82%", backgroundColor: colors.background, borderTopLeftRadius: radius["2xl"], borderTopRightRadius: radius["2xl"] },
            shadows.lg,
          ]}
        >
          <View style={{ alignItems: "center", paddingTop: 10 }}>
            <View style={{ width: 40, height: 5, borderRadius: 999, backgroundColor: colors.border }} />
          </View>
          <ScrollView>{children}</ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
