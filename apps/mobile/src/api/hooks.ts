import { useEffect } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { apiFetch, apiFetchEnvelope, apiFetchMultipart, isNetworkError } from "@/lib/api";
import { buildCaptureForm, normalizeResolution, type ResolveFile } from "./resolveWire";
import { isOnline } from "@/offline/connectivity";
import {
  foodsFromMemory,
  foodsFromPins,
  foodsFromSavedMeals,
  getFoodByBarcode,
  searchCachedFoods,
  upsertFoods,
  type FoodFidelity,
} from "@/offline/foodCache";
import {
  OfflineUnknownBarcodeError,
  candidatesFromCachedFoods,
  resolutionFromCachedFood,
} from "@/offline/cachedResolution";
import { append, discard, isQueued, type QueuedLog } from "@/offline/queue";
import { QUEUED_LOGS_KEY } from "@/offline/queryKeys";
import { NoOwnerError, resolveOwnerId } from "@/offline/owner";
import type { MealSlot } from "@/lib/mealSlot";
import type {
  AppNotification,
  Candidate,
  ChallengeDetail,
  ChallengeSummary,
  DashboardSummary,
  FeedbackCreated,
  FoodItem,
  Friend,
  FriendRequests,
  FriendsProgress,
  FoodLog,
  GroupCode,
  GroupDetail,
  GroupProgress,
  GroupSummary,
  Memory,
  Metric,
  MyFriendCode,
  OnboardingInput,
  PinnedFood,
  Profile,
  Resolution,
  SavedMeal,
  SubmitFeedbackInput,
  WeightEntry,
} from "./types";

// upsertFoods is a best-effort cache fill: a failure (e.g. AsyncStorage
// quota) must never surface to the user, and — this codebase has no logging
// library to route it through — must never become a silent, unhandled
// promise rejection either. Logged and dropped.
function cacheFoodsQuietly(items: FoodItem[], fidelity?: FoodFidelity): void {
  void upsertFoods(items, fidelity).catch((err) => console.warn("foodCache: upsertFoods failed", err));
}

export function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    queryFn: () => apiFetch("/v1/me") as Promise<Profile>,
  });
}

export function useSubmitOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OnboardingInput) =>
      apiFetch("/v1/onboarding", { method: "POST", body: JSON.stringify(input) }) as Promise<Profile>,
    // Seed rather than invalidate. Invalidating marks ["profile"] stale but keeps
    // serving the cached pre-onboarding profile, so the router.replace("/") that
    // follows lets (tabs)/_layout read onboarded_at === null and bounce the user
    // straight back to onboarding — where nothing sends them home again once the
    // refetch lands. /v1/onboarding returns the same full user row as /v1/me, so
    // the response is safe to use as the profile outright.
    onSuccess: (profile) => qc.setQueryData(["profile"], profile),
  });
}

// The offline decision, in one place for both lookups below: try the network
// only when there is one, and treat a request that dies mid-flight the same as
// having been offline all along. isOnline() is only a snapshot taken before the
// request leaves, and the commonest mobile failure is the connection dropping
// after that — so the pre-flight check and the isNetworkError catch are two
// different rules and BOTH are needed. Exactly the pair useCreateLog applies to
// the write path.
//
// Anything that is not a network failure (a 4xx, a bad token, an unparseable
// body) rethrows: masking a real server rejection behind a stale local answer
// would be worse than failing.
async function withCacheFallback<T>(live: () => Promise<T>, cached: () => Promise<T>): Promise<T> {
  if (!isOnline()) return cached();
  try {
    return await live();
  } catch (err) {
    if (isNetworkError(err)) return cached();
    throw err;
  }
}

type FoodSearchResult = { candidates: Candidate[]; fromCache: boolean };

