import { useEffect, useState } from "react";
import { ActivityIndicator, TextInput, View } from "react-native";
import { router, type Href } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { Overline } from "@/components/Overline";
import { AppText } from "@/components/Text";
import { Segmented } from "@/components/Segmented";
import { GroupedSection } from "@/components/GroupedList";
import { FoodPicker } from "@/components/meal/FoodPicker";
import { PressableScale } from "@/motion";
import { useToast } from "@/components/Toast";
import { useCreateRecipe, useParseRecipe } from "@/api/hooks";
import { ApiError } from "@/lib/api";
import { buildCaptureForm } from "@/api/resolveWire";
import type { FoodItem, Recipe, RecipeDraft, RecipeIngredientInput, SaveRecipeBody } from "@/api/types";
import { ServingsStepper } from "./ServingsStepper";
import { useTheme } from "@/theme";

interface RecipeParseSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Which entry mode the sheet opens on — recipes.tsx's separate Paste/Photo
   *  header buttons both open this same sheet, preselecting the mode the
   *  user actually tapped. Defaults to "paste" for callers (e.g. the Log
   *  screen's "+ New recipe") with no such distinction to make. */
  initialMode?: EntryMode;
}

type EntryMode = "paste" | "photo";
// "entry" is the paste/photo form; "review" is the editable draft — reached
// either from a successful parse OR from a parse_failed fallback (see
// handleParseError), which is why review must never assume a real AI draft
// produced it.
type Stage = "entry" | "review";

const ENTRY_MODE_OPTIONS = [
  { key: "paste", label: "Paste" },
  { key: "photo", label: "Photo" },
];

type PhotoFile = { uri: string; name: string; type: string };
type PhotoPickOutcome =
  | { status: "success"; file: PhotoFile }
  | { status: "canceled" }
  | { status: "denied" }
  | { status: "failed" };

// Mirrors app/capture.tsx's pickMealPhoto verbatim (camera first, photo
// library as fallback, only a genuine denial of BOTH reported as "denied").
// Not imported from there — capture.tsx doesn't export it and capture.tsx is
// itself exempt from theming/light-dark, so pulling a shared helper out from
// under it is a separate change. Same expo-image-picker calls, same
// fallback order, same three-outcome shape.
async function pickRecipePhoto(): Promise<PhotoPickOutcome> {
  try {
    const cameraPermission = await ImagePicker.requestCameraPermissionsAsync();
    let result: ImagePicker.ImagePickerResult | undefined;

    if (cameraPermission.granted) {
      try {
        result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.7 });
      } catch {
        result = undefined; // no camera hardware available — fall back to the library below
      }
    }

    if (!result) {
      const libraryPermission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!libraryPermission.granted) {
        return { status: "denied" };
      }
      result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.7 });
    }

    if (result.canceled) {
      return { status: "canceled" };
    }
    const asset = result.assets[0];
    if (!asset) {
      return { status: "canceled" };
    }
    return {
      status: "success",
      file: { uri: asset.uri, name: asset.fileName ?? "recipe.jpg", type: asset.mimeType ?? "image/jpeg" },
    };
  } catch {
    return { status: "failed" };
  }
}

// The spec's explicit rule for a 502 parse_failed: never a dead end. A single
// unresolved ingredient carrying the user's own pasted text (or, for a photo
// that couldn't be read, a plain placeholder — there is no text to carry) so
// the review stage below has something to edit rather than nothing at all.
function fallbackIngredient(mode: EntryMode, pastedText: string): RecipeIngredientInput {
  return {
    food_item_id: null,
    raw_text: mode === "paste" && pastedText.trim() ? pastedText.trim() : "Couldn't read this recipe",
    grams: 0,
    entered_amount: null,
    entered_unit: null,
    portion_assumed: false,
    match_score: null,
    match_tier: null,
  };
}

function parseErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return `Couldn't read that — ${error.message}`;
  return "Couldn't reach Kora to read that recipe. Please try again.";
}

interface ParsedIngredientRowProps {
  ingredient: RecipeIngredientInput;
  onFindMatch: () => void;
  onRemove: () => void;
}

