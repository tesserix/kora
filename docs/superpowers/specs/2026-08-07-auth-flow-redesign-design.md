# Auth flow redesign

Sharpens Kora's pre-app flow: sign-in, the account-link prompt, the entry gate,
and onboarding. Fixes an App Store compliance blocker, replaces a brand mark
that was never Kora's, and closes a gap where a new user can be stranded in an
empty app.

## Why now

Three things converged:

1. **Compliance.** The provider buttons carry no marks, and Apple's is rendered
   in Kora's green. Apple's HIG makes the Sign in with Apple button's mark and
   approved styles mandatory; this is a routine rejection, on the very feature
   added for Guideline 4.8 compliance (#108). It gates #109.
2. **The brand mark is wrong.** `BrandLockup` renders a generic Lucide
   `sparkles` glyph. Kora's actual mark — `assets/images/icon.png` — is a 3×3
   dot grid. Sign-in is where a new user first meets the brand, and it shows
   them the wrong one.
3. **A new-user gap that #108 widened.** See "The entry gate" below.

## Direction

**Sharpen what exists.** Keep the vocabulary the app already speaks — dark
surfaces, a single green accent, Apple-native idioms, SF Symbols on iOS — and
fix execution. Not a new aesthetic: roughly fifteen screens are already built in
this idiom, and an auth flow that doesn't match them makes the *app* look
inconsistent, which reads worse than plain-but-coherent.

Palette in play (`src/theme/palette.ts`, dark):

| Token | Value |
|---|---|
| `background` | `#0A0D0B` |
| `card` | `#151A16` |
| `cardSecondary` | `#1C231D` |
| `primary` | `#3DDC6E` |
| `primaryForeground` | `#06120A` |
| `label` | `#F3F7F2` |

## Component layer

Four new components in `src/components/`. All are presentation only — no auth
logic moves. Each is used more than once, which is why each is a component.

### `BrandMark`

Nine circles in a 3×3 grid, reproducing `icon.png`:

```
  ●  ·  ●        ● = large, colors.primary   (#3DDC6E)
  ●  ●  ·        · = small, colors.cardSecondary (#1C231D)
  ●  ·  ●
```

Six large dots in `colors.primary`; three smaller ones in
`colors.cardSecondary` at top-centre, middle-right and bottom-centre. The muted
dots are roughly 60% of the large dots' diameter, matching the icon. Plain
`View`s — the shape is circles, so SVG buys nothing.

Takes `size` and derives dot dimensions from it, so it stays crisp at any scale
and follows the theme rather than baking in hex. `BrandLockup` composes it
beside the wordmark, replacing the `Icon name="sparkles"` tile. Sign-in and
onboarding step 1 both pick it up with no change at their call sites.

**The kit keeps the wrong mark, and is cited as the authority for it.**
`BrandLockup`'s comment names `design-system/ui_kits/kora/Onboarding.jsx` as its
source, and the kit still renders the sparkles tile at three brand sites:
`Chrome.jsx:34`, `Onboarding.jsx:18`, `HomeScreen.jsx:93`. Left alone, the app
becomes right while its stated reference stays wrong — which reads as drift and
invites someone to "restore fidelity" back to the sparkle later. This pass
corrects those three kit sites and re-points `BrandLockup`'s comment at
`assets/images/icon.png` as the source of truth.

**The kit's other ten `sparkles` must survive.** (Thirteen in the kit total;
three are the brand tile.) They are an AI affordance,
not a brand mark — "Otto's take", "AI logged", "AI-matched", "Regenerate",
"Weekly report" — as is `app/meal.tsx:468` in the app itself. A blanket
find-and-replace would destroy the AI iconography. In scope are only the tiles
rendering the mark at 22–24px in `primary-foreground` on a `primary` fill.