// Index-only search — alias, then full-text, then embedding. No AI cost, so
// it is safe to call as the user types. Disabled under 2 characters because
// the server rejects shorter queries with a 400.
//
// Offline it falls back to a name-substring scan of the food cache, so a food
// the device has seen before is still findable and loggable. The fallback lives
// in the hook rather than at the call sites because there are two of them
// (app/log.tsx and src/components/meal/FoodPicker.tsx) and the offline-vs-online
// decision must not be duplicated into either.
export function useFoodSearch(query: string) {
  const q = query.trim();
  const result = useQuery({
    queryKey: ["foods", q],
    // Without this react-query PAUSES the query while offline and the queryFn
    // never runs at all — the cache fallback below would be unreachable in
    // precisely the state it exists for. The app-wide default in
    // src/lib/queryClient covers mutations only; pausing reads offline is
    // deliberate everywhere except the reads that have a local answer.
    networkMode: "always",
    queryFn: (): Promise<FoodSearchResult> =>
      withCacheFallback<FoodSearchResult>(
        async () => ({
          candidates: (await apiFetch(`/v1/foods?q=${encodeURIComponent(q)}`)) as Candidate[],
          fromCache: false,
        }),
        async () => ({ candidates: candidatesFromCachedFoods(await searchCachedFoods(q)), fromCache: true }),
      ),
    enabled: q.length >= 2,
  });

  // `data` keeps the Candidate[] shape both call sites already render, so
  // neither changes for the happy path. `isOfflineCache` is reported separately
  // because an EMPTY cached result is indistinguishable from an empty server
  // result by inspection — and those two need to say very different things to
  // the user ("nothing matches" vs "you're offline, so only foods you've logged
  // before are searchable").
  return {
    ...result,
    data: result.data?.candidates,
    isOfflineCache: result.data?.fromCache ?? false,
  };
}

export type CreateLogInput = {
  food_item_id: string;
  meal_slot: string;
  source: string;
  quantity_grams: number;
  logged_at: string;
  client_log_ms?: number;
  /** Raw user phrase; the server keeps it only for ai_text / ai_voice sources. */
  input_phrase?: string;
};

export function useCreateLog() {
  const qc = useQueryClient();
  return useMutation({
    // react-query's default networkMode ("online") PAUSES a mutation whenever
    // onlineManager reports offline — the mutationFn, and with it the whole
    // enqueue path, would never run in exactly the case the queue exists for.
    //
    // src/lib/queryClient now sets this app-wide, so on the real client this
    // line is redundant. It is kept deliberately, and it is NOT dead: for
    // every other mutation "always" only restores fail-fast ergonomics, but
    // here the mutationFn IS the enqueue path, so pausing loses the meal. The
    // invariant belongs next to the code that depends on it rather than in a
    // shared default a later change could quietly narrow. Removing it fails
    // 23 existing tests, which build their own QueryClient without the app's
    // defaults — the shortest proof that this is load-bearing.
    networkMode: "always",
    mutationFn: async (input: CreateLogInput): Promise<FoodLog | QueuedLog> => {
      // The id is minted client-side for EVERY log, online or not, so the
      // server row and any queued copy share one identity and a replay is
      // idempotent (see api/internal/foodlog CreateIdempotent).
      const id = Crypto.randomUUID();
      // Stamped so a queued log is only ever replayed into the diary of the
      // user who wrote it — the queue is one device-wide list, accounts are not.
      // resolveOwnerId falls back to the last remembered uid while Firebase is
      // still restoring the session, because a write with no owner can never be
      // drained. With no owner at all there is nothing honest to do but refuse:
      // queueing would swallow the meal into a black hole.
      const ownerId = await resolveOwnerId();
      if (!ownerId) throw new NoOwnerError();
      if (!isOnline()) return append(input, id, ownerId);
      try {
        return (await apiFetch("/v1/logs", {
          method: "POST",
          body: JSON.stringify({ ...input, id }),
        })) as FoodLog;
      } catch (err) {
        // isOnline() was only a snapshot taken before the request left. The
        // commonest mobile failure is the connection dying mid-flight, and
        // without this the log would simply vanish — logFood has no onError.
        // Queueing is safe even if the server did apply the write: the id
        // already travelled, so the replay resolves to that same row.
        // Everything else (a 4xx, a bad token, an unparseable body) is a real
        // failure the caller must see.
        if (isNetworkError(err)) return append(input, id, ownerId);
        throw err;
      }
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      // A write that was QUEUED rather than sent produces no server row, so
      // the two invalidations above have nothing to fetch — and offline they
      // cannot fetch anyway, since queries default to networkMode "online" and
      // are paused rather than refetched. The diary's queued rows are the only
      // thing that will show this meal, and every log entry point is presented
      // OVER a mounted Diary (capture is a fullScreenModal, meal a
      // transparentModal), so its observer survives with an unchanged key and
      // nothing refetches unless it is invalidated here.
      //
      // Gated for the same reason drainLogs leaves ["logs"] alone when it sent
      // nothing: a genuine server row cannot have changed the queue. isQueued
      // is safe in this direction — false means definitively a server row.
      if (isQueued(result)) qc.invalidateQueries({ queryKey: [QUEUED_LOGS_KEY] });
    },
  });
}

