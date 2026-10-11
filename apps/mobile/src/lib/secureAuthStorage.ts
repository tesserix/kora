import AsyncStorage from "@react-native-async-storage/async-storage";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

async function vaultKey(key: string): Promise<string> {
  return `firebase.${await digestStringAsync(CryptoDigestAlgorithm.SHA256, key)}`;
}

export const secureAuthStorage = {
  async getItem(key: string): Promise<string | null> {
    const storageKey = await vaultKey(key);
    const stored = await SecureStore.getItemAsync(storageKey, options);
    if (stored !== null) {
      await AsyncStorage.removeItem(key);
      return stored;
    }
    const legacy = await AsyncStorage.getItem(key);
    if (legacy !== null) {
      // Remove the old session only after Keychain/Keystore accepts it.
      await SecureStore.setItemAsync(storageKey, legacy, options);
      await AsyncStorage.removeItem(key);
    }
    return legacy;
  },
  async setItem(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(await vaultKey(key), value, options);
    await AsyncStorage.removeItem(key);
  },
  async removeItem(key: string): Promise<void> {
    // Delete legacy storage first so a failed vault deletion cannot resurrect it.
    await AsyncStorage.removeItem(key);
    await SecureStore.deleteItemAsync(await vaultKey(key), options);
  },
};
