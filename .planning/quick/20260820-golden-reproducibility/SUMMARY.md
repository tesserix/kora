---
quick_id: 260820-grp
slug: golden-reproducibility
date: 2026-08-20
refs: kora#257 (Stage C), kora#289
status: done — 10 goldens, reproduced from a clean tree in an independent session and under a different account
---

# Making the #289 golden set actually reproducible

## Headline

**#289 shipped a golden set that failed all 13 of its own routes.** On a clean
tree the comparator flagged the same 243 pixels on every route — the status-bar
battery glyph — and two routes additionally embedded the capturing account's
email address. A golden set that its own harness cannot reproduce is worse than
none: it is red on every run, so it gets ignored, and then it protects nothing.

The battery is now **masked out of the comparison** rather than pinned harder,
because the pin's failure is silent and did not reproduce on demand. The
identity-bearing and calendar-bearing routes are **excluded with stated
reasons**. The set is **10 routes, 1.58 MB**, and it has been reproduced from a
fresh capture session, from a clean tree, and — the part #289 never had — under
a **different account**.

Green -> red on a one-character label edit -> green again, each from a fresh
capture.

---

## 1. The battery: what was actually established

`shots.mjs:296` pins `--batteryState charged --batteryLevel 100`. The #289
goldens carry the plain white **discharging** glyph.

**Rendering is unambiguous** on this device and runtime (iPhone 17 Pro Max,
iOS 26.2). Cycling `simctl status_bar override --batteryState` through all
three values and screenshotting each:

| state | glyph |
| ----- | ----- |
| `discharging` | white outline, no bolt — **this is what the goldens contain** |
| `charging` | green fill, white bolt |
| `charged` | green fill, grey bolt — **this is what the harness asks for** |

**The pin ran, and it partly worked.** The code at the golden-capture commit
(`ae575a1d`) is byte-identical to today's, `simctl` exits non-zero on failure
and `shots.mjs` throws on that, and the goldens themselves show the pinned
clock (9:41), the pinned 4-bar cellular, the pinned wifi, and a **100% battery
against a host sitting at 79%**. So the override was applied and the *level*
component of it took. Only `state` did not.

**Eliminated by experiment**, all on the same simulator, which `launchd_sim`
shows has been running continuously since 18 Aug 16:57 — i.e. the same boot
session as the #289 capture:

| hypothesis | test | result |
| ---------- | ---- | ------ |
| host power state drives the glyph | `pmset -g log` across both sessions | AC attached at 79% continuously — **falsified** |
| the simulator was rebooted between | `ps` on `launchd_sim` | same process since before #289 — **falsified** |
| `simctl ui content_size` clobbers it | pin, then set content size | survives |
| app terminate / relaunch clobbers it | pin, then terminate + launch | survives |
| SpringBoard restart clobbers it | `launchctl kickstart -k system/com.apple.SpringBoard` | survives |
| it decays with time | 20 screenshots over 10 minutes | no drift |
| override merge semantics lose it | issue a time-only override afterwards | battery retained |
| the command silently failed | `simctl` exit code; `shots.mjs` throws | would have aborted the run |

**Conclusion.** The trigger does not reproduce: twenty monitored probes and a
full three-route harness run all render the pinned `charged`. What *is*
established is the shape of the failure — `simctl status_bar override` exits 0,
`simctl status_bar list` reports the requested value, and the rendered pixels
disagree. Nothing in the harness reads the pixels back, so the divergence is
invisible, and once it happens it is sticky for the whole session: re-issuing
an identical override is a no-op. That is exactly the pattern observed, all 13
routes wrong in the same way.

**So the answer is not to pin harder.** A pin whose failure is silent and
unreproducible cannot be the basis of a pass/fail rule. And even a perfect
battery pin leaves everything else iOS can put in that band — Focus, the
orange/green privacy dots, VPN, screen recording, the location arrow, Low Power
Mode, a Live Activity expanding the Island — equally unpinned and equally able
to fail every route at once.