*(Judgment call, not a locked decision: correcting the kit is cheap and prevents
reintroduction, but it is prototype JSX with no tests. Say so if you would
rather declare it out of scope — in that case `BrandLockup`'s comment must still
be re-pointed, or the divergence stays invisible.)*

### `AppleSignInButton`

Wraps `AppleAuthentication.AppleAuthenticationButton`, which renders Apple's
mark and enforces their approved styles.

- Style **`WHITE`** (white fill, black mark). On `#0A0D0B`, `BLACK` would
  disappear.
- `cornerRadius` from `theme.radius`.
- **Returns `null` on non-iOS**, so the iOS-only guarantee is structural rather
  than a call-site convention.

That last point is deliberate. `sign-in.tsx:153` and `LinkAccountPrompt.tsx:81`
both gate on `Platform.OS === "ios"` today, but the link prompt originally
*forgot* to — caught only by #108's final whole-branch review. A component that
cannot render on Android makes a third call site's omission impossible rather
than merely unlikely. The existing call-site guards stay as belt-and-braces.

`AppleAuthentication.isAvailableAsync()` is deliberately **not** used: it is
async and would flash the button in and out on mount, and every device running
Expo 57 is iOS 13+. An unprovisioned capability throws `ERR_REQUEST_UNKNOWN`,
which `firebaseAuthMessage` already maps to the iCloud message.

### `GoogleSignInButton`

Custom, not the library's `GoogleSigninButton` — that one is fixed-style and
does not match this app. Google's dark-theme branding spec: `#131314` fill,
`#8E918F` hairline border, white label, full-colour G mark. The G goes in as
`react-native-svg` paths (already a dependency); using their asset in a sign-in
button is what the branding guidelines permit.

### `Field`

A labelled input: persistent label above, input below, optional error slot
beneath.

The error slot exists on the component but **no screen uses it in this pass** —
sign-in keeps its single screen-level error under the form, and onboarding
validates on submit as it does today. Introducing per-field errors would change
validation behaviour, which this pass explicitly does not do.

Replaces the placeholder-as-label pattern across the flow — sign-in's Email and
Password, and onboarding step 2's birth year, height and weight. Placeholder-only
inputs lose their label the moment the user types, so anyone who pauses mid-form
loses context, and screen readers get a placeholder where a label belongs.

This is the largest diff of the four (five inputs across two screens) and the
easiest to drop if the pass needs tightening.

## Sign-in

First paint is quiet: lockup, heading, two provider buttons, one text link.

```
  ▓▓ Kora
  Welcome back.
  Sign in to pick up where you left off.

  [   Apple mark   Sign in with Apple   ]    white, Apple's own button
  [   G   Sign in with Google           ]    #131314, hairline border

  Use email instead                          text link, centred

  ─────────────────────────────────────
  New here?  Create an account               footer
```

Green leaves the provider buttons entirely — Apple's is white per the HIG,
Google's is their dark spec — which frees the accent to mean "the thing Kora
wants you to do" again. Today the loudest element on screen is not the primary
action.

**Use email instead** expands the `Field` pair and a green **Sign in →** button
*in place*, directly beneath the link. The provider buttons remain visible. The
submit sits next to its own fields, which is what fixes the stranded-primary
problem: `AuthScaffold`'s sticky footer no longer carries it.

**The `Segmented` control goes.** Its scope was ambiguous — sitting between the
provider buttons and the email fields, it read as though "Sign in / Create
account" might govern the providers. It does not, and cannot: Apple and Google
both sign in *and* register. Mode moves to the footer link, which flips between
**"New here? Create an account"** and **"Already have an account? Sign in"**,
with the heading and CTA following.

Error copy stays exactly where `firebaseAuthMessage` puts it.

## The link prompt

**Corrected premise, recorded so it is not relitigated:** mark8ly does **not**
auto-merge. `apps/mobile-admin/app/login.tsx:163,187` set a link target and
render `LinkAccountPrompt` at `:312`, requiring re-authentication before
linking. Kora already does the same — #108 ported it.