type BatchLogInput = {
  logged_at: string;
  meal_slot: string;
  items: { food_item_id: string; quantity_grams: number }[];
};

export function useCreateLogBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BatchLogInput) =>
      apiFetch("/v1/logs/batch", { method: "POST", body: JSON.stringify(input) }) as Promise<FoodLog[]>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useMemory(date: string) {
  const query = useQuery({
    queryKey: ["memory", date],
    queryFn: () => apiFetch("/v1/memory") as Promise<Memory>,
  });
  // Same by-product cache fill as usePins/useSavedMeals below, same "summary"
  // fidelity, same reason for an effect. This is the one that matters most
  // offline: memory backs Home's "Your usual" strip and the Log screen's
  // default Recents tab — the two primary one-tap surfaces. Without it the
  // commonest offline log has no cached food, so the diary renders it as an
  // unnamed "Queued item" with a null kcal and the day total counts nothing.
  useEffect(() => {
    if (query.data) cacheFoodsQuietly(foodsFromMemory(query.data), "summary");
  }, [query.data]);
  return query;
}

export function usePins() {
  const query = useQuery({
    queryKey: ["pins"],
    queryFn: () => apiFetch("/v1/pins") as Promise<PinnedFood[]>,
  });
  // Fills the offline cache as a by-product of a query the app already runs.
  // In an effect rather than `select` (which must stay pure and re-runs on
  // every access) or `onSuccess` (removed from useQuery in v5). "summary"
  // fidelity: a pin is a gram-scaled serving, never a full FoodItem (see
  // foodsFromPins) — it must never clobber a higher-fidelity record already
  // cached for the same food (e.g. from a real barcode scan, see
  // useResolveBarcode below).
  useEffect(() => {
    if (query.data) cacheFoodsQuietly(foodsFromPins(query.data), "summary");
  }, [query.data]);
  return query;
}

export function useCreatePin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { food_item_id: string; grams: number; meal_slot: string }) =>
      apiFetch("/v1/pins", { method: "POST", body: JSON.stringify(input) }) as Promise<PinnedFood>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pins"] }),
  });
}

