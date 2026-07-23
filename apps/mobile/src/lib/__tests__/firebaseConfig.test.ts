import { readFirebaseConfig } from "../firebaseConfig";

const KEYS = [
  "EXPO_PUBLIC_FIREBASE_API_KEY",
  "EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "EXPO_PUBLIC_FIREBASE_PROJECT_ID",
  "EXPO_PUBLIC_FIREBASE_APP_ID",
] as const;

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

test("returns null when apiKey is missing", () => {
  process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN = "x.firebaseapp.com";
  process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = "x";
  process.env.EXPO_PUBLIC_FIREBASE_APP_ID = "1:2:web:3";
  expect(readFirebaseConfig()).toBeNull();
});

test("returns config when all required fields present", () => {
  process.env.EXPO_PUBLIC_FIREBASE_API_KEY = "AIzaKEY";
  process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN = "x.firebaseapp.com";
  process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = "x";
  process.env.EXPO_PUBLIC_FIREBASE_APP_ID = "1:2:web:3";
  expect(readFirebaseConfig()).toEqual({
    apiKey: "AIzaKEY",
    authDomain: "x.firebaseapp.com",
    projectId: "x",
    appId: "1:2:web:3",
  });
});
