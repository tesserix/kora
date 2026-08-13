import { useEffect } from "react";
import { useProfile } from "@/api/hooks";
import { setReportingUser } from "@/observability/reporter";

/**
 * Associates crash reports with the signed-in Kora user.
 *
 * Renders nothing. Lives inside QueryClientProvider because useProfile needs
 * the query client. Uses the Kora UUID (Profile.id), never the Firebase uid
 * and never email or display name — it answers "one user forty times or forty
 * users once?" without putting a human-readable identifier into a third party.
 */
export function ReportingUserBinder(): null {
  const { data } = useProfile();

  useEffect(() => {
    setReportingUser(data?.id ?? null);
  }, [data?.id]);

  return null;
}