export function useDeletePin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (foodItemId: string) => apiFetch(`/v1/pins/${foodItemId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pins"] }),
  });
}

type SaveMealBody = { name: string; meal_slot: string; items: { food_item_id: string; grams: number }[] };

export function useSavedMeals() {
  const query = useQuery({
    queryKey: ["savedMeals"],
    queryFn: () => apiFetch("/v1/saved-meals") as Promise<SavedMeal[]>,
  });
  // See usePins above: same by-product cache fill, same "summary" fidelity,
  // same reason for an effect.
  useEffect(() => {
    if (query.data) cacheFoodsQuietly(foodsFromSavedMeals(query.data), "summary");
  }, [query.data]);
  return query;
}

export function useCreateSavedMeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveMealBody) =>
      apiFetch("/v1/saved-meals", { method: "POST", body: JSON.stringify(body) }) as Promise<SavedMeal>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["savedMeals"] }),
  });
}

export function useUpdateSavedMeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: SaveMealBody }) =>
      apiFetch(`/v1/saved-meals/${id}`, { method: "PUT", body: JSON.stringify(body) }) as Promise<SavedMeal>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["savedMeals"] }),
  });
}

export function useDeleteSavedMeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/v1/saved-meals/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["savedMeals"] }),
  });
}

export function useDayLogs(date: string) {
  return useQuery({
    queryKey: ["logs", date],
    queryFn: () => apiFetch(`/v1/logs?date=${date}`) as Promise<FoodLog[]>,
  });
}

export function useDashboard(date: string) {
  return useQuery({
    queryKey: ["dashboard", date],
    queryFn: () => apiFetch(`/v1/dashboard?date=${date}`) as Promise<DashboardSummary>,
  });
}

// Client-only 7-day average intake. Reuses the existing /v1/dashboard endpoint
// per day (same query key as useDashboard, so React Query caches/shares each
// date) and averages only the days that actually have logged data — never
// fabricates a value; returns avg: null when there's no data at all.
//
// A day with `consumed.kcal === 0` is treated as unlogged, not "zero calories
// eaten" — including it would drag the average down and an all-zero week
// would otherwise render a fabricated-looking "0" instead of an honest "—".
export function useAvgIntake7d(endDate: string): { avg: number | null; series: number[]; isLoading: boolean } {
  const dates: string[] = [];
  const end = new Date(`${endDate}T00:00:00`);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 24 * 60 * 60 * 1000);
    dates.push(d.toLocaleDateString("en-CA"));
  }

  const results = useQueries({
    queries: dates.map((date) => ({
      queryKey: ["dashboard", date],
      queryFn: () => apiFetch(`/v1/dashboard?date=${date}`) as Promise<DashboardSummary>,
    })),
  });

  const isLoading = results.some((r) => r.isLoading);
  const series = results
    .filter((r) => r.isSuccess && typeof r.data?.consumed?.kcal === "number" && r.data.consumed.kcal > 0)
    .map((r) => r.data!.consumed.kcal);
  const avg = series.length > 0 ? Math.round(series.reduce((sum, kcal) => sum + kcal, 0) / series.length) : null;

  return { avg, series, isLoading };
}

export function useAddWater() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ volume_ml, logged_at }: { volume_ml: number; logged_at?: string }) =>
      apiFetch("/v1/water", { method: "POST", body: JSON.stringify({ volume_ml, logged_at }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard"] }),
  });
}

export type EditLogInput = {
  id: string;
  meal_slot?: MealSlot;
  quantity_grams?: number;
  food_item_id?: string;
  /**
   * Undo only. Retracts the alias a previous correction on this log taught.
   * Never send this alongside a forward correction to a different food — the
   * server would delete the old alias and teach nothing.
   */
  retract_correction?: boolean;
};

export type EditLogResult = { log: FoodLog; aliasRecorded: boolean };

export function useEditLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: EditLogInput): Promise<EditLogResult> => {
      const envelope = await apiFetchEnvelope<FoodLog>(`/v1/logs/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return { log: envelope.data, aliasRecorded: envelope.meta?.alias_recorded === true };
    },
    onSuccess: (_result, { id }) => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["log", id] });
      // A correction changes what the food index returns for this user, so
      // memory and any cached resolve result are stale too.
      qc.invalidateQueries({ queryKey: ["memory"] });
      // A food correction teaches the server a new phrase -> food mapping for
      // this user, so a cached food-search result (e.g. the picker's list)
      // can serve pre-correction ordering within the same session unless it's
      // invalidated too.
      qc.invalidateQueries({ queryKey: ["foods"] });
    },
  });
}

export function useLog(id: string) {
  return useQuery({
    queryKey: ["log", id],
    // id is typed as string at call sites (e.g. Expo Router's
    // useLocalSearchParams), but at runtime it can be undefined — guard with
    // !! first so an undefined route param disables the query instead of
    // throwing on `.length`.
    queryFn: () => apiFetch(`/v1/logs/${id}`) as Promise<FoodLog>,
    enabled: !!id && id.length > 0,
  });
}

