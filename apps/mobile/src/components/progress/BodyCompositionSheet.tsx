import { useState } from "react";
import { View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { useAddWeight } from "@/api/hooks";
import type { WeightSource } from "@/api/types";
import type { AddWeightPayload, CompositionValues } from "@/lib/bodyCompositionForm";
import { BodyCompositionForm } from "./BodyCompositionForm";

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Profile height, for the derived BMI. Absent means no BMI, never a guess. */
  heightCm?: number;
  /** Pre-filled values — see BodyCompositionForm, and kora#314. */
  initialValues?: CompositionValues;
  sources?: readonly WeightSource[];
}

/**
 * The bottom sheet that carries the body-composition form (kora#45).
 *
 * Separate from `WeightLogSheet` by design, not by accident. The daily
 * weigh-in is two taps and stays two taps: most days a user logs weight and
 * nothing else, and putting nine optional fields in front of that is a
 * regression for the common case. A scale reading with a full composition
 * panel is a different, deliberate action, and it gets its own surface.
 *
 * All this adds to the form is the mutation. Everything reusable lives in
 * `BodyCompositionForm`, so #314 can mount the same form over its own
 * confirm-and-write path without inheriting this sheet's assumptions.
 */
export function BodyCompositionSheet({ visible, onClose, heightCm, initialValues, sources }: Props) {
  const [error, setError] = useState<string | null>(null);
  const addWeight = useAddWeight();

  const onSubmit = (payload: AddWeightPayload) => {
    setError(null);
    addWeight.mutate(payload, {
      onSuccess: () => onClose(),
      onError: () => setError("Couldn't save. Try again."),
    });
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        {/* Deliberately NOT seeded with the last known weight, unlike
            WeightLogSheet. There, a seeded figure is a convenience the user
            adjusts by a tenth. Here the form is filled by copying a reading off
            a scale, and a pre-filled weight from another day is a wrong number
            that looks like a right one — easy to leave untouched, and it would
            be stored as today's measurement. */}
        <BodyCompositionForm
          initialValues={initialValues}
          sources={sources}
          heightCm={heightCm}
          submitting={addWeight.isPending}
          error={error}
          onSubmit={onSubmit}
        />
      </View>
    </Sheet>
  );
}