**The status bar is now excluded from the comparison.** `GOLDEN.ignoreTop = 62`
removes the top 62 golden-space rows from all three rules *and* from the
frame-share denominator. The band carries no app information; the fact that the
clock was already pinned separately was an admission of exactly that.

Measured, on the 1x frame (440x956):

- the Dynamic Island's lowest black pixel is **row 51**
- the battery glyph spans rows 26-39, the clock roughly rows 20-44
- the topmost **app**-drawn element on any route sits at **y=70**
  (`idb ui describe-all`, minimum `frame.y` across the walk)

62 is the device's top safe-area inset: above every system glyph, below every
pixel the app may draw content on. A unit test asserts the constant stays
inside that 51..70 window, so widening it to hide a failure breaks a test that
says why the window exists.

**The mask does not blunt the rule.** Against the #289 goldens, masking takes
`sign-in` and `onboarding` from 243 differing pixels to **exactly zero** —
proving the status bar was the *only* difference on those routes — while the
one-character label edit the suite is falsified against still fails at exactly
38 pixels, the same figure #289 measured without a mask.

The `pinStatusBar` call is kept, annotated as cosmetic: it makes the captured
images comparable to a human eye. It is no longer load-bearing.

---

## 2. The identity-bearing routes, and one more nobody had noticed

`profile` and `tab-more` embed the signed-in email. Three options were on the
table; this is what each costs.

**`profile` — EXCLUDED.** The screen *is* the account: email, avatar initial,
the four macro targets, current weight, and `MEMBER SINCE August 2026`. Its
pixels are a function of who captured it, and the member-since line is a
function of the real calendar on top of that. The #289 golden embeds
`shotc1@kora.test`, an account deleted at the end of that session — so it could
never have been reproduced by anyone, including its author.

- *Fixed capture account:* works, but makes the suite depend on a credential
  the next person will not have, and contradicts this repo's own rule that
  throwaway accounts are deleted after use.
- *Mask the identity region:* would blank the account card, the targets card
  and the weight card, leaving a back chevron and three section headers. It
  would also blank precisely the region where a long email overflows — the bug
  class the harness exists for.

**`tab-more` — EXCLUDED.** Same defect, smaller surface: the account row
carries the email and initial, and the AI-usage row carries the account's
remaining quota (`20 left`), which moves as the account is used. Masking was
tempting here because the rest is a static menu — but the mask would have to
cover the account card, which is the one place on this screen where an overlong
email overflows. Excluded rather than masked at the point of interest.

**`ai-usage` — EXCLUDED. This one was not in the brief and is worse than the
email.** Its quota card renders *absolute* reset dates — "resets Fri, Aug 21 at
10:00 AM", "resets Mon, Aug 24", "resets Tue, Sep 1" — and they come from the
**server's** clock, not from `EXPO_PUBLIC_SHOTS_CLOCK`. The proof is inside
#289's own golden set: the app clock is pinned to **Aug 19** and `tab-diary`'s
week strip duly highlights the 19th, while `ai-usage` computes its daily reset
from the **20th**, the real capture date. That golden expires at midnight
regardless of what the harness pins. Nobody would have found this by looking at
the images; it would have gone red the next morning and been blamed on flake.

Each exclusion says what would remove it. All three want the same thing: a
capture-mode fixture profile (fixed email, targets and join date) behind the
same flag as the clock pin — Stage B's outstanding "fixture data" item.

**13 -> 10, and 10 that reproduce is worth more than 13 that do not.**

---

## 3. The clean-tree reproduction — the deliverable

Everything below is a **separate capture session**: Metro stopped and
restarted, app terminated and relaunched per route by the harness.

| # | what | result |
| - | ---- | ------ |
| 1 | goldens captured (account A, `shotg1@kora.test`) | 10 written, 5 excluded, 1.58 MB |
| 2 | **Metro restarted**, candidate captured, compared | **10/10 ok, exit 0** — 8 routes byte-identical |
| 3 | account A **deleted**, account B (`shotg2@kora.test`) created and onboarded, candidate captured, compared | **10/10 ok, exit 0** |