export function useDeleteLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/v1/logs/${id}`, { method: "DELETE" }),
    // The client mints ONE id for both the queue item and the server row, so a
    // row can exist WHILE its queue item is still pending — a POST that died
    // after the server applied it, or a drain whose response was lost. The
    // diary hides the queued copy while the row is present (see diary.tsx), so
    // the user only ever sees, and deletes, the row. Leave the queue item and
    // the next drain replays that id into a now-empty primary key: the meal the
    // user deleted comes back.
    //
    // onSuccess, NOT onSettled: a DELETE that failed leaves the server row in
    // place, so the queue item is still an accurate duplicate of something real
    // and dropping it would discard state the user has not actually undone.
    // Nor inside mutationFn: a storage failure there would surface as
    // "couldn't delete" for a row the server genuinely did delete.
    onSuccess: async (_data, id) => {
      // Best-effort for the same reason cacheFoodsQuietly is: reporting the
      // delete as failed because a local write failed would be a lie about
      // what the server did, and would send the user round a retry loop whose
      // DELETE now 404s.
      await discard(id).catch((err) => console.warn("queue: discard after delete failed", err));
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      // The diary reads queued rows straight off the queue, so without this the
      // deleted row stays on screen — and counted — until something else
      // invalidates.
      qc.invalidateQueries({ queryKey: [QUEUED_LOGS_KEY] });
    },
  });
}

export function useCopyDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      apiFetch("/v1/logs/copy-day", { method: "POST", body: JSON.stringify(input) }) as Promise<{ copied: number }>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useRepeatLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/v1/logs/${id}/repeat`, { method: "POST" }) as Promise<FoodLog>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useResolveText() {
  return useMutation({
    mutationFn: (phrase: string) =>
      apiFetch("/v1/resolve/text", { method: "POST", body: JSON.stringify({ phrase }) }).then(normalizeResolution),
  });
}

// A barcode the device has resolved once already is answerable with no
// network — that is the whole reason getFoodByBarcode and the "full" fidelity
// tier exist. The adapter marks the result as cache-sourced so it can never be
// mistaken for a fresh resolve; see src/offline/cachedResolution.ts.
async function barcodeFromCache(barcode: string): Promise<Resolution> {
  const cached = await getFoodByBarcode(barcode);
  // A distinct error, not an empty Resolution: "I couldn't identify that — try
  // again" is advice that cannot work until the network returns, whereas this
  // is a fact we positively established. capture.tsx turns it into copy that
  // says so.
  if (!cached) throw new OfflineUnknownBarcodeError();
  return resolutionFromCachedFood(cached);
}

export function useResolveBarcode() {
  return useMutation({
    // Same reason useCreateLog carries this locally: the mutationFn IS the
    // offline path, so a paused mutation does not merely delay the feature, it
    // removes it. Kept next to the code that depends on it rather than relying
    // on the app-wide default a later change could narrow.
    networkMode: "always",
    mutationFn: (barcode: string): Promise<Resolution> =>
      withCacheFallback(
        async () =>
          normalizeResolution(
            await apiFetch("/v1/resolve/barcode", { method: "POST", body: JSON.stringify({ barcode }) }),
          ),
        () => barcodeFromCache(barcode),
      ),
    // The one path that hands back genuine server FoodItems — brand,
    // provenance, canonical serving, and (the whole point) a barcode.
    // Caching them at "full" fidelity (the default) is what makes a repeat
    // scan of the same item work offline via getFoodByBarcode: usePins and
    // useSavedMeals only ever produce "summary" records, which can never
    // reach getFoodByBarcode's writer path.
    //
    // Barcode resolves zero or exactly one candidate (never a ranked list —
    // api/internal/resolve/handler.go:212-231), so caching everything here is
    // safe. Do NOT copy this into useResolveText/useResolvePhoto below: those
    // return ranked, multi-candidate lists, and caching every candidate would
    // pollute the offline cache with low-tier guesses under ids the user
    // never actually chose.
    onSuccess: (resolution) => {
      const items = resolution.candidates
        .map((c) => c.item)
        .filter((item): item is FoodItem => !!item && typeof item.id === "string" && item.id.length > 0);
      cacheFoodsQuietly(items);
    },
  });
}

export function useResolvePhoto() {
  return useMutation({
    mutationFn: (file: ResolveFile) =>
      apiFetchMultipart("/v1/resolve/photo", buildCaptureForm(file)).then(normalizeResolution),
  });
}

