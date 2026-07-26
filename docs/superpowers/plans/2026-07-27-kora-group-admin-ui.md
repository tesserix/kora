# Kora — Group admin mobile UI (rename + friend-invite) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a group owner rename their group and directly invite a friend from the group detail screen, using the already-built (and tested) backend endpoints.

**Architecture:** Two React Query mutation hooks over the existing `PATCH /v1/groups/:id` and `POST /v1/groups/:id/invite` endpoints, plus two owner-only, conditionally-mounted bottom sheets (`RenameGroupSheet`, `InviteFriendSheet`) wired into `app/group/[id].tsx`. Mobile-only; no backend changes.

**Tech Stack:** Expo SDK 57 / React Native, React Query v5, TypeScript, Jest + `@testing-library/react-native` v14.

## Global Constraints

- Mobile-only. No backend changes. Work from `/Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile`.
- Verify each task: `npx tsc --noEmit` clean AND `npm test -- --ci` all green. Run tests FOREGROUND (never background — they stall).
- No `any`, no `console.log`, no `oklch`. Theme tokens only (via `useTheme()`); explicit types on exported functions/props (`interface` for props).
- RNTL v14: `render()` and `fireEvent` are async — `await` them.
- `jest.mock(...)` factories may reference only variables prefixed with `mock`.
- `Button` variants are `primary | secondary | ghost`; it renders its `title` as pressable text (press via `getByText(title)`).
- Sheets are mounted CONDITIONALLY (`{open ? <Sheet .../> : null}`) — mirrors the existing `CreateChallengeSheet` mount so existing `group/[id].tsx` tests keep their mocks valid.
- Query keys (existing): group detail `["group", id]`, group leaderboard `["group-progress", id]`, groups list `["groups"]`.
- Conventional single-line commits, no signature.

---

## File Structure

**Create**
- `apps/mobile/src/components/social/RenameGroupSheet.tsx`
- `apps/mobile/src/components/social/InviteFriendSheet.tsx`
- `apps/mobile/src/components/social/__tests__/RenameGroupSheet.test.tsx`
- `apps/mobile/src/components/social/__tests__/InviteFriendSheet.test.tsx`

**Modify**
- `apps/mobile/src/api/hooks.ts` — add `useRenameGroup`, `useInviteToGroup`.
- `apps/mobile/src/api/__tests__/hooks.test.tsx` — add two hook tests.
- `apps/mobile/app/group/[id].tsx` — owner actions + conditional sheet mounts.

---

## Task 1: Rename + invite mutation hooks

**Files:**
- Modify: `apps/mobile/src/api/hooks.ts`
- Modify: `apps/mobile/src/api/__tests__/hooks.test.tsx`

**Interfaces:**
- Produces:
  - `useRenameGroup()` → mutation taking `{ groupId: string; name: string }` (`PATCH /v1/groups/:id` `{name}`)
  - `useInviteToGroup()` → mutation taking `{ groupId: string; userId: string }` (`POST /v1/groups/:id/invite` `{user_id}`)

- [ ] **Step 1: Write the failing hook tests**

Append to `apps/mobile/src/api/__tests__/hooks.test.tsx` (add `useRenameGroup, useInviteToGroup` to the existing import from `../hooks`):

```tsx
test("useRenameGroup PATCHes /v1/groups/:id with the name", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ renamed: true });
  const { result } = await renderHook(() => useRenameGroup(), { wrapper });
  await result.current.mutateAsync({ groupId: "g1", name: "New Crew" });
  expect(apiFetch).toHaveBeenCalledWith("/v1/groups/g1", {
    method: "PATCH",
    body: JSON.stringify({ name: "New Crew" }),
  });
});

test("useInviteToGroup POSTs /v1/groups/:id/invite with user_id", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ invited: true });
  const { result } = await renderHook(() => useInviteToGroup(), { wrapper });
  await result.current.mutateAsync({ groupId: "g1", userId: "f1" });
  expect(apiFetch).toHaveBeenCalledWith("/v1/groups/g1/invite", {
    method: "POST",
    body: JSON.stringify({ user_id: "f1" }),
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --ci src/api/__tests__/hooks.test.tsx`
Expected: FAIL — `useRenameGroup`/`useInviteToGroup` are not exported.

- [ ] **Step 3: Implement the hooks**

