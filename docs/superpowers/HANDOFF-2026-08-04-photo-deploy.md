# Handoff — 2026-08-04 (later)

Take over Kora at `/Users/Mahesh.Sangawar/personal/tesserix-new/kora` (branch
`main`, clean). Sibling infra repo: `../tesserix-k8s`.

Supersedes `HANDOFF-2026-08-04-r1-photo-voice.md`, which is now history: the #82
it describes is **fixed and deployed**.

## START HERE

    .superpowers/sdd/progress.md    ← the ledger (gitignored). Trust it and
                                      `git log` over anything else, including
                                      this file.
    ~/.claude/projects/.../memory/MEMORY.md   ← durable gotchas

## PHOTO WORKS. VOICE IS NEXT.

**All three photo fixes are merged, deployed, and verified end to end on
2026-08-04.** Photo capture succeeded against prod for the first time in this
project's history:

    "route":"/v1/resolve/photo","status":200,"latency_ms":14568

and the app rendered real candidates from a seeded photo — "I found 5 items,
about 102 kcal", including Parsnips/Garlic actually present in the image,
resolved against the nutrition index with per-100g macros.

**14.5s is the number to remember**: it is why `photoBudget = 3s` could never
have worked, and it is the evidence that 20s was sized correctly rather than
guessed. Deployed digest was verified equal to what CI printed
(`sha256:012df731…`, commit `3dbd69b`).

**The next task is VOICE**, which has still never been exercised by anyone —
see OPEN below. Do not assume it works because photo does; they share
`buildFileForm` but nothing else about the voice path has ever run.

## WHAT SHIPPED TODAY

| | Fix | State |
|---|---|---|
| #82 | client never sent the multipart body | merged `7708627`, deployed, device-verified |
| #79 | gateway killed the request at 30s | merged `0259d80d` (infra), deployed, verified |
| #87 | 3s vision budget + a blind fallback | merged `3dbd69b`, deployed (digest-verified), **photo confirmed working** |

### Photo was broken by THREE stacked bugs

This is the single most important thing to understand about this area, because
each bug hid the next and **all three presented identically** — a 500 with no
detail.

1. **#82, client.** Expo SDK 57's winter `fetch` rejects React Native's legacy
   `{uri,name,type}` FormData part outright (`Unsupported FormDataPart
   implementation`), before any I/O. A removed API, not a bug — Expo's own suite
   pins the rejection. The `as unknown as Blob` cast hid it from tsc.
2. **#79, gateway.** Istio `perTryTimeout: 30s` made `router.go`'s 90s
   `fallbackBudget` unreachable. Prod showed 500 @ `latency_ms` 29999/30164 —
   the timeout to the millisecond.
3. **The vision budget.** `photoBudget` was **3s**, which no multimodal model
   meets, so every photo fell through to the fallback — configured in prod as
   `meta/llama-3.3-70b-instruct`, a **text-only** model that cannot see the
   image. That leg burned ~27s and failed. 3s + 27s = the observed 30,450 ms.

Fixing 1 revealed 2; fixing 2 revealed 3. **Expect this pattern to continue**
on any path that has never once succeeded in production.

## WHY IT STAYED INVISIBLE (and what changed)

`httpx.RespondServiceError` collapsed everything to
`{"error":"internal_error","message":"something went wrong"}` and **discarded
the error**. The AI layer logs nothing of its own — a grep of all
non-`http_request` lines in the window returned empty.

PR #87 fixes this: `RespondServiceError` now calls `c.Error(err)`, which
`RequestLogger` already surfaces on the `errors` field next to `request_id`,
route and `user_id`. That hook existed and its comment said nothing had ever
called it. Client response is unchanged — this changes what *we* see, not what
we disclose.

**Once #87 is deployed, a failing resolve will finally say why.** Until then,
assume any 500 on an AI route is opaque.

## OPEN, IN ROUGH PRIORITY ORDER

