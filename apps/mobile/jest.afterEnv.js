// setupFilesAfterEnv, not setupFiles: this file needs `beforeEach`, and the
// test framework is not installed yet when jest.setup.js (setupFiles) runs.
// Everything that only registers module mocks stays there.

// The expo-file-system mock's in-memory filesystem is MODULE state, so without
// this it persists across every test in a file. `mediaExists(...)` assertions
// then depend on execution order — a file another test wrote, or failed to
// delete, is still there, so a test can pass because of its neighbours rather
// than because of the code it names (app/__tests__/capture-failed.test.tsx had
// exactly two such assertions).
//
// Registered globally so no future test file can forget it. This hook is
// declared before any suite's own beforeEach and therefore runs first, so a
// suite that seeds files in its own beforeEach still gets a clean filesystem
// underneath it. __reset also clears the seeded-contents and fail-delete
// registries.
beforeEach(() => {
  require("expo-file-system").File.__reset();
});