In `apps/mobile/src/api/hooks.ts`, add after `useDeleteGroup` (around line 353):

```ts
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
      qc.invalidateQueries({ queryKey: ["group", groupId] });
      qc.invalidateQueries({ queryKey: ["group-progress", groupId] });
    },
  });
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- --ci src/api/__tests__/hooks.test.tsx`
Expected: PASS (both new tests + existing).

- [ ] **Step 5: tsc + commit**

Run: `npx tsc --noEmit`  (expected: clean)
```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add apps/mobile/src/api/hooks.ts apps/mobile/src/api/__tests__/hooks.test.tsx
git commit -m "feat(groups): useRenameGroup + useInviteToGroup hooks"
```

---

## Task 2: RenameGroupSheet + owner action

**Files:**
- Create: `apps/mobile/src/components/social/RenameGroupSheet.tsx`
- Create: `apps/mobile/src/components/social/__tests__/RenameGroupSheet.test.tsx`
- Modify: `apps/mobile/app/group/[id].tsx`

**Interfaces:**
- Consumes: `useRenameGroup` (Task 1), `Sheet`, `Button`, `AppText`, `Overline`, `useTheme`.
- Produces: `RenameGroupSheet({ visible, groupId, currentName, onClose })`.

- [ ] **Step 1: Write the failing sheet test**

Create `apps/mobile/src/components/social/__tests__/RenameGroupSheet.test.tsx`:

```tsx
import { render, fireEvent } from "@testing-library/react-native";
import { RenameGroupSheet } from "../RenameGroupSheet";

const mockRename = jest.fn();
jest.mock("@/api/hooks", () => ({
  useRenameGroup: () => ({ mutate: mockRename, isPending: false }),
}));

beforeEach(() => mockRename.mockReset());

test("seeds the input with the current name and saves the trimmed value", async () => {
  const onClose = jest.fn();
  const { getByLabelText, getByText } = await render(
    <RenameGroupSheet visible groupId="g1" currentName="Old Crew" onClose={onClose} />,
  );
  const input = getByLabelText("Group name");
  expect(input.props.value).toBe("Old Crew");
  await fireEvent.changeText(input, "  New Crew  ");
  await fireEvent.press(getByText("Save"));
  expect(mockRename).toHaveBeenCalledWith({ groupId: "g1", name: "New Crew" }, expect.anything());
});

test("blank name shows an error and does not mutate", async () => {
  const { getByLabelText, getByText } = await render(
    <RenameGroupSheet visible groupId="g1" currentName="" onClose={jest.fn()} />,
  );
  await fireEvent.changeText(getByLabelText("Group name"), "   ");
  await fireEvent.press(getByText("Save"));
  expect(mockRename).not.toHaveBeenCalled();
  expect(getByText("Name your group.")).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --ci src/components/social/__tests__/RenameGroupSheet.test.tsx`
Expected: FAIL — cannot resolve `../RenameGroupSheet`.

- [ ] **Step 3: Implement RenameGroupSheet**

Create `apps/mobile/src/components/social/RenameGroupSheet.tsx`:

```tsx
import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useRenameGroup } from "@/api/hooks";
import { useTheme } from "@/theme";

interface Props {
  visible: boolean;
  groupId: string;
  currentName: string;
  onClose: () => void;
}

export function RenameGroupSheet({ visible, groupId, currentName, onClose }: Props) {
  const { colors, radius } = useTheme();
  const [value, setValue] = useState(currentName);
  const [err, setErr] = useState<string | null>(null);
  const rename = useRenameGroup();

  // Seed (and re-seed) the input from the current name whenever the sheet opens.
  useEffect(() => {
    if (visible) {
      setValue(currentName);
      setErr(null);
    }
  }, [visible, currentName]);

  const onSubmit = () => {
    const v = value.trim();
    if (!v) {
      setErr("Name your group.");
      return;
    }
    setErr(null);
    rename.mutate(
      { groupId, name: v },
      { onSuccess: () => onClose(), onError: () => setErr("Couldn't rename. Try again.") },
    );
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>Rename group</Overline>
        <TextInput
          value={value}
          onChangeText={setValue}
          autoCapitalize="words"
          autoCorrect={false}
          placeholder="Group name"
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel="Group name"
          style={{ marginTop: 12, fontSize: 16, color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 12 }}
        />
        {err ? <AppText style={{ color: colors.destructive, marginTop: 10 }}>{err}</AppText> : null}
        <Button title="Save" onPress={onSubmit} disabled={rename.isPending} style={{ marginTop: 14 }} />
      </View>
    </Sheet>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --ci src/components/social/__tests__/RenameGroupSheet.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the owner "Rename group" action into group/[id].tsx**

In `apps/mobile/app/group/[id].tsx`:

(a) Add the import near the other component imports (after the `CreateChallengeSheet` import):

```tsx
import { RenameGroupSheet } from "@/components/social/RenameGroupSheet";
```

(b) Add a state flag next to the existing `const [sheet, setSheet] = useState(false);`:

```tsx
  const [renameOpen, setRenameOpen] = useState(false);