**Silent auto-merge is not a setting.** `linkWithCredential` requires an
already-signed-in user by design. Merging without proof of ownership would need
server-side Admin SDK work and would grant access to an existing account purely
on a provider's email claim — an account-takeover vector wherever that email is
unverified. Firebase throws `auth/account-exists-with-different-credential`
precisely to prevent it.

So the goal is not to remove the prompt but to **make it read as a merge rather
than a failure**.

Two settings confirmed live on `kora-app-e6d38`:

- `allowDuplicateEmails: false` — one account per email. This is what makes the
  conflict fire at all.
- `enableImprovedEmailPrivacy: **true**` — enumeration protection is on.
  Therefore `fetchSignInMethodsForEmail` returns `[]`, and
  `LinkAccountPrompt`'s **fail-open branch is the live path**, not a rare
  fallback. #108 designed for this as a hypothesis; it is now confirmed. The
  prompt will normally offer every method rather than naming the right one.

Changes, all copy and presentation — the handshake in `src/auth/link.ts` is
untouched:

- Lead with what happened, in plain terms: *"You already have a Kora account for
  sam@example.com. Sign in once to connect Apple."* Not an error tone, no red.
- Present the methods as a normal choice rather than a fallback list, since
  enumeration protection means we genuinely cannot know which is theirs.
- State that this is one-time: once linked, both buttons work.
- Adopt `AppleSignInButton` / `GoogleSignInButton` so the marks match sign-in.

## The entry gate

`app/(tabs)/_layout.tsx:34-36`:

```ts
useEffect(() => {
  if (profile.data && profile.data.onboarded_at === null) router.replace("/onboarding");
}, [profile.data]);
```

This fires **only once `profile.data` exists**, which produces two defects:

1. **A flash of empty app.** After sign-in, `router.replace("/")` renders the
   full tab bar and home screen while `GET /v1/me` is still in flight. A brand-new
   user sees an empty Kora — zero calories, empty diary — and is then bounced to
   onboarding. On a slow connection that is seconds of looking broken.
2. **Stranding on error.** If the profile request fails, `profile.data` stays
   undefined, the effect never fires, and the user sits in an empty tabs shell
   with no onboarding, no explanation and no way forward. Offline first-run
   produces exactly this.

Not social-specific — email/password signup has the same hole — but **#108
widened it substantially**. Becoming a new user used to require deliberately
filling a form; now one tap creates an account with `onboarded_at: null`, so the
cheapest path to a new account is also the likeliest to hit this.

**Fix: turn the redirect into a render gate**, resolved before `<Tabs>` renders.

- **Loading** → a minimal branded splash: `BrandMark` centred on
  `colors.background`. Not a spinner over an empty app; the app genuinely has
  not started yet, and the splash says so honestly.
- **Error** → "Couldn't load your profile" with a Retry that refetches. This is
  the state that currently strands people silently. **A 401 is excluded** — see
  below.
- **Resolved** → `onboarded_at === null` routes to `/onboarding`; otherwise
  `<Tabs>`.

**A 401 must not reach the error state.** `src/lib/api.ts` retries once on a
401; if the retry also comes back 401 it sets the expired notice, calls
`signOut`, and *still throws* `ApiError(401)` to the caller. So `profile.isError`
goes true at the very moment a redirect to `/sign-in?reason=expired` is already
in flight. Rendering "Couldn't load your profile" there is both wrong and
misleadingly actionable: Retry cannot succeed, because the session is gone.

The gate renders the **splash** when `profile.error` is an `ApiError` with
`status === 401`, and lets the existing `onAuthStateChanged` effect perform the
redirect.

**Do not discriminate using `takeSessionExpiredNotice()`.** It is a one-shot
that the sign-out effect consumes in order to attach `reason=expired`. Reading
it from the gate would steal the flag and silently drop the explanation on the
sign-in screen — turning a "your session expired" message into an unexplained
bounce. Discriminate on the error's status instead.

