import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import { apiFetch } from '@/lib/api';

const TOKEN_KEY = 'auth_token';

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
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    set({ token, isLoading: false });
  },

  login: async (account, password) => {
    const { token } = await apiFetch<{ token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ account, password }),
    });
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    set({ token });
  },

  register: async (account, password) => {
    const { token } = await apiFetch<{ token: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ account, password }),
    });
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    set({ token });
  },

  logout: async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    set({ token: null });
  },
}));