```

(c) Add an owner-only "Rename group" ghost button immediately after the `Share invite code` button (line 58):

```tsx
          <Button title="Share invite code" onPress={shareCode} variant="secondary" />
          {isOwner ? <Button title="Rename group" variant="ghost" onPress={() => setRenameOpen(true)} /> : null}
```

(d) Add the conditional mount next to the existing `CreateChallengeSheet` mount at the bottom (inside the fragment, after the `{sheet ? ... : null}` line):

```tsx
      {renameOpen && d ? <RenameGroupSheet visible groupId={id} currentName={d.name} onClose={() => setRenameOpen(false)} /> : null}
```

- [ ] **Step 6: Verify tsc + full suite**

Run: `npx tsc --noEmit && npm test -- --ci`
Expected: tsc clean; all suites PASS (the existing `group/[id].tsx` test still green — the new button is owner-gated and the sheet is conditionally unmounted).

- [ ] **Step 7: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add apps/mobile/src/components/social/RenameGroupSheet.tsx apps/mobile/src/components/social/__tests__/RenameGroupSheet.test.tsx "apps/mobile/app/group/[id].tsx"
git commit -m "feat(groups): RenameGroupSheet + owner rename action"
```

---

## Task 3: InviteFriendSheet + owner action

**Files:**
- Create: `apps/mobile/src/components/social/InviteFriendSheet.tsx`
- Create: `apps/mobile/src/components/social/__tests__/InviteFriendSheet.test.tsx`
- Modify: `apps/mobile/app/group/[id].tsx`

**Interfaces:**
- Consumes: `useInviteToGroup` (Task 1), `useFriends` (existing → `Friend[]` of `{id, display_name}`), `Sheet`, `AppText`, `Overline`, `useTheme`.
- Produces: `InviteFriendSheet({ visible, groupId, memberIds, onClose })`.

- [ ] **Step 1: Write the failing sheet test**

Create `apps/mobile/src/components/social/__tests__/InviteFriendSheet.test.tsx`:

```tsx
import { render, fireEvent } from "@testing-library/react-native";
import { InviteFriendSheet } from "../InviteFriendSheet";

const mockInvite = jest.fn();
const mockUseFriends = jest.fn();
jest.mock("@/api/hooks", () => ({
  useInviteToGroup: () => ({ mutate: mockInvite, isPending: false }),
  useFriends: () => mockUseFriends(),
}));

beforeEach(() => {
  mockInvite.mockReset();
  mockUseFriends.mockReturnValue({
    data: [
      { id: "f1", display_name: "Alice" },
      { id: "f2", display_name: "Bob" },
    ],
  });
});

test("lists friends who aren't members and invites on tap", async () => {
  const onClose = jest.fn();
  const { getByText, queryByText } = await render(
    <InviteFriendSheet visible groupId="g1" memberIds={["f2"]} onClose={onClose} />,
  );
  expect(getByText("Alice")).toBeTruthy();
  expect(queryByText("Bob")).toBeNull(); // f2 is already a member
  await fireEvent.press(getByText("Alice"));
  expect(mockInvite).toHaveBeenCalledWith({ groupId: "g1", userId: "f1" }, expect.anything());
});

test("shows an empty state when no friends are eligible", async () => {
  mockUseFriends.mockReturnValue({ data: [{ id: "f1", display_name: "Alice" }] });
  const { getByText, queryByText } = await render(
    <InviteFriendSheet visible groupId="g1" memberIds={["f1"]} onClose={jest.fn()} />,
  );
  expect(queryByText("Alice")).toBeNull();
  expect(getByText("No friends to invite. Everyone's already in, or add friends first.")).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --ci src/components/social/__tests__/InviteFriendSheet.test.tsx`
