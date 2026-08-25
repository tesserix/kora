# Social sharing permissions — per-circle, per-category

Design for kora#326. Supersedes the global `users.share_progress` boolean.

## The problem

Visibility must be a function of **(viewer, category)**, not one global switch.
The worked example that raised it:

> my spouse and I can share all weight metrics, measurements etc — but the same
> cannot be shared with other friends

## What already exists

#326 reads as greenfield. It is not, and the design below is shaped by what ships
today.

- `api/internal/social` — friendships, requests, accept/decline, unfriend, codes
- `api/internal/groups` — groups, invite codes, membership
- `api/internal/challenges` — challenges, standings, winners
- `api/internal/compare` — cross-user progress
- App screens: `friends.tsx`, `groups.tsx`, `group/[id].tsx`, `challenge/`

**Two endpoints already return another user's data in production:**
`GET /v1/friends/progress` and `GET /v1/groups/:id/progress`.

**A consent model already exists.** `users.share_progress` (migration `000010`),
`NOT NULL DEFAULT false`, toggled by `PATCH /v1/me/share-progress`.
`compare.ProgressForMembers` documents itself as "the single consent gate".

**It is already not single.** `challenges.standingsFor` scores every participant
from their food logs and never consults `share_progress`. Not a leak —
`ListParticipantsForScoring` reads only `challenge_participants`, so a user must
have joined — but it is a second, independently-decided consent mechanism. The
fragmentation this issue exists to prevent has happened once already.

**There is no owner-scoping abstraction.** No tenant concept; ownership is 57
hand-written `user_id = ?` filters across the repositories. The issue asks whether
this "composes with the existing pattern". There is no pattern to compose with.

## Decisions

| Question | Decision |
|---|---|
| Granularity | **Named circles**, people assigned to them |
| Direction | **Independent per direction** — my grant exposes only my data |
| v1 categories | **`progress`** (exists) and **`body`** (the ask) |
| Enforcement | **A viewer-scoped gateway** every cross-user read goes through |
| Challenges | **Joining stays its own consent**, documented rather than unified |

Rejected, and why:

- **Per-person grants** — what the issue asked for, but the settings surface and
  the audit view both grow with the friend list, and "who sees my weight?" becomes
  a scan rather than a lookup. Circles cover the spouse case at lower cost.
- **Per-person overrides on top of circles** — two mechanisms and a precedence
  rule users must hold in their heads. Permission bugs hide in precedence rules.
- **Reciprocal grants** — one person's change would alter what another exposes.
  Unacceptable for body composition.
- **All seven categories from the issue** — five have no read path to enforce
  against, so they would be settings that claim to do something and are never
  exercised. The worst kind of permission bug.

## Data model

```
share_circles         (id, owner_id, name, created_at)
share_circle_members  (circle_id, member_user_id, added_at)
share_grants          (circle_id, category, created_at)
```

Access resolves to: *does there exist a circle owned by O, containing V, granted C?*

Directionality falls out of ownership — a circle exposes only its owner's data,
so the reverse grant is a different row in a different circle.

**`category` is `TEXT` validated against a Go registry, not a Postgres enum.**
Follows the pattern established by #399 (`derive the metric allow-list from one
table`): adding `recipes` later is a registry entry plus a read-path adoption,
with no `ALTER TYPE`. The registry is also what stops a typo'd category from
silently granting nothing.

Membership is constrained to existing friendships. A circle is not a second way
to know someone — #153 and the shipped friend-request flow remain the only edges;
this governs what flows along them.

### Migration

`users.share_progress` is **removed**, not kept alongside — leaving it would be a
third consent mechanism.

- `share_progress = true` → create a circle named "Friends" holding that user's
  current friends, granted `progress`
- `share_progress = false` → write nothing; the default stays deny

This is cheap **because Kora is pre-launch with one real account**. The same
migration against a live user base would deserve materially more care than is
specified here.

### Challenges

`challenge_participants` is unchanged. `standingsFor` gains a comment stating that
participation **is** the consent and is deliberately not `share_grants`, so the
next reader does not "fix" the inconsistency into a bug. The join UI says what
joining exposes.

## Enforcement

One package, `access`, owns the question.

```go
type Grant struct {           // unexported fields
    viewer, owner uuid.UUID
    category      Category
}
func (g Grant) Owner() uuid.UUID

