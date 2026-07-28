import { useCreateLog, useCreateLogBatch, useDeleteLog } from "@/api/hooks";
import { useToast } from "@/components/Toast";
import { haptics } from "@/motion";
import type { MemoryFood, MemoryMeal } from "@/api/types";

// useInstantLog centralises the one-tap "log from memory + Undo toast" flow so
// the Log screen and the Home "Your usual" strip share one implementation.
// The client never sends macros — only food_item_id + grams + slot + logged_at;
// nutrition is recomputed server-side.
export function useInstantLog(): { logFood: (f: MemoryFood) => void; logMeal: (m: MemoryMeal) => void } {
  const createLog = useCreateLog();
  const batchLog = useCreateLogBatch();
  const deleteLog = useDeleteLog();
  const toast = useToast();

  const logFood = (f: MemoryFood) => {
    createLog.mutate(
      {
        food_item_id: f.food_item_id,
        meal_slot: f.meal_slot,
        source: "memory",
        quantity_grams: f.grams,
        logged_at: new Date().toISOString(),
      },
      {
        onSuccess: (created) => {
          haptics.success();
          toast.show({
            message: `Logged ${f.name}`,
            actionLabel: "Undo",
            onAction: () => deleteLog.mutate(created.id),
          });
        },
      },
    );
  };

  const logMeal = (m: MemoryMeal) => {
    batchLog.mutate(
      {
        logged_at: new Date().toISOString(),
        meal_slot: m.meal_slot,
        items: m.items.map((i) => ({ food_item_id: i.food_item_id, quantity_grams: i.grams })),
      },
      {
        onSuccess: (created) => {
          haptics.success();
          toast.show({
            message: `Logged ${m.name}`,
            actionLabel: "Undo",
            onAction: () => created.forEach((l) => deleteLog.mutate(l.id)),
          });
        },
      },
    );
  };

  return { logFood, logMeal };
}