Expected: FAIL — cannot resolve `../InviteFriendSheet`.

- [ ] **Step 3: Implement InviteFriendSheet**

Create `apps/mobile/src/components/social/InviteFriendSheet.tsx`:

```tsx
import { useState } from "react";
import { Pressable, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useFriends, useInviteToGroup } from "@/api/hooks";
import { useTheme } from "@/theme";

interface Props {
  visible: boolean;
  groupId: string;
  memberIds: string[];
  onClose: () => void;
}

export function InviteFriendSheet({ visible, groupId, memberIds, onClose }: Props) {
  const { colors, radius } = useTheme();
  const [err, setErr] = useState<string | null>(null);
  const friends = useFriends();
  const invite = useInviteToGroup();

  const eligible = (friends.data ?? []).filter((f) => !memberIds.includes(f.id));

  const onInvite = (userId: string) => {
    setErr(null);
    invite.mutate(
      { groupId, userId },
      { onSuccess: () => onClose(), onError: () => setErr("Couldn't invite. Try again.") },
    );
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30, gap: 8 }}>
        <Overline>Invite a friend</Overline>
        {eligible.length === 0 ? (
          <AppText muted style={{ fontSize: 13, paddingVertical: 8 }}>
            No friends to invite. Everyone's already in, or add friends first.
          </AppText>
        ) : (
          eligible.map((f) => (
            <Pressable
              key={f.id}
              accessibilityRole="button"
              accessibilityLabel={`Invite ${f.display_name}`}
              disabled={invite.isPending}
              onPress={() => onInvite(f.id)}
              style={{ flexDirection: "row", alignItems: "center", padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}
            >
              <AppText style={{ flex: 1, fontSize: 15, fontWeight: "600" }}>{f.display_name}</AppText>
              <AppText style={{ color: colors.primary, fontSize: 13, fontWeight: "600" }}>Invite</AppText>
            </Pressable>
          ))
        )}
        {err ? <AppText style={{ color: colors.destructive, marginTop: 6 }}>{err}</AppText> : null}
      </View>
    </Sheet>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --ci src/components/social/__tests__/InviteFriendSheet.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the owner "Invite a friend" action into group/[id].tsx**

In `apps/mobile/app/group/[id].tsx`:

(a) Add the import after the `RenameGroupSheet` import:

```tsx
import { InviteFriendSheet } from "@/components/social/InviteFriendSheet";
```

(b) Add a state flag next to `renameOpen`:

```tsx
  const [inviteOpen, setInviteOpen] = useState(false);
```

(c) Add an owner-only "Invite a friend" secondary button right after the "Rename group" button from Task 2:

```tsx
          {isOwner ? <Button title="Rename group" variant="ghost" onPress={() => setRenameOpen(true)} /> : null}
          {isOwner ? <Button title="Invite a friend" variant="secondary" onPress={() => setInviteOpen(true)} /> : null}
```

(d) Add the conditional mount next to the RenameGroupSheet mount:

```tsx
      {inviteOpen ? <InviteFriendSheet visible groupId={id} memberIds={(d?.members ?? []).map((m) => m.id)} onClose={() => setInviteOpen(false)} /> : null}
```

- [ ] **Step 6: Verify tsc + full suite**

Run: `npx tsc --noEmit && npm test -- --ci`
Expected: tsc clean; ALL suites PASS (existing `group/[id].tsx` test still green — new action owner-gated, sheet conditionally unmounted so no new mock needed there).

- [ ] **Step 7: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add apps/mobile/src/components/social/InviteFriendSheet.tsx apps/mobile/src/components/social/__tests__/InviteFriendSheet.test.tsx "apps/mobile/app/group/[id].tsx"
git commit -m "feat(groups): InviteFriendSheet + owner invite action"
```

---

## Final verification (after all tasks, before whole-branch review)

- [ ] `cd apps/mobile && npx tsc --noEmit && npm test -- --ci` → all green.
- [ ] Confirm: owner sees Rename + Invite actions; non-owner does not (isOwner gate). Both sheets mount only when opened. Existing group-detail test unaffected.