Step 3 is the property #289 never demonstrated and the one that matters: the
goldens reproduce under a **different account**, so nothing in the committed set
depends on who captured it.

The account fixture turned out to need no remembered inputs at all — the
onboarding defaults (Lose weight, Male, 30 years, 170 cm, 70 kg) are what
produce the 1,957 kcal / 140 g / 227 g / 54 g targets in the goldens. The
recipe is "create an account, change nothing, tap Start with this plan", and it
is written into `shots-golden/README.md` along with the full contract of what a
golden is a function of.

Residual noise on the passing set, worst of the three sessions: `tab-diary`
1.353% of frame over 8/255 (budget 3%, 2.2x margin) and max delta 36/255
(threshold 48); `tab-progress` 0.448% and 34/255. Every other route was exactly
zero on every rule.

## 4. The falsification re-run

One character deleted from a card title (`app/about.tsx:46`, "Open Food Facts"
-> "Open Food Fact"), fresh capture:

```
about            211       38    0.012 140,440 20x20            9.0%   FAIL
  about: 38 pixel(s) differ beyond the threshold
```

**exit 1, on `about` and no other route.** 38 pixels — identical to #289's
measurement, so the 62-row mask costs the rule nothing. Its densest block is
9.0%, well under the 30% density rule: only the strict pixel budget catches it,
which is the whole argument for the budget.

Reverted, re-captured: **10/10 ok, exit 0.**

---

## 5. What changed

| file | change |
| ---- | ------ |
| `scripts/shots.goldens.mjs` | `GOLDEN.ignoreTop = 62` with the experiments that ruled out pinning harder; exclusions for `profile`, `tab-more`, `ai-usage` |
| `scripts/shots-blocks.mjs` | `blockDensities` takes `ignoreTop`: masked rows skipped by all three rules and removed from the frame-share denominator; boundary-straddling blocks measured over their real area |
| `scripts/shots-compare.mjs` | passes the mask, prints it on every run, and **refuses** a golden set accepted under a different mask |
| `scripts/shots-golden.mjs` | records `ignoreTop` in the golden manifest |
| `scripts/shots.mjs` | `pinStatusBar` annotated: cosmetic, not load-bearing, with the #289 evidence |
| `scripts/__tests__/shots-blocks.test.mjs` | 6 new tests (16 total) |
| `shots-golden/README.md` | the contract: what a golden is a function of, and the account fixture recipe |
| `shots-golden/medium/` | re-captured; 13 -> **10** goldens, **1.58 MB** |

The new tests are the ones that would have caught #289: a full-amplitude defect
placed inside the masked band must be invisible **and** must fail without the
mask (so the mask is provably what makes the suite green); the mask must not
extend one row further than it claims; masked rows must leave the frame-share
denominator; and the constant must stay between the Island's last row and the
app's first element.

## 6. Environment left as found

Content size `medium`; both throwaway accounts (`shotg1@kora.test`,
`shotg2@kora.test`) deleted through the app's own delete-account flow, each
confirmed by a subsequent sign-in with correct credentials returning "Email or
password is incorrect"; the dev-menu FAB preference restored; my Metro on 8083
stopped; the pre-existing Metro on 8081 and 8082 untouched; every `.shots/`
directory from this session removed.

## 7. Verification

- `node --test scripts/__tests__/*.test.mjs`: **16/16 pass**
- `npx eslint` on all harness scripts and tests: clean (prettier deliberately
  not run — this repo has no prettier config)
- `npx tsc --noEmit`: clean
- Full jest suite: **207 suites / 1817 tests pass**
- Comparator: green (10/10, exit 0) from an independent session -> green again
  under a different account -> red on a one-character label edit (exit 1, one
  route) -> green after revert, each from a fresh capture

## 8. Still open

- **`tab-today` and `capture`** remain excluded on the pre-existing
  determinism grounds from #289; nothing here changed them.
- **A capture-mode fixture profile** would return `profile`, `tab-more` and
  `ai-usage` in one move. It is the single highest-value follow-up.
- **Only `medium`.** Unchanged from #289.
- **Not wired into CI.** Unchanged from #289.
