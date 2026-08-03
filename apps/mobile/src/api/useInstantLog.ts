import { useCreateLog, useCreateLogBatch, useDeleteLog } from "@/api/hooks";
import { useToast } from "@/components/Toast";
import { haptics } from "@/motion";
import { discard, isQueued, list, type QueuedLog } from "@/offline/queue";
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

  // Undo has to answer one question: does this log exist on the server yet?
  // A queued log has no server row, so DELETE /v1/logs/<queued id> would hit
  // nothing and — worse — leave the item queued for the next drain to
  // resurrect. A sent log has one, and only DELETE removes it.
  //
  // The answer is MEMBERSHIP AT TAP TIME, not the shape of the value captured
  // when the toast was created. The toast lives for seconds, and a reconnect
  // drain inside that window sends the item and removes it from the queue: the
  // captured value still looks queued, but discarding it would remove nothing
  // and Undo would silently do nothing at all.
  const undoLog = async (created: FoodLog | QueuedLog) => {
    // Cheap narrowing first: a value that never had queue shape came straight
    // back from the server, so there is nothing to look up.
    if (!isQueued(created)) {
      deleteLog.mutate(created.id);
      return;
    }
    const stillQueued = (await list()).some((i) => i.id === created.id);
    if (!stillQueued) {
      deleteLog.mutate(created.id);
      return;
    }
    await discard(created.id);
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
            // Fire-and-forget: a storage failure here leaves the log exactly
            // where it was before the tap, which is the honest fallback.
            onAction: () => { void undoLog(created).catch(() => {}); },
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
