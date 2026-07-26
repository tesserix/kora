import { targetFor } from "../notificationTarget";

test("friend types route to /friends", () => {
  expect(targetFor({ type: "friend_request" })).toBe("/friends");
  expect(targetFor({ type: "friend_accept" })).toBe("/friends");
});

test("group invite routes to the group when entity_id is present", () => {
  expect(targetFor({ type: "group_invite", entity_id: "g1" })).toBe("/group/g1");
  expect(targetFor({ type: "group_invite" })).toBeNull();
});

test("challenge types route to the challenge when entity_id is present", () => {
  expect(targetFor({ type: "challenge_started", entity_id: "c1" })).toBe("/challenge/c1");
  expect(targetFor({ type: "challenge_passed", entity_id: "c2" })).toBe("/challenge/c2");
  expect(targetFor({ type: "challenge_ended" })).toBeNull();
});