export function useAddWeight() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ weight_kg, logged_at }: { weight_kg: number; logged_at?: string }) =>
      apiFetch("/v1/weight", { method: "POST", body: JSON.stringify({ weight_kg, logged_at }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["weight"] }),
  });
}

const WEIGHT_RANGE_DAYS = { "1W": 7, "1M": 30, "3M": 90, "1Y": 365 } as const;
export type WeightRange = keyof typeof WEIGHT_RANGE_DAYS;

export function useWeightSeries(range: WeightRange) {
  return useQuery({
    queryKey: ["weight", range],
    queryFn: () => {
      const to = new Date();
      const from = new Date(to.getTime() - WEIGHT_RANGE_DAYS[range] * 24 * 60 * 60 * 1000);
      return apiFetch(`/v1/weight?from=${from.toISOString()}&to=${to.toISOString()}`) as Promise<WeightEntry[]>;
    },
  });
}

export function useResolveVoice() {
  return useMutation({
    mutationFn: (file: ResolveFile) =>
      apiFetchMultipart("/v1/resolve/voice", buildCaptureForm(file)).then(normalizeResolution),
  });
}

export function useFriends() {
  return useQuery({
    queryKey: ["friends"],
    queryFn: () => apiFetch("/v1/friends") as Promise<Friend[]>,
  });
}

export function useFriendRequests() {
  return useQuery({
    queryKey: ["friend-requests"],
    queryFn: () => apiFetch("/v1/friends/requests") as Promise<FriendRequests>,
  });
}

export function useSendFriendRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email?: string; code?: string }) =>
      apiFetch("/v1/friends/requests", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["friend-requests"] });
      qc.invalidateQueries({ queryKey: ["friends"] });
    },
  });
}

export function useAcceptRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/v1/friends/requests/${id}/accept`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["friend-requests"] });
      qc.invalidateQueries({ queryKey: ["friends"] });
    },
  });
}

export function useDeclineRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/v1/friends/requests/${id}/decline`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["friend-requests"] }),
  });
}

export function useUnfriend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => apiFetch(`/v1/friends/${userId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["friends"] }),
  });
}

export function useMyFriendCode() {
  return useQuery({
    queryKey: ["friend-code"],
    queryFn: () => apiFetch("/v1/friends/code") as Promise<MyFriendCode>,
  });
}

export function useFriendsProgress() {
  return useQuery({
    queryKey: ["friends-progress"],
    queryFn: () => apiFetch("/v1/friends/progress") as Promise<FriendsProgress>,
  });
}

export function useSetShareProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (share_progress: boolean) =>
      apiFetch("/v1/me/share-progress", { method: "PATCH", body: JSON.stringify({ share_progress }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["friends-progress"] });
    },
  });
}

// Plain function, not a hook: it is called from the sign-in flow, outside any
// component that could hold a mutation.
export function setDisplayName(display_name: string): Promise<unknown> {
  return apiFetch("/v1/me", { method: "PATCH", body: JSON.stringify({ display_name }) });
}

// Plain function, not a hook: called from the sign-in flow, outside any
// component that could hold a mutation.
export function storeAppleAuthorization(authorization_code: string): Promise<unknown> {
  return apiFetch("/v1/me/apple-authorization", {
    method: "POST",
    body: JSON.stringify({ authorization_code }),
  });
}

export function useGroups() {
  return useQuery({ queryKey: ["groups"], queryFn: () => apiFetch("/v1/groups") as Promise<GroupSummary[]> });
}

export function useGroup(id: string) {
  return useQuery({ queryKey: ["group", id], queryFn: () => apiFetch(`/v1/groups/${id}`) as Promise<GroupDetail>, enabled: !!id });
}

export function useGroupProgress(id: string) {
  return useQuery({ queryKey: ["group-progress", id], queryFn: () => apiFetch(`/v1/groups/${id}/progress`) as Promise<GroupProgress>, enabled: !!id });
}

export function useGroupCode(id: string) {
  return useQuery({ queryKey: ["group-code", id], queryFn: () => apiFetch(`/v1/groups/${id}/code`) as Promise<GroupCode>, enabled: !!id });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiFetch("/v1/groups", { method: "POST", body: JSON.stringify({ name }) }) as Promise<GroupSummary>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
  });
}

export function useJoinGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => apiFetch("/v1/groups/join", { method: "POST", body: JSON.stringify({ code }) }) as Promise<GroupSummary>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
  });
}

export function useLeaveGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      apiFetch(`/v1/groups/${groupId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: (_d, { groupId }) => {
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["group", groupId] });
    },
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      apiFetch(`/v1/groups/${groupId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: (_d, { groupId }) => qc.invalidateQueries({ queryKey: ["group", groupId] }),
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => apiFetch(`/v1/groups/${groupId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
  });
}

