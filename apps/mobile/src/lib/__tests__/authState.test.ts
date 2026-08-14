// resolveAuthState is the gate the reminder scheduler and the push deep-link
// responder both consult (#171). Each test loads a fresh copy of the module
// against a different fake `auth`, because the binding is read at import time.

let resolveAuthState: typeof import("../authState").resolveAuthState;

function load(firebase: unknown): void {
  jest.resetModules();
  jest.doMock("../firebase", () => firebase);
  jest.isolateModules(() => {
    resolveAuthState = require("../authState").resolveAuthState;
  });
}

test("no Firebase config reports 'unconfigured', never 'signed-out'", async () => {
  load({ auth: null, isFirebaseConfigured: false });
  await expect(resolveAuthState()).resolves.toBe("unconfigured");
});

test("a signed-in user reports 'signed-in'", async () => {
  load({
    isFirebaseConfigured: true,
    auth: { authStateReady: jest.fn(async () => {}), currentUser: { uid: "u1" } },
  });
  await expect(resolveAuthState()).resolves.toBe("signed-in");
});

test("no current user reports 'signed-out'", async () => {
  load({
    isFirebaseConfigured: true,
    auth: { authStateReady: jest.fn(async () => {}), currentUser: null },
  });
  await expect(resolveAuthState()).resolves.toBe("signed-out");
});

// The reason this function is async at all. Auth persistence is
// AsyncStorage-backed, so currentUser is null for the first moments of a cold
// start even for a signed-in user. Reading it without awaiting readiness would
// classify every launch as signed-out — and the reminder gate would then wipe a
// real user's schedule on launch.
test("waits for persisted-session restoration before reading currentUser", async () => {
  let restore: () => void = () => {};
  const restored = new Promise<void>((r) => {
    restore = r;
  });
  const fakeAuth: { authStateReady: () => Promise<void>; currentUser: { uid: string } | null } = {
    authStateReady: () => restored,
    currentUser: null,
  };
  load({ isFirebaseConfigured: true, auth: fakeAuth });

  const pending = resolveAuthState();
  // The session restores a tick later, exactly as AsyncStorage persistence does.
  fakeAuth.currentUser = { uid: "u1" };
  restore();

  await expect(pending).resolves.toBe("signed-in");
});

// A rejected readiness promise must not be reported as "signed-out": that would
// disarm a signed-in user's reminders because of an unrelated failure.
test("a rejected readiness promise still reports the user Firebase has", async () => {
  load({
    isFirebaseConfigured: true,
    auth: {
      authStateReady: jest.fn(async () => {
        throw new Error("readiness unavailable");
      }),
      currentUser: { uid: "u1" },
    },
  });
  await expect(resolveAuthState()).resolves.toBe("signed-in");
});
