# Plan — Kora imperial/metric units preference (branch elevated-v2)

## Context
Kora stores all body metrics in metric on the backend (`weight_kg`, `height_cm`, `water_ml`) and always sends metric. This feature adds a **client-only display + input** preference so US users can see/enter **imperial** (lb, ft/in). No backend change. v1 scope = **weight + height only**; water (fl oz) is explicitly out of scope (follow-up).

Preference lives in a new `UnitsProvider` (React context, AsyncStorage-backed, default `metric`) mounted in `app/_layout.tsx`. A new `app/settings.tsx` screen (reached from More) toggles it.

## Global Constraints (binding — reviewers copy verbatim)
- **HARD INVARIANT — backend stays metric.** Every network payload keeps its metric field name and metric value: `onboarding` submit sends `height_cm` (cm) + `weight_kg` (kg); `addWeight` sends `weight_kg` (kg). Imperial input is converted to metric *before* the mutation and *before* `validateOnboardingNumbers`. No lb/ft/in value ever reaches the API. Existing payload/validation tests must pass **unmodified** (default `metric` exercises the unchanged path).
- **Tokens-only in screens.** Colors from `useTheme()` `colors.*`, spacing/radius from theme. No hex literals in screens/components (palette files excepted).
- **Conversion constants (exact):** `KG_PER_LB = 0.45359237`; `LB_PER_KG = 2.2046226218`; `CM_PER_IN = 2.54`. `lbFromKg(kg)=kg*LB_PER_KG`; `kgFromLb(lb)=lb*KG_PER_LB`; `cmFromFtIn(ft,inch)=(ft*12+inch)*CM_PER_IN`. ft/in from cm: `totalIn=cm/CM_PER_IN; ft=floor(totalIn/12); inch=round(totalIn-ft*12)`; if `inch===12` then `ft+=1; inch=0` (rollover).
- **RNTL v14** — `render()`/`renderHook()` are async; `await` them. Tests run **foreground**: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`.
- Single-line conventional commit, no signature, never `git add -A` (stage named files only). CNG project — do not touch `ios/`.

## Task 1: Units conversion module + preference store

Create `apps/mobile/src/units/` (new domain module). TDD — write conversion tests first (RED), then implement.

**`src/units/convert.ts`** — pure, no React:
- `export type UnitSystem = "metric" | "imperial";`
- Constants above.
- `lbFromKg`, `kgFromLb`, `cmFromFtIn(ft, inch)` and `ftInFromCm(cm): { ft: number; inch: number }` (with the `inch===12` rollover).
- `formatWeight(kg: number, system: UnitSystem): { value: string; unit: string }` — metric `{ value: kg.toFixed(1), unit: "kg" }`; imperial `{ value: lbFromKg(kg).toFixed(1), unit: "lb" }`.
- `formatHeight(cm: number, system: UnitSystem): { value: string; unit: string }` — metric `{ value: String(Math.round(cm)), unit: "cm" }`; imperial `{ value: `${ft}'${inch}"`, unit: "" }` using `ftInFromCm`.
- `weightUnitLabel(system)` → `"kg"|"lb"`; `parseWeightToKg(text: string, system): number | null` — `parseFloat`; return null if not finite or `<= 0`; metric returns the value, imperial returns `kgFromLb(value)`.

**`src/units/UnitsProvider.tsx`** — context + persistence:
- `UnitsContext` with `{ system: UnitSystem; setSystem: (s: UnitSystem) => void }`.
- `UnitsProvider`: `useState<UnitSystem>("metric")`; on mount, read AsyncStorage key `"kora.units"` and set if it is `"metric"|"imperial"`; `setSystem` updates state and best-effort writes AsyncStorage (never throw — wrap in try/catch). Import `AsyncStorage` from `@react-native-async-storage/async-storage`.
- `useUnits()` — `useContext`; if undefined, return `{ system: "metric", setSystem: noop }` (safe default so screens/tests without the provider still render metric).

**`src/units/index.ts`** — re-export everything.

**Mount:** in `app/_layout.tsx`, wrap the `<Stack>` with `<UnitsProvider>` (inside `QueryClientProvider`).

**Tests** — `src/units/__tests__/convert.test.ts` (RED first): kg↔lb round-trips (e.g. `formatWeight(78.6,"imperial").value === "173.3"`; verify: 78.6*2.2046226218=173.28 → "173.3"), `formatHeight(180,"imperial")` → `{value:"5'11\"", unit:""}` (180/2.54=70.87in → ft 5, inch round(10.87)=11), rollover case `formatHeight(182.9,"imperial")` (182.9/2.54=72.0in → ft6 inch0, not 5'12"), `parseWeightToKg("150","imperial")` ≈ 68.04, `parseWeightToKg("0","metric")===null`, `parseWeightToKg("abc",...)===null`, metric passthrough. Keep an eye on float tolerance — assert on formatted strings or `toBeCloseTo`.

**Files:** `src/units/convert.ts`, `src/units/UnitsProvider.tsx`, `src/units/index.ts`, `src/units/__tests__/convert.test.ts`, edit `app/_layout.tsx`.

## Task 2: Settings screen + More entry

**`app/settings.tsx`** (new pushed route — expo-router auto-discovers; no `_layout` Stack.Screen needed):
- Structure mirrors `app/profile.tsx`: `<View flex:1 bg colors.background><AppBackground/><ScrollView paddingTop: insets.top+8, paddingBottom:140>`.
- `<ScreenHeader overline="Preferences" title="Settings" onBack={() => router.back()} />`.
- Body `paddingHorizontal: 20`, a `<Card variant="elevated">` (or `GroupedSection`) containing: an `<Overline>Units</Overline>`-style label (use `AppText variant="footnote" muted`), a `<Segmented>` (import from `@/components/Segmented`) with options `[{key:"metric",label:"Metric"},{key:"imperial",label:"Imperial"}]`, `value={system}`, `onChange={(k)=>setSystem(k as UnitSystem)}` from `useUnits()`, and a caption `AppText variant="caption" muted` = "Weight and height display.".
- Tokens-only.

**`app/(tabs)/more.tsx`** — add a `Row` **"Settings"** (icon `{ name: "settings", tint: colors.accent }` — verify `"settings"` resolves in `src/components/Icon.tsx` map; if not, use `"sliders-horizontal"`), `chevron`, `onPress={() => router.push("/settings" as Href)}`. Place it in its **own `GroupedSection`** inserted **between** the account section and the Sign-out section.

**Tests** — `app/__tests__/settings.test.tsx` (await render): renders title "Settings" + both segment labels; tapping "Imperial" calls `setSystem("imperial")` (mock `@/units` `useUnits` to supply a spy `setSystem`). Follow the mocking style already used in `app/__tests__/profile.test.tsx` / `index.test.tsx`.

**Files:** `app/settings.tsx`, edit `app/(tabs)/more.tsx`, `app/__tests__/settings.test.tsx`.

## Task 3: Wire weight + height conversions across screens

Use `useUnits()` in each screen; convert **display** out and **input** back to metric. Backend payloads stay metric (Global Constraint).

**`app/profile.tsx`** (weight card, ~line 119-122): replace `data.weight_kg.toFixed(1)` + `"kg"` with `formatWeight(data.weight_kg, system)` → `<Numeral size={24}>{fw.value}</Numeral><AppText muted>{fw.unit}</AppText>` (guard `data` null → `—`).

**`app/(tabs)/progress.tsx`** (weight card):
- `current` display: compute `const w = formatWeight(current, system)` when `current>0`; feed the numeric to `AnimatedNumber` as `system==="imperial" ? lbFromKg(current) : current` with `format={weightFormat}` (1 dp) and render the unit `AppText` as `w.unit` (dynamic, was hardcoded "kg").
- delta badge: convert delta — `const d = system==="imperial" ? lbFromKg(delta) : delta;` label `` `${d>0?"+":""}${d.toFixed(1)} ${weightUnitLabel(system)}` ``.
- `WeightChart` is shape-only (no numeric axis) — **do not** change it. Date labels unchanged.

**`src/components/progress/WeightLogSheet.tsx`** (input):
- Display initial in preferred unit: seed `text` from `initialKg` converted (`system==="imperial" ? lbFromKg(initialKg) : initialKg`, when `>0`), and re-seed in the `visible` effect.
- Unit label AppText + `accessibilityLabel` dynamic: metric "Weight in kilograms" / imperial "Weight in pounds".
- `onSave`: `const kg = parseWeightToKg(text, system);` if null → error "Enter a weight in {unit}."; else `addWeight.mutate({ weight_kg: kg }, …)`. **Payload stays `weight_kg` in kg.**

**`app/onboarding.tsx`** (inputs, ~line 70-71, 134, 145):
- Weight field: label "Weight (kg)"/"Weight (lb)"; keep storing raw text; on submit `weight_kg: system==="imperial" ? kgFromLb(Number(weightText)) : Number(weightText)`.
- Height field: metric → single "Height (cm)" numeric field (unchanged). Imperial → **two** small numeric fields side by side, "ft" and "in"; on submit `height_cm: system==="imperial" ? cmFromFtIn(Number(ft), Number(inch)) : Number(heightCm)`.
- `validateOnboardingNumbers` runs on the **metric** values (convert first, then validate) so its cm/kg ranges stay valid. Keep the validate-gates-submit behavior intact.
- **Payload stays `height_cm`(cm) + `weight_kg`(kg).**

**Tests:**
- Existing `profile.test.tsx`, `index.test.tsx`, `validateOnboarding.test.ts`, and any onboarding submit test must pass **unmodified** (default metric).
- Add: `progress` weight-card imperial display (mock `useUnits` → imperial, assert "173.3" + "lb" for 78.6 kg); `WeightLogSheet` imperial save converts lb→kg in the `addWeight` payload; onboarding imperial submit sends metric `height_cm`/`weight_kg` (ft/in + lb → cm/kg). Mock `@/units useUnits` per test.

**Files:** edit `app/profile.tsx`, `app/(tabs)/progress.tsx`, `src/components/progress/WeightLogSheet.tsx`, `app/onboarding.tsx`; add/extend the named test files.

## Out of scope (follow-up)
Water in fl oz (diary total + quick-add relabeling); per-unit rounding niceties; syncing preference to backend/profile.