export function useRenameGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, name }: { groupId: string; name: string }) =>
      apiFetch(`/v1/groups/${groupId}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: (_d, { groupId }) => {
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["group", groupId] });
    },
  });
}

export function useInviteToGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      apiFetch(`/v1/groups/${groupId}/invite`, { method: "POST", body: JSON.stringify({ user_id: userId }) }),
    onSuccess: (_d, { groupId }) => {
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["group", groupId] });
      qc.invalidateQueries({ queryKey: ["group-progress", groupId] });
    },
  });
}

export function useGroupChallenges(groupId: string) {
  return useQuery({
    queryKey: ["group-challenges", groupId],
    queryFn: () => apiFetch(`/v1/groups/${groupId}/challenges`) as Promise<ChallengeSummary[]>,
    enabled: !!groupId,
  });
}

export function useChallenge(cid: string) {
  return useQuery({
    queryKey: ["challenge", cid],
    queryFn: () => apiFetch(`/v1/challenges/${cid}`) as Promise<ChallengeDetail>,
    enabled: !!cid,
  });
}

export function useCreateChallenge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, title, metric, duration }: { groupId: string; title: string; metric: Metric; duration: string }) =>
      apiFetch(`/v1/groups/${groupId}/challenges`, { method: "POST", body: JSON.stringify({ title, metric, duration }) }) as Promise<{ id: string }>,
    onSuccess: (_d, { groupId }) => qc.invalidateQueries({ queryKey: ["group-challenges", groupId] }),
  });
}

export function useJoinChallenge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ challengeId }: { challengeId: string; groupId: string }) =>
      apiFetch(`/v1/challenges/${challengeId}/join`, { method: "POST" }),
    onSuccess: (_d, { challengeId, groupId }) => {
      qc.invalidateQueries({ queryKey: ["challenge", challengeId] });
      qc.invalidateQueries({ queryKey: ["group-challenges", groupId] });
    },
  });
}

export function useLeaveChallenge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ challengeId }: { challengeId: string; groupId: string }) =>
      apiFetch(`/v1/challenges/${challengeId}/join`, { method: "DELETE" }),
    onSuccess: (_d, { challengeId, groupId }) => {
      qc.invalidateQueries({ queryKey: ["challenge", challengeId] });
      qc.invalidateQueries({ queryKey: ["group-challenges", groupId] });
    },
  });
}

export function useDeleteChallenge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ challengeId }: { challengeId: string; groupId: string }) =>
      apiFetch(`/v1/challenges/${challengeId}`, { method: "DELETE" }),
    onSuccess: (_d, { groupId }) => qc.invalidateQueries({ queryKey: ["group-challenges", groupId] }),
  });
}

export function useNotifications() {
  return useQuery({ queryKey: ["notifications"], queryFn: () => apiFetch("/v1/notifications") as Promise<AppNotification[]> });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: ["notifications", "unread"],
    queryFn: () => apiFetch("/v1/notifications/unread-count") as Promise<{ count: number }>,
    refetchInterval: 60000,
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/v1/notifications/read", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications", "unread"] });
    },
  });
}

export function useSubmitFeedback() {
  return useMutation({
    mutationFn: (input: SubmitFeedbackInput) =>
      apiFetch("/v1/feedback", {
        method: "POST",
        body: JSON.stringify(input),
      }) as Promise<FeedbackCreated>,
  });
}
