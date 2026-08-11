import { Fragment, type ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";
import { GlassPanel } from "./GlassPanel";

export interface TeleStripCell {
  icon: ReactNode;
  value: string;
  label: string;
}

export interface TeleStripProps {
  cells: TeleStripCell[];
}

export function TeleStrip({ cells }: TeleStripProps) {
  const { instrument, fonts } = useTheme();
  const mono = { fontFamily: fonts.mono, fontVariant: ["tabular-nums" as const] };
  // Sentence case, not engraved: engraving is reserved for inside the gauge
  // instruments themselves (GaugeDial caption/footer, SubDial context) — a
  // metric caption like "Steps"/"Sleep" is not an engraving.
  const captionLabel = {
    fontSize: 11,
    fontWeight: "600" as const,
    color: instrument.mut,
  };

  return (
    <GlassPanel radius={20} testID="tele-strip">
      <View style={{ flexDirection: "row", alignItems: "center", padding: 13, paddingHorizontal: 18 }}>
        {cells.map((c, i) => (
          <Fragment key={c.label}>
            {i > 0 && (
              <View
                style={{ width: 1, height: 30, backgroundColor: instrument.hairline, marginHorizontal: 16 }}
              />
            )}
            <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  backgroundColor: instrument.inset,
                  borderWidth: 1,
                  borderColor: instrument.glassBorder,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {c.icon}
              </View>
              <View>
                <AppText style={[{ fontSize: 17, fontWeight: "600", color: instrument.ink }, mono]}>
                  {c.value}
                </AppText>
                <AppText style={captionLabel}>{c.label}</AppText>
              </View>
            </View>
          </Fragment>
        ))}
      </View>
    </GlassPanel>
  );
}
