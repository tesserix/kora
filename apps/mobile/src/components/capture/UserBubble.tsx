import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "@/components/Text";
import { captureColors } from "./captureTheme";

interface Props {
  children: ReactNode;
}

// The user's own message — primary-filled bubble, right-aligned, top-right
// corner squared off (radius 6), per CaptureScreen.jsx.
export function UserBubble({ children }: Props) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
      <View
        style={{
          backgroundColor: captureColors.primary,
          borderRadius: 16,
          borderTopRightRadius: 6,
          paddingHorizontal: 14,
          paddingVertical: 10,
          maxWidth: "80%",
        }}
      >
        <AppText style={{ color: captureColors.primaryForeground, fontSize: 14, lineHeight: 21, fontWeight: "500" }}>
          {children}
        </AppText>
      </View>
    </View>
  );
}
