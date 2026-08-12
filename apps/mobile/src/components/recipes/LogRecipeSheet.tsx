import { useState } from "react";
import { Pressable, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { Segmented } from "@/components/Segmented";
import { Icon } from "@/components/Icon";
import { useLogRecipe } from "@/api/hooks";
import { useToast } from "@/components/Toast";
import { useTheme } from "@/theme";

interface Props {
  visible: boolean;
  recipeId: string;
  defaultServings: number;
  onClose: () => void;
}

const MEAL_OPTIONS = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
];

// Reports what actually got logged, never a rounded-up claim of success. A
// recipe with unresolved ingredients logs only the resolved ones — the
// server's `skipped` list names exactly what was left out, and that has to
// reach the user, not just a bare count (a partially-logged recipe must
// never look complete).
function logResultMessage(logged: number, skipped: string[]): string {
  const base = `Logged ${logged} ingredient${logged === 1 ? "" : "s"}.`;
  if (skipped.length === 0) return base;
  return `${base} Skipped: ${skipped.join(", ")}.`;
}

export function LogRecipeSheet({ visible, recipeId, defaultServings, onClose }: Props) {
  const { instrument, spacing } = useTheme();
  const [servings, setServings] = useState(defaultServings);
  const [mealSlot, setMealSlot] = useState<string>("lunch");
  const logRecipe = useLogRecipe();
  const toast = useToast();

  const onSubmit = () => {
    logRecipe.mutate(
      { id: recipeId, body: { servings, meal_slot: mealSlot, logged_at: new Date().toISOString() } },
      {
        onSuccess: (result) => {
          toast.show({ message: logResultMessage(result.logged, result.skipped) });
          onClose();
        },
        onError: () => toast.show({ message: "Couldn't log that recipe. Try again." }),
      },
    );
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30, gap: spacing.md }}>
        <Overline>Log recipe</Overline>

        <View style={{ gap: spacing.xs }}>
          <Overline>Meal</Overline>
          <Segmented options={MEAL_OPTIONS} value={mealSlot} onChange={setMealSlot} />
        </View>

        <View style={{ gap: spacing.xs }}>
          <Overline>Servings</Overline>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Decrease servings"
              hitSlop={8}
              onPress={() => setServings((s) => Math.max(1, s - 1))}
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                backgroundColor: instrument.inset,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="minus" size={16} color={instrument.accent} />
            </Pressable>
            <AppText style={{ fontSize: 17, fontWeight: "600", color: instrument.ink, minWidth: 32, textAlign: "center" }}>
              {servings}
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Increase servings"
              hitSlop={8}
              onPress={() => setServings((s) => s + 1)}
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                backgroundColor: instrument.inset,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="plus" size={16} color={instrument.accent} />
            </Pressable>
          </View>
        </View>

        <Button title={logRecipe.isPending ? "Logging…" : "Log it"} onPress={onSubmit} disabled={logRecipe.isPending} />
      </View>
    </Sheet>
  );
}
