import React from "react";
import { AppState, type AppStateStatus } from "react-native";
import { QueryClient, QueryClientProvider, focusManager, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { installAppFocus } from "../appFocus";

// AppState.addEventListener is spied rather than driven through the native
// event emitter, mirroring src/offline/__tests__/drainTriggers.test.ts: the
// handler is the whole contract, and no native AppState exists under Jest.
function installWithCapturedHandler(): {
  readonly emit: (state: AppStateStatus) => void;
  readonly uninstall: () => void;
  readonly remove: jest.Mock;
} {
  const remove = jest.fn();
  const spy = jest
    .spyOn(AppState, "addEventListener")
    .mockReturnValue({ remove } as ReturnType<typeof AppState.addEventListener>);
  const uninstall = installAppFocus();
  const handler = spy.mock.calls.at(-1)![1] as (state: AppStateStatus) => void;
  spy.mockRestore();
  return { emit: handler, uninstall, remove };
}

afterEach(() => {
  // focusManager is module-global state shared by every suite in this worker.
  // Leaving it pinned to `false` would silently stop refetching everywhere else.
  focusManager.setFocused(undefined);
  jest.useRealTimers();
});

test("installAppFocus mirrors AppState into react-query's focusManager", () => {
  const { emit, uninstall } = installWithCapturedHandler();

  emit("background");
  expect(focusManager.isFocused()).toBe(false);

  emit("active");
  expect(focusManager.isFocused()).toBe(true);

  // "inactive" is the transient state iOS passes through during the app
  // switcher and incoming calls. It is not focused, and treating it as such
  // is what lets a request start moments before the OS suspends the process.
  emit("inactive");
  expect(focusManager.isFocused()).toBe(false);

  uninstall();
});

test("uninstall detaches the AppState listener", () => {
  const { remove, uninstall } = installWithCapturedHandler();
  uninstall();
  expect(remove).toHaveBeenCalled();
});

// The bug: useUnreadCount polls every 60s with no notion of focus, so the
// interval keeps firing after iOS has suspended the process. The request is
// issued, the app is frozen mid-flight, and it lands in Sentry as a
// TimeoutError ~20 minutes later when a wake event thaws it.
test("a polling query stops firing while the app is backgrounded", async () => {
  jest.useFakeTimers();
  const { emit, uninstall } = installWithCapturedHandler();
  const queryFn = jest.fn().mockResolvedValue({ count: 1 });

  const { unmount } = await renderPolling(queryFn);
  await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

  emit("background");
  await act(async () => {
    jest.advanceTimersByTime(10 * 60_000);
  });

  expect(queryFn).toHaveBeenCalledTimes(1);

  unmount();
  uninstall();
});

// The regression this fix could easily introduce: pausing on blur is only safe
// if the data is refreshed the moment the user is looking again. A badge that
// waits out a full 60s interval after every foreground is stale data — a worse
// and far less visible bug than the timeout it replaced.
test("returning to the foreground refetches promptly, without waiting out the interval", async () => {
  jest.useFakeTimers();
  const { emit, uninstall } = installWithCapturedHandler();
  const queryFn = jest.fn().mockResolvedValue({ count: 1 });

  const { unmount } = await renderPolling(queryFn);
  await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

  emit("background");
  await act(async () => {
    jest.advanceTimersByTime(10 * 60_000);
  });
  expect(queryFn).toHaveBeenCalledTimes(1);

  emit("active");
  // No timer advance beyond a tick: the refetch must be driven by the focus
  // change itself, not by the poll interval resuming.
  await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));

  // And the interval is live again afterwards.
  await act(async () => {
    jest.advanceTimersByTime(60_000);
  });
  await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(3));

  unmount();
  uninstall();
});

// Mirrors useUnreadCount's shape (60s poll) on top of the app's real query
// defaults (src/lib/queryClient.ts), so staleTime participates the same way.
function renderPolling(queryFn: jest.Mock) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const wrapper = ({ children }: { readonly children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () =>
      useQuery({
        queryKey: ["notifications", "unread"],
        queryFn: queryFn as () => Promise<{ count: number }>,
        refetchInterval: 60_000,
      }),
    { wrapper },
  );
}
