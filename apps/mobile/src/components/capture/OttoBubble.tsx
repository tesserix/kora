import type { ReactNode } from "react";
import { View } from "react-native";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { captureColors } from "./captureTheme";

interface Props {
  children: ReactNode;
}

// Otto's chat bubble — camera avatar + translucent bubble, top-left corner
// squared off (radius 6) to point back at the avatar, per CaptureScreen.jsx.
export function OttoBubble({ children }: Props) {
  return (
    <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
      <View
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          borderRadius: 9999,
          backgroundColor: captureColors.primary,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 3,
          borderColor: captureColors.primaryGlow,
        }}
      >
        <Icon name="camera" size={16} color={captureColors.primaryForeground} />
      </View>
      <View
        style={{
          flexShrink: 1,
          backgroundColor: captureColors.bubbleBg,
          borderWidth: 1,
          borderColor: captureColors.bubbleBorder,
          borderRadius: 16,
          borderTopLeftRadius: 6,
          paddingHorizontal: 14,
          paddingVertical: 12,
          maxWidth: "80%",
        }}
      >
        <AppText style={{ color: captureColors.onSurface, fontSize: 14, lineHeight: 21 }}>{children}</AppText>
      </View>
    </View>
  );
}
