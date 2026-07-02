import { jest } from '@jest/globals';
import type { ContextCard } from '@/types/chat';

// ─── Mock state factories ───────────────────────────────────────────────
// Each test file calls these to build clean mock state per-test.
// This keeps mock logic in one place — test files only declare what they override.

export interface AuthStoreState {
  token: string | null;
  isLoading: boolean;
  error: string | null;
  login: ReturnType<typeof jest.fn>;
  logout: ReturnType<typeof jest.fn>;
  checkAuth: ReturnType<typeof jest.fn>;
}

export function createMockAuthStore(overrides: Partial<AuthStoreState> = {}): AuthStoreState {
  return {
    token: 'test-token',
    isLoading: false,
    error: null,
    login: jest.fn(),
    logout: jest.fn(),
    checkAuth: jest.fn(),
    ...overrides,
  };
}

export interface ChatStoreState {
  messages: unknown[];
  summaryCard: ContextCard | null;
  loading: boolean;
  resolvedPendings: Record<string, boolean>;
  undoneCards: Record<string, boolean>;
  undo: ReturnType<typeof jest.fn>;
  send: ReturnType<typeof jest.fn>;
  resolve: ReturnType<typeof jest.fn>;
  loadAllMessages: ReturnType<typeof jest.fn>;
}

export function createMockChatStore(overrides: Partial<ChatStoreState> = {}): ChatStoreState {
  return {
    messages: [],
    summaryCard: null,
    loading: false,
    resolvedPendings: {},
    undoneCards: {},
    undo: jest.fn(),
    send: jest.fn(),
    resolve: jest.fn(),
    loadAllMessages: jest.fn(),
    ...overrides,
  };
}