// Same visual language as app/recipe/[id].tsx's IngredientRow (and, one level
// further back, capture/DetectedCard's confidence/assumed-portion treatment)
// — italic/mut raw text plus an uppercase engraved tag for an unresolved row,
// the same engraved "portion is a guess" tag for portion_assumed (#138). Kept
// as its own component (RecipeIngredientInput's `resolved` state is derived
// from food_item_id here, rather than a boolean the server-computed
// RecipeIngredient carries) rather than importing IngredientRow, which is a
// private, unexported function in a route file.
//
// A resolved row shows BOTH sides of the match: `ingredient.name` (the
// matched food's own canonical name, server-populated — see
// IngredientInput.Name on the Go side) as the primary label, and raw_text
// (what was actually searched for) as a secondary line — that's what makes
// the confirmation meaningful; showing only one side would hide either what
// the AI read or what it matched it to.
function ParsedIngredientRow({ ingredient, onFindMatch, onRemove }: ParsedIngredientRowProps) {
  const { instrument, spacing } = useTheme();
  const resolved = ingredient.food_item_id !== null;
  const label = resolved ? (ingredient.name || ingredient.raw_text) : ingredient.raw_text;
  return (
    <View style={{ paddingHorizontal: spacing.md, paddingVertical: 10, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <AppText
          style={{
            flex: 1,
            fontSize: 15,
            fontWeight: "500",
            color: resolved ? instrument.ink : instrument.mut,
            fontStyle: resolved ? "normal" : "italic",
          }}
        >
          {label}
        </AppText>
        <AppText style={{ fontSize: 13, color: instrument.mut, fontVariant: ["tabular-nums"] }}>
          {Math.round(ingredient.grams)} g
        </AppText>
      </View>
      {resolved && ingredient.name && ingredient.name !== ingredient.raw_text ? (
        <AppText style={{ color: instrument.mut, fontSize: 12 }}>Matched from "{ingredient.raw_text}"</AppText>
      ) : null}
      {!resolved ? (
        <AppText
          style={{ color: instrument.mut, fontSize: 9, fontWeight: "700", textTransform: "uppercase", letterSpacing: 1 }}
        >
          needs a match
        </AppText>
      ) : null}
      {ingredient.portion_assumed ? (
        <AppText
          style={{ color: instrument.mut, fontSize: 9, fontWeight: "700", textTransform: "uppercase", letterSpacing: 1 }}
        >
          portion is a guess
        </AppText>
      ) : null}
      <View style={{ flexDirection: "row", gap: spacing.md, marginTop: 2 }}>
        {!resolved ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Find a match for ${ingredient.raw_text}`}
            haptic="selection"
            onPress={onFindMatch}
          >
            <AppText style={{ fontSize: 13, fontWeight: "600", color: instrument.accent }}>Find a match</AppText>
          </PressableScale>
        ) : null}
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`Remove ${label}`}
          haptic="none"
          onPress={onRemove}
        >
          <AppText style={{ fontSize: 13, fontWeight: "600", color: instrument.danger }}>Remove</AppText>
        </PressableScale>
      </View>
    </View>
  );
}

// The AI parse-review sheet: paste text or a photo goes to POST
// /v1/recipes/parse (useParseRecipe), the model's UNSAVED draft is reviewed
// and edited here, and "Save recipe" posts the edited draft to POST
// /v1/recipes (useCreateRecipe). Reached from recipes.tsx's Paste/Photo
// header actions and from the Log screen's "+ New recipe" — this is the one
// sheet both call, so a review edit made from either entry point behaves
// identically.
export function RecipeParseSheet({ visible, onClose, initialMode }: RecipeParseSheetProps) {
  const { instrument, spacing } = useTheme();
  const toast = useToast();
  const parseRecipe = useParseRecipe();
  const createRecipe = useCreateRecipe();

  const [mode, setMode] = useState<EntryMode>(initialMode ?? "paste");
  const [pasteText, setPasteText] = useState("");
  const [stage, setStage] = useState<Stage>("entry");
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftServings, setDraftServings] = useState(1);
  const [draftSource, setDraftSource] = useState<"paste" | "photo">("paste");
  const [draftIngredients, setDraftIngredients] = useState<RecipeIngredientInput[]>([]);
  const [matchTargetIndex, setMatchTargetIndex] = useState<number | null>(null);

  // Reseed everything on every open — this sheet stays mounted (only Sheet's
  // own `visible` gate hides it) between opens, so a stale draft or pasted
  // phrase from a previous visit must never leak into the next one.
  useEffect(() => {
    if (!visible) return;
    setMode(initialMode ?? "paste");
    setPasteText("");
    setStage("entry");
    setFallbackNotice(null);
    setDraftName("");
    setDraftServings(1);
    setDraftIngredients([]);
    setMatchTargetIndex(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function applyDraft(draft: RecipeDraft) {
    setDraftName(draft.name);
    setDraftServings(draft.servings);
    setDraftSource(draft.source);
    setDraftIngredients(draft.ingredients);
    setFallbackNotice(null);
    setStage("review");
  }

  // The spec's explicit rule: a 502 parse_failed is never a dead end. Drops
  // straight into the SAME review stage a successful parse reaches, seeded
  // with one unresolved ingredient carrying whatever the user gave us, so
  // they can still name it, match or drop that line, and save a real recipe.
  //
  // Keyed off `error.status === 502`, NOT `error.code === "parse_failed"`.
  // A live on-device run showed this endpoint's real 502 does not reliably
  // survive as a distinguishable `code`: throwApiError (src/lib/api.ts)
  // builds `code` by parsing the response body as JSON and reading its
  // `error` field, falling back to the literal string "unknown" the moment
  // that parse fails for any reason (a proxy/gateway hop rewriting or
  // truncating the body, a body that never fully arrives, ...). `status`
  // survives all of that because it's read straight off the HTTP response
  // line before any body parsing happens. /v1/recipes/parse only ever
  // returns 502 for this one reason (see api/internal/recipes/handler.go),
  // so the status alone is an unambiguous, more robust signal than the code.
  function handleParseError(error: unknown, pastedText: string) {
    if (error instanceof ApiError && error.status === 502) {
      setDraftName("");
      setDraftServings(1);
      setDraftSource(mode);
      setDraftIngredients([fallbackIngredient(mode, pastedText)]);
      setFallbackNotice("Otto couldn't read that automatically. Name the recipe and find a match for the ingredient below.");
      setStage("review");
      return;
    }
    toast.show({ message: parseErrorMessage(error) });
  }

  function submitPaste() {
    const trimmed = pasteText.trim();
    if (!trimmed) return;
    parseRecipe.mutate(
      { text: trimmed },
      { onSuccess: applyDraft, onError: (error) => handleParseError(error, trimmed) },
    );
  }

  async function submitPhoto() {
    const outcome = await pickRecipePhoto();
    if (outcome.status === "canceled") return;
    if (outcome.status === "denied") {
      toast.show({ message: "I need camera or photo access to read a recipe photo. Turn it on in Settings." });
      return;
    }
    if (outcome.status === "failed") {
      toast.show({ message: "Something went wrong opening your photos — try again." });
      return;
    }
    const form = buildCaptureForm(outcome.file);
    parseRecipe.mutate(
      { photo: form },
      { onSuccess: applyDraft, onError: (error) => handleParseError(error, "") },
    );
  }

  function submitParse() {
    if (mode === "paste") {
      submitPaste();
      return;
    }
    void submitPhoto();
  }

  function resolveIngredientAt(index: number, item: FoodItem) {
    setDraftIngredients((prev) =>
      prev.map((ing, i) =>
        i === index ? { ...ing, food_item_id: item.id, name: item.name, match_score: 1, match_tier: "manual" } : ing,
      ),
    );
    setMatchTargetIndex(null);
  }

  function removeIngredientAt(index: number) {
    setDraftIngredients((prev) => prev.filter((_, i) => i !== index));
  }

  function saveDraft() {
    if (draftIngredients.length === 0) return;
    const body: SaveRecipeBody = {
      name: draftName.trim() || "Untitled recipe",
      servings: draftServings,
      source: draftSource,
      ingredients: draftIngredients,
    };
    createRecipe.mutate(body, {
      onSuccess: (created: Recipe) => {
        onClose();
        router.push(`/recipe/${created.id}` as Href);
      },
      onError: () => toast.show({ message: "Couldn't save that recipe. Try again." }),
    });
  }

  return (
    <>
      <Sheet visible={visible} onClose={onClose}>
        <View style={{ paddingHorizontal: 22, paddingBottom: 30, gap: spacing.md }}>
          {stage === "entry" ? (
            <>
              <Overline>New recipe</Overline>
              <Segmented options={ENTRY_MODE_OPTIONS} value={mode} onChange={(key) => setMode(key as EntryMode)} />
              {mode === "paste" ? (
                <TextInput
                  accessibilityLabel="Paste recipe text"
                  value={pasteText}
                  onChangeText={setPasteText}
                  placeholder="Paste a recipe — ingredients and all…"
                  placeholderTextColor={instrument.mut}
                  multiline
                  style={{
                    minHeight: 140,
                    textAlignVertical: "top",
                    fontSize: 15,
                    color: instrument.ink,
                    backgroundColor: instrument.inset,
                    borderRadius: 12,
                    padding: 14,
                  }}
                />
              ) : (
                <AppText muted>Take or choose a photo of the recipe.</AppText>
              )}
              {parseRecipe.isPending ? (
                // A parse is a model round trip and can take seconds — this is
                // the sheet's own progress state, distinct from the idle
                // "Parse recipe" button it replaces while pending.
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 14 }}>
                  <ActivityIndicator color={instrument.mut} />
                  <AppText muted>Otto is reading that…</AppText>
                </View>
              ) : (
                <Button
                  title={mode === "paste" ? "Parse recipe" : "Choose photo"}
                  onPress={submitParse}
                  disabled={mode === "paste" && !pasteText.trim()}
                />
              )}
            </>
          ) : (
            <>
              <Overline>Review recipe</Overline>
              {fallbackNotice ? (
                <AppText style={{ color: instrument.mut, fontSize: 13 }}>{fallbackNotice}</AppText>
              ) : null}
              <TextInput
                value={draftName}
                onChangeText={setDraftName}
                autoCapitalize="sentences"
                placeholder="Recipe name"
                placeholderTextColor={instrument.mut}
                accessibilityLabel="Recipe name"
                style={{
                  fontSize: 16,
                  color: instrument.ink,
                  backgroundColor: instrument.inset,
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                }}
              />
              <View style={{ gap: spacing.xs }}>
                <Overline>Servings</Overline>
                <ServingsStepper value={draftServings} onChange={setDraftServings} />
              </View>
              <View style={{ gap: spacing.xs }}>
                <Overline>Ingredients</Overline>
                {draftIngredients.length === 0 ? (
                  <AppText muted>No ingredients left — add at least one to save.</AppText>
                ) : (
                  <GroupedSection>
                    {draftIngredients.map((ing, index) => (
                      <ParsedIngredientRow
                        key={`${ing.raw_text}-${ing.food_item_id ?? "unresolved"}-${index}`}
                        ingredient={ing}
                        onFindMatch={() => setMatchTargetIndex(index)}
                        onRemove={() => removeIngredientAt(index)}
                      />
                    ))}
                  </GroupedSection>
                )}
              </View>
              <Button
                title={createRecipe.isPending ? "Saving…" : "Save recipe"}
                onPress={saveDraft}
                disabled={createRecipe.isPending || draftIngredients.length === 0}
              />
            </>
          )}
        </View>
      </Sheet>
      <FoodPicker
        visible={matchTargetIndex !== null}
        initialQuery={matchTargetIndex !== null ? (draftIngredients[matchTargetIndex]?.raw_text ?? "") : ""}
        title="Find a match"
        onSelect={(item) => {
          if (matchTargetIndex !== null) resolveIngredientAt(matchTargetIndex, item);
        }}
        onClose={() => setMatchTargetIndex(null)}
      />
    </>
  );
}
