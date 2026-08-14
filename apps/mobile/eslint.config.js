// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const globals = require("globals");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // eslint-config-expo turns on @typescript-eslint/array-type with its
    // default preference of `T[]`. This codebase consistently writes
    // `Array<T>` / `ReadonlyArray<T>`, and the rule's autofix makes the
    // nested cases materially harder to read — foodVisual.ts's
    // `ReadonlyArray<readonly [RegExp, string]>` becomes
    // `readonly (readonly [RegExp, string])[]`. It is a pure style rule with
    // no correctness content, so it is off rather than churning the codebase
    // to satisfy a default nobody here chose.
    rules: {
      "@typescript-eslint/array-type": "off",
    },
  },
  {
    // Jest's setup files run in the Jest environment, not the app's. They are
    // NOT matched by eslint-config-expo's test-file patterns (which cover
    // __tests__/ and *.test.*), so without this every `jest`, `beforeEach` and
    // `Buffer` reference in them was a no-undef error — 74 of them, which was
    // half of the whole repo's error count and none of it a real defect.
    files: ["jest.setup.js", "jest.afterEnv.js", "jest.globalSetup.js"],
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.node,
      },
    },
  },
]);
