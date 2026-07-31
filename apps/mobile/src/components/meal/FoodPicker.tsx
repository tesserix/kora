import { useEffect, useState, type ReactElement } from "react";
import { Pressable, TextInput, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { Card } from "@/components/Card";
import { useFoodSearch } from "@/api/hooks";
import type { FoodItem } from "@/api/types";
import { foodVisual } from "@/lib/foodVisual";
import { useTheme } from "@/theme";

export interface FoodPickerProps {
  visible: boolean;
  initialQuery: string;
  onSelect: (item: FoodItem) => void;
  onClose: () => void;
}

// Lets the user replace a logged food with a different one. Search is the
// same index-only lookup used on the main log screen (no AI cost), so it is
// safe to query on every keystroke once 2+ characters are typed. Results show
// each candidate's kcal_per_100g verbatim — never a portion-scaled number,
// which would be a client-computed nutrition value.
export function FoodPicker({ visible, initialQuery, onSelect, onClose }: FoodPickerProps): ReactElement {
  const { colors, spacing, fontSize } = useTheme();
  const [query, setQuery] = useState(initialQuery);

  // Reset the field to the log's phrase (or current name) every time the
  // picker opens, rather than leaking whatever was typed on a prior visit.
  useEffect(() => {
    if (visible) setQuery(initialQuery);
  }, [visible, initialQuery]);

  const search = useFoodSearch(query);
  const trimmed = query.trim();

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline style={{ marginTop: 8, marginBottom: 8 }}>Change food</Overline>

        <Card variant="elevated" style={{ padding: 0, marginBottom: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md }}>
            <Icon name="search" size={18} color={colors.secondaryLabel} />
            <TextInput
              accessibilityLabel="Search foods"
              style={{ flex: 1, color: colors.label, fontSize: fontSize.base, paddingVertical: 12 }}
              placeholder="Search foods…"
              placeholderTextColor={colors.secondaryLabel}
              autoFocus
              value={query}
              onChangeText={setQuery}
            />
          </View>
        </Card>

        {trimmed.length < 2 ? (
          <AppText variant="footnote" muted>
            Keep typing — 2+ characters to search.
          </AppText>
        ) : search.isError ? (
          <AppText variant="footnote" style={{ color: colors.destructive }}>
            Couldn't search right now. Try again.
          </AppText>
        ) : search.data && search.data.length > 0 ? (
          <View>
            {search.data.map((candidate) => {
              const item = candidate.item;
              const vis = foodVisual(item.name);
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Select ${item.name}`}
                  onPress={() => onSelect(item)}
                  style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 }}
                >
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: colors.cardSecondary,
                    }}
                  >
                    <Icon name={vis.icon} size={18} color={colors.accent} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <AppText variant="headline">{item.name}</AppText>
                    {item.brand ? (
                      <AppText variant="footnote" muted>
                        {item.brand}
                      </AppText>
                    ) : null}
                  </View>
                  <AppText variant="subheadline" muted>{`${Math.round(item.kcal_per_100g)} kcal/100g`}</AppText>
                </Pressable>
              );
            })}
          </View>
        ) : !search.isLoading ? (
          <AppText variant="footnote" muted>
            No match — try another word.
          </AppText>
        ) : null}
      </View>
    </Sheet>
  );
}
