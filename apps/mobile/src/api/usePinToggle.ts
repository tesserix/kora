import { useMemo } from "react";
import { usePins, useCreatePin, useDeletePin } from "./hooks";
import type { LoggableFood } from "./types";

// usePinToggle exposes the set of pinned food ids (for star state) and a toggle
// that pins an un-pinned food (with its portion) or unpins a pinned one.
export function usePinToggle(): { pinnedIds: Set<string>; toggle: (f: LoggableFood) => void } {
  const pins = usePins();
  const createPin = useCreatePin();
  const deletePin = useDeletePin();

  const pinnedIds = useMemo(
    () => new Set((pins.data ?? []).map((p) => p.food_item_id)),
    [pins.data],
  );

  const toggle = (f: LoggableFood) => {
    if (pinnedIds.has(f.food_item_id)) {
      deletePin.mutate(f.food_item_id);
    } else {
      createPin.mutate({ food_item_id: f.food_item_id, grams: f.grams, meal_slot: f.meal_slot });
    }
  };

  return { pinnedIds, toggle };
}
