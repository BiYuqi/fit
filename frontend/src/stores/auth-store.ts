import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { create } from 'zustand';

import { apiFetch } from '@/lib/api';
import { clearApiCache, clearCache } from '@/lib/db';
import { useChatStore } from '@/stores/chat-store';

const TOKEN_KEY = 'auth_token';

const storage = {
  get: (key: string) =>
    Platform.OS === 'web'
      ? Promise.resolve(localStorage.getItem(key))
      : SecureStore.getItemAsync(key),
  set: (key: string, value: string) =>
    Platform.OS === 'web'
      ? Promise.resolve(localStorage.setItem(key, value))
      : SecureStore.setItemAsync(key, value),
  delete: (key: string) =>
    Platform.OS === 'web'
      ? Promise.resolve(localStorage.removeItem(key))
      : SecureStore.deleteItemAsync(key),
};

type AuthState = {
  token: string | null;
  isLoading: boolean;
  init: () => Promise<void>;
  login: (account: string, password: string) => Promise<void>;
  register: (account: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  isLoading: true,

  init: async () => {
    const token = await storage.get(TOKEN_KEY);
    set({ token, isLoading: false });
  },

  login: async (account, password) => {
    const { token } = await apiFetch<{ token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ account, password }),
    });
    await storage.set(TOKEN_KEY, token);
    set({ token });
  },

  register: async (account, password) => {
    const { token } = await apiFetch<{ token: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ account, password }),
    });
    await storage.set(TOKEN_KEY, token);
    set({ token });
  },

  logout: async () => {
    await storage.delete(TOKEN_KEY);
    // 换号无泄漏：API 缓存 + 聊天 SQLite 表 + chat-store 内存态一起清
    await Promise.all([clearApiCache(), clearCache()]);
    useChatStore.getState().reset();
    set({ token: null });
  },
}));
