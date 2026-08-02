import { useCreateLog, useCreateLogBatch, useDeleteLog } from "@/api/hooks";
import { useToast } from "@/components/Toast";
import { haptics } from "@/motion";
import { discard, isQueued, type QueuedLog } from "@/offline/queue";
import type { FoodLog, LoggableFood, LoggableMeal } from "@/api/types";

// useInstantLog centralises the one-tap "log from memory + Undo toast" flow so
// the Log screen and the Home "Your usual" strip share one implementation.
// The client never sends macros — only food_item_id + grams + slot + logged_at;
// nutrition is recomputed server-side.
export function useInstantLog(): { logFood: (f: LoggableFood) => void; logMeal: (m: LoggableMeal) => void } {
  const createLog = useCreateLog();
  const batchLog = useCreateLogBatch();
  const deleteLog = useDeleteLog();
  const toast = useToast();

  // A log written while offline is a queue entry, not a server row: DELETE
  // /v1/logs/<queued id> would hit nothing, the item would stay queued, and the
  // next drain would resurrect the very meal the user just undid. Branch on the
  // value's own shape rather than on current connectivity — the device can come
  // back online between the log and the Undo tap.
  const undoLog = (created: FoodLog | QueuedLog) => {
    if (!isQueued(created)) {
      deleteLog.mutate(created.id);
      return;
    }
    // Nothing to report to the user if storage itself fails: the log simply
    // stays queued and drains later, which is the pre-Undo state.
    void discard(created.id).catch(() => {});
  };

  const logFood = (f: LoggableFood) => {
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
            onAction: () => undoLog(created),
          });
        },
      },
    );
  };

  const logMeal = (m: LoggableMeal) => {
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
