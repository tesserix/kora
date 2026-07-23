import AsyncStorage from "@react-native-async-storage/async-storage";
import { initializeApp } from "firebase/app";
import type { Auth } from "firebase/auth";
// Metro resolves `firebase/auth` to the React Native build
// (@firebase/auth/dist/rn/) at runtime, which exports
// `getReactNativePersistence` for durable AsyncStorage-backed auth
// persistence. tsc, however, resolves the non-RN package types
// (index.d.ts), which don't declare that export — see firebase#8674
// (RN persistence typing gap).
// @ts-expect-error - getReactNativePersistence is exported by the RN build at runtime (firebase/auth dist/rn) but missing from the default published types (firebase#8674)
import { getReactNativePersistence, initializeAuth } from "firebase/auth";
import { readFirebaseConfig } from "./firebaseConfig";

const config = readFirebaseConfig();

export const isFirebaseConfigured = config !== null;

export const auth: Auth | null = config
  ? initializeAuth(initializeApp(config), {
      persistence: getReactNativePersistence(AsyncStorage),
    })
  : null;
