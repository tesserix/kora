import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "./Text";
import { Overline } from "./Overline";

type Props = { overline?: string; title: string; right?: ReactNode };

export function ScreenHeader({ overline, title, right }: Props) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 4, paddingBottom: 14 }}>
      <View style={{ flex: 1 }}>
        {overline ? <Overline style={{ marginBottom: 3 }}>{overline}</Overline> : null}
        <AppText style={{ fontSize: 28, fontWeight: "800", letterSpacing: -0.84 }}>{title}</AppText>
      </View>
      {right}
    </View>
  );
}