`TabsLayout` is the right place because it is the single chokepoint every entry
path crosses — fresh sign-in *and* cold start with an existing session. Routing
from `sign-in.tsx` instead would miss relaunches entirely.

The existing `onAuthStateChanged` sign-out effect is unchanged.

## Onboarding

A sharpening pass, not a restructure. Steps, copy, goal cards and progress dots
are unchanged — that structure is sound, and R1's bar is "a friend can onboard
unaided," which it already clears.

- `BrandMark` arrives via `BrandLockup` on step 1.
- `Field` replaces the placeholder-only birth year, height and weight inputs on
  step 2.
- Step 2's inputs are grouped so they read as three related questions rather
  than a wall of boxes.

**Deliberately not fixed:** partial onboarding is not persisted, so someone who
abandons at step 2 redoes step 1. Fixing that needs server state for partial
onboarding — real scope, for a rare case.

## Testing

Per the project's binding rule — *an assertion whose expected value equals the
initial state cannot distinguish "it worked" from "nothing ran"* — every absence
assertion below first reaches a state where a wrong implementation produces a
presence.

- **`AppleSignInButton` renders nothing on Android.** Assert it renders on iOS
  *first*, in the same suite, so the Android assertion is a disappearance rather
  than a component that never renders at all.
- **`BrandMark`** renders nine dots, six in `colors.primary` and three muted,
  with the muted ones at the three specified positions. A test that only counts
  nine would pass against a uniform grid.
- **Sign-in first paint** shows both provider buttons and no email fields; after
  pressing "Use email instead", the fields and submit appear. Assert the fields
  are *absent* first, then present — the reveal is the behaviour.
- **Mode toggle** flips heading, CTA and footer link together.
- **Entry gate**: loading renders the splash and **not** `<Tabs>`; error renders
  Retry and not `<Tabs>`; `onboarded_at: null` navigates to `/onboarding`;
  a populated profile renders `<Tabs>`. The loading and error cases are the two
  that do not exist today.
- **Entry gate, 401**: an `ApiError(401)` renders the splash and **not** the
  Retry affordance. Assert Retry is present for a non-401 error *first*, in the
  same suite, so its absence under a 401 is a disappearance rather than a
  control that never rendered. Assert too that the expired notice is left
  unconsumed, since consuming it is the failure mode that costs the sign-in
  screen its explanation.
The kit is prototype JSX and is **not** under jest, so its correction is
verified by inspection rather than asserted: after the change,
`grep -rc sparkles design-system/ui_kits/kora/` totals **10**, down from 13, and
the three removed are exactly `Chrome.jsx`, `Onboarding.jsx`, `HomeScreen.jsx`'s
brand tile. A blanket replace would drive that to 0 and is the failure this
check exists to catch.
- **Link prompt** keeps its existing fail-open coverage; new assertions cover
  the reframed copy naming the email.
- Suites stay green: `npx tsc --noEmit && npx jest --ci --forceExit`.

## Device verification

The simulator covers layout, the reveal, the mode toggle and the entry gate. It
does **not** settle two things:

1. Whether the Apple button's native rendering and sheet behave correctly under
   real signing — the same reason #108's device checks are still outstanding.
2. Whether enumeration protection changes which error surfaces on a real
   collision. It is confirmed on for this project, and its effect on
   `account-exists-with-different-credential` is not something the mocked suites
   can establish.

Both fold into the device pass already required for #108 and #106.

## Out of scope

- Any change to auth logic: `socialCredentials.ts`, `link.ts`, `socialAuth.ts`
  and `firebaseAuthMessage.ts` keep their behaviour. Copy in the mapper may
  change; branching may not.
- A new aesthetic direction for the app (rejected in favour of sharpening).
- Persisting partial onboarding.
- Server-side account merging.