func (s Service) Resolve(ctx context.Context,
    viewer, owner uuid.UUID, c Category) (Grant, error)   // ErrNotShared

func (s Service) ResolveMany(ctx context.Context,
    viewer uuid.UUID, owners []uuid.UUID, c Category) (map[uuid.UUID]Grant, error)
```

Cross-user read services take a `Grant`, never a bare owner UUID, and use
`grant.Owner()` as the query key. No signature in the codebase hands over another
person's rows from an ID the caller happens to hold.

**This is fail-safe, not uncircumventable.** Go permits `access.Grant{}` from any
package; only the fields are unreachable. A forged grant therefore carries
`uuid.Nil` and resolves to zero rows. The failure mode of circumventing the
gateway is *no data*, never *someone else's data*. Stated plainly here because the
stronger claim is wrong.

**`ResolveMany` ships from day one.** Both existing cross-user endpoints fan out
over many owners; per-owner resolution would be an N+1 on the hot path.

**Not-shared returns 404, never 403.** A 403 confirms the data exists and is being
withheld, which leaks the existence of something the owner chose not to share.
Not-shared and not-there must be indistinguishable.

**Revocation is immediate by construction** — every cross-user read resolves at
request time; there is no server-side grant cache. The residual risk is what is
already on a viewer's device: on a 404 from a previously-readable path the client
drops its cached copy. This is the honest answer to the issue's question about
data already seen — serving can stop; unseeing cannot.

### Refactors this requires

- `compare.ProgressForMembers` loses its `ShareProgress bool` input and takes
  resolved grants
- `groups.Progress` follows
- `groups.repository` stops selecting `u.share_progress`

## Surfaces

**Circles settings screen.** Create a circle, name it, add friends, toggle
categories. The screen does not grow with the friend count — the reason circles
were chosen.

**`body` requires confirmation; `progress` is a plain toggle.** Granting `body`
shows the people it will expose, by name, as an actual list — not "3 members" —
and requires a confirm. Sharing a streak and sharing body-fat percentage are
different acts; a UI that treats them identically is quietly wrong.

**Audit, per category.** "Who can see my body metrics?" is one list of names,
because grants come only from circles.

**Exit from both ends.** The owner removes a member; a member may also leave a
circle. Being shared with carries an implicit relationship and possibly
notifications, and is not always welcome.

## Account deletion and export (#24)

- Deleting your account cascades your circles and grants; your data goes with it,
  so nothing remains to be seen. This answers the issue's question about metrics a
  spouse has been reading.
- Deleting as a viewer cascades your memberships.
- **Export returns your own data only.** Another person's metrics that you could
  read are not yours to export; an export that included them would turn a read
  grant into a permanent copy. This is a constraint #326 imposes on #24's scope.

## Out of scope

No per-person overrides. No reciprocal grants. No categories without a read path.
No grant expiry or lifecycle. No notification when someone views your data.

## Testing

- `access.Resolve` / `ResolveMany`: granted, not-granted, self-read, non-friend
  member, revoked-mid-session, unknown category
- The invariant worth pinning: **a viewer with no circle membership receives 404
  and an empty body from every cross-user path**, asserted per path rather than
  per resolver, so a new endpoint that forgets the gateway fails a test that
  already exists
- Migration: `share_progress = true` yields a circle whose members are exactly the
  user's friends at migration time; `false` yields no rows
- Challenges standings remain computable for a participant with no grants — the
  behaviour that must not regress when the two mechanisms are read side by side