- **Voice has never been exercised end to end.** Not once, by anyone. It shares
  one code path with photo now (`buildFileForm`) and its multipart body is
  proven encodable in jest, but that is **not** device proof. Two known risks:
  - The **sim recorder never starts** — mic permission is granted
    (`kTCCServiceMicrophone=2`), Simulator.app is running, input devices exist,
    but `prepareToRecordAsync()` never settles and surfaces no error. Verify on
    a **physical device**.
  - **MIME.** We send `audio/mp4`. Gemini documents wav/mp3/aiff/aac/ogg/flac —
    `audio/mp4` is not on that list, nor is `audio/x-m4a` (which is what iOS
    would derive from the `.m4a` extension; measured via
    `UTType(filenameExtension:).preferredMIMEType`). The declared value is kept
    deliberately in `buildFileForm` — see #87's sibling note in `hooks.ts`.
- **#81 — `ai_usage_events` records only successes.** `withFallback` also drops
  the primary leg. `ai_usage_events` has **no outcome column**, so metering
  failures needs a migration; deliberately not bundled into #87. Until it lands,
  **zero rows never means "unused"** — a never-working path and a
  never-attempted path are indistinguishable.
- **#43 exporter.** Taxonomy decided (two counters: `resolution` =
  identify_photo|identify_text|transcribe|coach; `derived` = decompose|embed;
  COGS is the sum). Deliberately unbuilt until #81 lands, or it ships wrong.
- **CI gap in `tesserix-k8s`.** `.github/workflows/pr-validation.yaml` filters on
  `charts/**`, `argocd/**`, `.github/workflows/**` — **`manifests/**` is not
  covered.** The kora VirtualService gets no CI validation at all; only
  GitGuardian ran on PR #151. The `kubectl apply --dry-run=server` I ran by hand
  was its only real check, and nothing protects the next person.
- **#83 / #84 / #85** — 13 mutation sites with no error surface; the
  device-vs-profile timezone split; the grouped chore checklist.
- **#22 slice 2** — deferred AI resolution of photo/voice. Was blocked on #82;
  now blocked on #87 landing and photo actually working.

## THE TRAP THAT KEEPS CATCHING THIS CODEBASE

More than a dozen assertions here have passed while verifying nothing. Today
added a **new shape** worth knowing:

- **The harness itself was wrong.** Jest's global `FormData` is the
  WHATWG/undici one, which per spec coerces a non-`Blob` value with
  `String(value)` to `"[object Object]"` and **never throws**. On that harness
  the broken and fixed forms both encode, so any multipart test written against
  it verifies nothing. `jest.setup.js` now installs the pair the app actually
  has (RN's `FormData` + Expo's `installFormDataPatch`) via `jest.requireActual`
  — required, because **jest-expo automocks modules under `expo/`** and the
  patch was silently returning `undefined`.
- I caught it **only by reading the failure message**. The first "failing" run
  failed on `[object Object]`, not on the production error — a false red that
  would have turned green after the fix while proving nothing.

So: reason **backward** from "what implementation would make this pass while
broken?", and when a test fails, check it failed for the **right reason**. Then
break the behaviour each test names, confirm it fails on **that test's own
assertion**, revert, confirm `git diff` is clean. Review-by-reading has never
once caught these.

Every test added today was mutation-verified this way. The most instructive:
making `buildFileForm` use `File.type` instead of the declared MIME fails
**voice only** — photo passes because `png → image/png` collides. That
asymmetry is exactly why the voice assertion exists.

## ENVIRONMENT

    Postgres (Go tests):  TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'
    Go:      cd api && go test ./... ; go vet ./...
    Mobile:  cd apps/mobile && npx tsc --noEmit ; npx jest --ci --forceExit
             — 109 suites / 713 tests green, must stay green
    Expo deps: `npx expo install <pkg>`, never plain npm install

### DO NOT trigger builds

Mahesh is **out of EAS credits**. Do not run `eas build`. Note `npx expo
run:ios` is a *local* Xcode build and costs nothing, but ask first — and today
it was **not needed**: the installed dev build already contains
`ExpoFileSystem.framework`, so `expo-file-system` worked over Metro alone.

### `npx expo lint` has TWO side effects, not one

It regenerates `apps/mobile/eslint.config.js` (untracked on purpose — never
commit it) **and silently adds `eslint` + `eslint-config-expo` to
`devDependencies`**. Both were reverted today. Always `git diff package.json`
after running it. Baseline is 106 problems / 53 errors — unchanged means clean.

### Metro

