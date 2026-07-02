import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { create } from 'zustand';

export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_KEY = 'theme_preference';

const storage = {
  get: (key: string): Promise<string | null> =>
    Platform.OS === 'web'
      ? Promise.resolve(localStorage.getItem(key))
      : SecureStore.getItemAsync(key),
  set: (key: string, value: string): Promise<void> =>
    Platform.OS === 'web'
      ? Promise.resolve(undefined).then(() => { localStorage.setItem(key, value); })
      : SecureStore.setItemAsync(key, value),
};

type ThemeState = {
  preference: ThemePreference;
  hydrated: boolean;
  init: () => Promise<void>;
  setPreference: (p: ThemePreference) => Promise<void>;
};

export const useThemeStore = create<ThemeState>((set) => ({
  preference: 'system',
  hydrated: false,

  init: async () => {
    const stored = await storage.get(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      set({ preference: stored, hydrated: true });
    } else {
      set({ hydrated: true });
    }
  },

  setPreference: async (p) => {
    await storage.set(THEME_KEY, p);
    set({ preference: p });
  },
}));
