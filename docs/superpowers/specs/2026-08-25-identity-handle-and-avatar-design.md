# Kora identity: handles and profile pictures

Status: design, approved in outline. Supersedes #153.

## The problem

Adding a friend on Kora requires reading an opaque friend code aloud, or typing
the exact address someone signed up with. Nobody does that twice. Production is
18 users and **zero friendships**, and #326's whole permission model — circles,
categories, the body confirmation, the audit — is worth nothing until people can
add each other.

#153 proposed solving this with address-book matching. That is now closed, for
two reasons decided here:

- **Kora will not collect phone numbers.** The issue is written about phone
  digest matching; without a phone column that feature cannot exist. This also
  removes an SMS provider, an OTP flow, a brute-forceable digest table, and a
  disclosure obligation.
- **Email-only matching is the weak variant and philosophically wrong here.** It
  is permanently blind to Apple relay addresses (`@privaterelay.appleid.com`),
  which no amount of engineering fixes, and it makes people findable *without a
  deliberate act* — the opposite of the property chosen below.

## What we are building

Two halves of one thing, shipped together: a **handle** you can say out loud, and
a **face** so the person searching can tell they found the right human before
sending a request that may end in sharing body metrics.

## Decisions

### Findability is a deliberate act

Handles are **exact-match only**. No prefix search, no listing, no directory.
You are findable by people you gave your handle to, and nobody else.

This is the load-bearing decision. Kora is a nutrition and weight app: being
findable here reveals that you use a calorie tracker, which is health-adjacent
information many people would not want surfaced to an ex, a colleague, or a
family member. Prefix search would make the entire user base enumerable and
would tell anyone who cares who uses the app.

### The handle is the consent boundary

A handle lookup returns the avatar. Someone holding your handle can therefore
confirm you use Kora, with a photo.

That is intended, and it is why "avatar only after friendship" was rejected: it
would not solve the problem avatars exist to solve, since you would still be
sending a request based on a non-unique display name. If you gave someone your
handle, they may see your face. One boundary, stated once.

### Confusables fold, for uniqueness *and* for lookup

`ada_l` and `ada_1` must never both exist. Two handles differing only by
`l`/`1`/`i` or `0`/`o` are indistinguishable when spoken, and the failure is not
a missed lookup — it is sending a friend request to a stranger and then sharing
body metrics with them.

So the canonical form folds confusables, and the unique index is on the canonical
form. Because at most one handle can exist per confusable class, **lookup folds
too**, unambiguously: whichever exists is the one the speaker meant. A handle
heard correctly always resolves.

### Retired handles never return to the pool

Changing your handle retires the old one permanently. Otherwise anyone who wrote
down `@ada` sends requests to whoever claims it next — impersonation with a
body-metrics payoff. Handle exhaustion is not a real concern at Kora's scale.

A short reserved list (`kora`, `admin`, `support`, `help`, `team`) prevents
impersonating the app itself.

### Both are optional, and prompted at the point of use

Neither blocks onboarding, which is long enough. A handle is requested the first
time you try to share yours. Anyone can look handles up whether or not they have
one. No avatar falls back to the existing initials `Avatar` component.

## Data model

```sql
ALTER TABLE users
  ADD COLUMN handle           TEXT,   -- as the user typed it, for display
  ADD COLUMN handle_canonical TEXT,   -- lowercased, confusables folded
  ADD COLUMN avatar_path      TEXT;   -- object path, not a full URL

CREATE UNIQUE INDEX users_handle_canonical_key
  ON users (handle_canonical) WHERE handle_canonical IS NOT NULL;

CREATE TABLE retired_handles (
  handle_canonical TEXT PRIMARY KEY,
  retired_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`avatar_path` rather than a URL: the bucket and CDN host are deployment
concerns, and storing a full URL bakes today's infrastructure into user rows.
The API composes the URL on read.

`users.friend_code` stays. Existing `mobile://friend/<code>` links must keep
working; the handle simply becomes the human-facing identity.

## Storage

A new bucket, since **Kora currently stores no user images at all** — meal
photos are sent to the vision provider as base64 and never persisted. That is a
privacy posture being given up deliberately here, and it is worth naming.

- **Bucket**: `kora-prod-assets-in`, `asia-south1` — matching the
  `<app>-<scope>-assets` convention of sibling apps and the Cloud SQL region.
- **Path**: `avatars/{user_id}/{version}.jpg`. The version segment makes cache
  invalidation free (a new picture is a new URL) and lets a lifecycle rule reap
  superseded objects.
