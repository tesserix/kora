import type { Href } from "expo-router";
import type { NotificationType } from "@/api/types";

// targetFor maps a notification to its in-app deep-link target, shared by the
// inbox screen and the OS-push tap responder.
export function targetFor(n: { type: NotificationType; entity_id?: string }): Href | null {
  switch (n.type) {
    case "friend_request":
    case "friend_accept":
      return "/friends" as Href;
    case "group_invite":
      return n.entity_id ? (`/group/${n.entity_id}` as Href) : null;
    case "challenge_created":
    case "challenge_started":
    case "challenge_ended":
    case "challenge_passed":
      return n.entity_id ? (`/challenge/${n.entity_id}` as Href) : null;
    default:
      return null;
  }
}
