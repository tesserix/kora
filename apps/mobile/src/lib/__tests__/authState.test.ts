// resolveAuthState is the gate the reminder scheduler and the push deep-link
// responder both consult (#171). Each test loads a fresh copy of the module
// against a fresh session mock, because isAuthConfigured is read at import time.

type SessionMock = typeof import("@/test/sessionMock").sessionMock;

let resolveAuthState: typeof import("../authState").resolveAuthState;
let session: SessionMock;

function load(configure: (s: SessionMock) => void): void {
  jest.isolateModules(() => {
    session = require("@/auth/session");
    configure(session);
    resolveAuthState = require("../authState").resolveAuthState;
  });
}

test("no sign-in config reports 'unconfigured', never 'signed-out'", async () => {
  load((s) => {
    s.isAuthConfigured = false;
  });
  await expect(resolveAuthState()).resolves.toBe("unconfigured");
});

test("a signed-in user reports 'signed-in'", async () => {
  load((s) => s.setUser("u1"));
  await expect(resolveAuthState()).resolves.toBe("signed-in");
});

test("no current user reports 'signed-out'", async () => {
  load((s) => s.setUser(null));
  await expect(resolveAuthState()).resolves.toBe("signed-out");
});

// The reason this function is async at all. The session is restored from
// SecureStore, so currentUserId() is null for the first moments of a cold
// start even for a signed-in user. Reading it without awaiting readiness would
// classify every launch as signed-out — and the reminder gate would then wipe a
// real user's schedule on launch.
test("waits for persisted-session restoration before reading the user", async () => {
  let restore: () => void = () => {};
  const restored = new Promise<void>((r) => {
    restore = r;
  });
  load((s) => {
    s.setUser(null);
    s.authReady.mockImplementation(() => restored);
  });

  const pending = resolveAuthState();
  // The session restores a tick later, exactly as the SecureStore read does.
  session.setUser("u1");
  restore();

  await expect(pending).resolves.toBe("signed-in");
});

// A rejected readiness promise must not be reported as "signed-out": that would
// disarm a signed-in user's reminders because of an unrelated failure.
test("a rejected readiness promise still reports the user the session has", async () => {
  load((s) => {
    s.setUser("u1");
    s.authReady.mockRejectedValue(new Error("readiness unavailable"));
  });
  await expect(resolveAuthState()).resolves.toBe("signed-in");
});