- **Public-read objects at unguessable paths.** A v4 UUID path is not
  enumerable, and signed URLs would mean re-signing on every render of every
  friend row for no privacy gain — the avatar is already visible to anyone
  holding the handle. Consistent with the consent boundary above.

### Upload path

Client → API (multipart) → normalize → GCS. **Not** a direct-to-GCS signed
upload: the API must do the processing, and a client cannot be trusted to have
done it.

Normalization, in order:

1. Cap the request body (8 MiB, matching `bodyread`'s handler).
2. **Header-only `image.DecodeConfig` check before the real decode.** This is a
   security guard, not an optimization: a crafted PNG can declare enormous
   dimensions in a few header bytes while staying far under the byte cap, and
   `image.Decode` allocates the full pixel buffer for whatever the header
   claims. The reasoning and the constant already exist in
   `internal/bodyread/downscale.go` and should be shared rather than
   re-derived.
3. Resize to 512×512 max.
4. **Re-encode as JPEG.** This is how EXIF is removed — including GPS
   coordinates, which a selfie carries. Re-encoding drops everything that is
   not pixels, which is strictly more robust than trying to strip named
   metadata fields.

**This needs `golang.org/x/image/draw`, a genuine new dependency.**
`bodyread/downscale.go` uses nearest-neighbour deliberately and says why: its
input is rendered UI text on flat backgrounds, where cheap resampling is
adequate. It then states that "if a future caller in this package ever needs
high-quality interpolation (a real photo, not a screenshot), x/image would need
to be added as a new dependency then." Avatars are that caller. Nearest-neighbour
on a face aliases visibly.

### Deletion

Account deletion must remove the object. `user.Service.Delete` already owns an
18-table cascade specifically so there is only one implementation of "erase this
person"; the avatar object joins it there, not in a second place.

## API

```
GET    /v1/users/lookup?handle=<handle>   -> {id, display_name, handle, avatar_url}
PUT    /v1/me/handle                      -> {handle}
DELETE /v1/me/handle
PUT    /v1/me/avatar                      -> {avatar_url}   (multipart)
DELETE /v1/me/avatar
```

- Lookup returns **404 for a miss, and never an email**. Same projection rule as
  `share.MemberView` and `social.FriendView`.
- Lookup is **rate limited per caller**. There is no rate-limiting middleware in
  the API today (`internal/guardrails` is the protective-user policy module, not
  a limiter), so this needs building — a small fixed-window counter keyed on the
  authenticated user is sufficient, and it is the only thing standing between
  exact-match lookup and offline enumeration.
- `PUT /v1/me/handle` returns a distinct, non-leaky error for "taken" vs
  "invalid shape" vs "reserved" vs "retired". Taken is not a privacy leak: a
  handle's existence is discoverable by definition, since lookup exists.

## Surfaces

- **Profile**: your handle and picture, both editable, both removable.
- **Add a friend** (`AddFriendSheet`): handle becomes the primary field; email
  and friend code stay as secondary paths.
- **Lookup result**: avatar, display name, handle, and one action — send request.
  This is the screen the avatar exists for.
- **Social / friends / circles**: existing `Avatar` gains a real image when
  present, initials otherwise. No layout change.

## Explicitly out of scope

- **Moderation.** There is none. At 18 users that is defensible; at public scale
  it is not, because a user-supplied image shown to anyone holding a handle is
  an abuse vector. Shipping to public launch requires a takedown path, and this
  spec does not provide one. Stated plainly rather than left to be discovered.
- **Universal invite links.** `MyCode` returns `mobile://friend/<code>`, a custom
  scheme that does nothing pasted into a message thread for someone without the
  app. An `https://` universal link needs a web domain serving
  `apple-app-site-association`; `kora-api.tesserix.app` is an API host, not a
  website. Separate issue, separate infrastructure question.
- Phone numbers, address-book matching, prefix search, directories.

## Testing

Pure and table-driven where the logic lives:

- canonicalisation: case, length bounds, charset, reserved words
- confusable folding: `ada_l` / `ada_1` / `ada_i` collapse; folding is applied on
  both write and lookup
- uniqueness under folding, and retirement blocking reuse
- lookup: exact match only, miss is 404, projection never carries email
- rate limiting: the limit actually engages

Against a real database:

- handle change retires the old one and frees nothing
- account deletion removes both the row and the object

Image handling:

- a decode-bomb header is rejected **before** allocation
- EXIF, including GPS, is absent from the stored object
- a PNG input becomes a JPEG output
- oversized images are resized; a tiny image is not upscaled

Simulator-only:

- how a real face looks at 30px in a friend row and 72px on a profile
- the picker → crop → upload flow, which no unit test exercises