**Metro IS running on 8083** against prod as of this handoff (restarted after an
earlier kill). Verify before trusting it — `lsof -nP -iTCP:8083 -sTCP:LISTEN` —
and restart with the command below if not.

8081/8082 belong to Home-Chef-App. Use 8083:

    cd apps/mobile && EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app \
      npx expo start --port 8083 --dev-client

**Verify by grepping the served bundle, never Metro's startup line:**

    curl -s "http://localhost:8083/node_modules/expo-router/entry.bundle?platform=ios&dev=true" \
      | grep -oE '"EXPO_PUBLIC_API_URL": \{ enumerable: true, value: "[^"]*"'

### Simulator

Sim `AD109A46-2F99-43C3-8AAA-FEE68DC8499E` (iPhone 17 Pro). `idb` lives at
`~/Library/Python/3.9/bin` (PATH-hidden). Mahesh confirmed the sim is free —
Home-Chef-App is not using it.

**Photo capture recipe that works** (the sim camera cannot capture — the
shutter does nothing — so force the library branch):

    xcrun simctl privacy <udid> revoke camera com.tesserix.kora
    xcrun simctl addmedia <udid> /tmp/meal.jpg     # accept "Allow Full Access" in-app
    # Capture tab @ (201,795) → Quick photo capture @ (41,815) → first photo @ (66,214)

Screenshots are 1206x2622 but render at 920x2000 — **multiply by 0.437** to get
logical tap points.

`idb ui text` truncates multi-word input — type, check `AXValue`, append the rest.

Wikimedia blocks image downloads from this sandbox; `https://picsum.photos/id/292/900/700`
works and is a genuine food photo.

### Testing offline — do NOT disable Wi-Fi

Mahesh declined this outright; it takes down the whole workstation.
- Mid-flight `NetworkError`: restart Metro with `EXPO_PUBLIC_API_URL=https://something.invalid`.
- netinfo / pre-flight: needs a **physical device** in airplane mode. Still unverified.

### Database — NOT Cloud SQL

The workspace `CLAUDE.md` is wrong for Kora. Kora is on self-hosted
**CloudNativePG**: cluster `global-postgres`, ns `global`, pod
`global-postgres-1`, db `kora_db`, **shared** with devai/homechef/mark8ly/
stockpilot. Keep prod queries cheap and set `statement_timeout`.

### ArgoCD — "Synced / Healthy" is NOT evidence

Hit again today. `kora-istio` reported **Synced / Healthy** while still serving
the old policy, because it was synced against the commit *before* the merge.
Always compare `.status.sync.revision` to git HEAD:

    kubectl -n argocd get application <app> -o jsonpath='{.status.sync.revision}'
    kubectl -n argocd annotate application <app> argocd.argoproj.io/refresh=hard --overwrite

### Permission classifier

Several commands were denied outright this session, unrelated to correctness:
`gh pr merge`, `gh issue view`, and `kubectl exec` into `global-postgres-1`.
If you hit one, don't work around it — ask Mahesh to run it with a leading `!`.

## PROCESS

Mahesh's global CLAUDE.md mandates **subagent-driven execution** for plans
(`superpowers:subagent-driven-development`); never ask "inline or subagent".
Tell implementer subagents to run tests in the **foreground** — backgrounded
runs stall here.

Commits: conventional prefix, **single line, no body, no trailers, no
signature**. PRs are **squash**-merged.

## LESSONS THAT PAID TODAY

- **Read the failure message, not just the pass/fail.** A test that fails for
  the wrong reason is a false red, and it becomes a false green the moment you
  "fix" the thing it isn't testing. This is what caught the FormData harness.
- **Check the reference, don't infer it.** Every load-bearing fact today came
  from reading the actual source — Expo's converter and its own test suite, RN's
  `BlobManager`, `FileSystemFile.swift`, the VirtualService, the prod env — not
  from reasoning about what the API probably does. The `audio/x-m4a` finding was
  *measured* with a three-line Swift script, and it changed the fix.
- **A fallback that cannot serve the request is worse than none.** It costs a
  paid call, adds latency, and masks the real error. `Transcribe` already knew
  this; photo now does too.
- **Fixing the visible bug reveals the next one.** Budget for that on any path
  with zero successful production calls, and fix the observability first if you
  can — otherwise each layer costs a full debug cycle to see.
