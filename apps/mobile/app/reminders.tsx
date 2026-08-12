import { Redirect } from "expo-router";

// Reminders was merged into Settings — this route now just forwards stale
// links (notification taps, bookmarks) to the new destination.
export default function Reminders() {
  return <Redirect href="/settings" />;
}
