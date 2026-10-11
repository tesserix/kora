// Why this lives in its OWN file rather than as a describe block inside
// weightPermission.test.ts: `jest.doMock` only takes effect for a module the
// current file has not already pulled into the registry, and
// weightPermission.test.ts imports both `@kingstinct/react-native-healthkit`
// and `../weightPermission` at the top level to grab the jest.fn() handles.
// With those imports present the doMock below is silently ignored and the
// global jest.setup.js mock answers instead — the test then passes for the
// wrong reason (verified: it resolved `false` rather than throwing). Nothing
// is imported at the top of this file for exactly that reason.
//
// What is under test: `@kingstinct/react-native-healthkit` is a Nitro module
// that throws at IMPORT time on any build where the native side is not
// linked (a dev client built before HealthKit was added). weightPermission.ts
// therefore requires it lazily INSIDE each function, where the throw is
// catchable, instead of at module scope where it would take the whole app
// down before any try/catch exists. A future refactor to a top-level import
// would break that, and these two tests are what catches it.

async function withUnlinkedHealthKit(body: (mod: typeof import("../weightPermission")) => Promise<void>) {
  await jest.isolateModulesAsync(async () => {
    jest.doMock("@kingstinct/react-native-healthkit", () => {
      throw new Error("Nitro module HealthKit not linked");
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../weightPermission") as typeof import("../weightPermission");
    await body(mod);
  });
  jest.dontMock("@kingstinct/react-native-healthkit");
}

test("importing weightPermission does not throw when the native module is missing", async () => {
  await withUnlinkedHealthKit(async (mod) => {
    // Reaching the callback at all is the assertion: the require resolved
    // instead of exploding, which a top-level import could not have done.
    expect(typeof mod.weightPermissionRequested).toBe("function");
    expect(typeof mod.requestWeightPermission).toBe("function");
  });
});

test("weightPermissionRequested throws at call time when the native module is missing", async () => {
  await withUnlinkedHealthKit(async (mod) => {
    await expect(mod.weightPermissionRequested()).rejects.toThrow("not linked");
  });
});

test("requestWeightPermission throws at call time rather than silently doing nothing", async () => {
  await withUnlinkedHealthKit(async (mod) => {
    await expect(mod.requestWeightPermission()).rejects.toThrow("not linked");
  });
});
