import { useMemo } from "react";
import { useToast } from "@/components/Toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { usePins, useCreatePin, useDeletePin } from "./hooks";
import type { LoggableFood } from "./types";

// usePinToggle exposes the set of pinned food ids (for star state) and a toggle
// that pins an un-pinned food (with its portion) or unpins a pinned one.
export function usePinToggle(): { pinnedIds: Set<string>; toggle: (f: LoggableFood) => void } {
  const pins = usePins();
  const createPin = useCreatePin();
  const deletePin = useDeletePin();
  const toast = useToast();

  // #83: both mutations previously ran with no error surface, so a failed tap
  // left the star unchanged and said nothing. The pin either sticks or the user
  // is told why it did not.
  const onError = { onError: (error: unknown) => toast.show({ message: apiErrorMessage(error) }) };

  const pinnedIds = useMemo(
    () => new Set((pins.data ?? []).map((p) => p.food_item_id)),
    [pins.data],
  );

  const toggle = (f: LoggableFood) => {
    if (pinnedIds.has(f.food_item_id)) {
      deletePin.mutate(f.food_item_id, onError);
    } else {
      createPin.mutate({ food_item_id: f.food_item_id, grams: f.grams, meal_slot: f.meal_slot }, onError);
    }
  };

  return { pinnedIds, toggle };
}
