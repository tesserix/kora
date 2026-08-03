import { useCreateLog, useCreateLogBatch, useDeleteLog } from "@/api/hooks";
import { useToast } from "@/components/Toast";
import { haptics } from "@/motion";
import { discard, isQueued, list, type QueuedLog } from "@/offline/queue";
import type { FoodLog, LoggableFood, LoggableMeal } from "@/api/types";

// useInstantLog centralises the one-tap "log from memory + Undo toast" flow so
// the Log screen and the Home "Your usual" strip share one implementation.
// The client never sends macros — only food_item_id + grams + slot + logged_at;
// nutrition is recomputed server-side.
// Every failure that is not "we could not attribute this log" resolves to copy
// that does not pretend to know the cause — a raw server string ("request
// failed") is not something to show a user. Mirrors app/log.tsx's onError.
const LOG_FAILED = "Couldn't log that. Please try again.";

// Duck-typed on `name` rather than `instanceof`, the way apiErrorMessage.ts
// already discriminates: NoOwnerError's message IS the user-facing copy.
function logFailureMessage(error: unknown): string {
  return (error as { name?: string } | null)?.name === "NoOwnerError" && error instanceof Error
    ? error.message
    : LOG_FAILED;
}

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
    // mutateAsync, not mutate: `mutate` swallows the rejection inside React
    // Query, so undoLog would resolve however the DELETE went and the caller's
    // catch could never fire — the silent failure this handler exists to end.
    if (!isQueued(created)) {
      await deleteLog.mutateAsync(created.id);
      return;
    }
    const stillQueued = (await list()).some((i) => i.id === created.id);
    if (!stillQueued) {
      await deleteLog.mutateAsync(created.id);
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
            // Undo exists to reverse something; if it cannot, say so rather
            // than leaving the user believing a meal they cancelled is gone.
            // The log stays exactly where it was, which is what this promises.
            onAction: () => {
              void undoLog(created).catch(() => {
                haptics.error();
                toast.show({ message: "Couldn't undo. Try again." });
              });
            },
          });
        },
        // Without this the mutation's rejection lands in state nobody reads:
        // the user taps "Your usual" and the app does nothing at all.
        onError: (error) => {
          haptics.error();
          toast.show({ message: logFailureMessage(error) });
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
