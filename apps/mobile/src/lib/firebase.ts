import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

// `@react-native-async-storage/async-storage` must stay installed: the
// React Native build of firebase/auth (resolved by Metro's platform-aware
// module resolution, not by this file) imports it internally and uses it
// automatically for persistence when the package is present. Firebase's
// current published types don't expose `initializeAuth`/
// `getReactNativePersistence` for React Native under TypeScript's package
// export resolution, so we rely on that automatic persistence via `getAuth`.
const app = initializeApp({
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
});

export const auth = getAuth(app);
