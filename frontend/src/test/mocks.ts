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
  undoneCards: Record<string, boolean>;
  jumpTarget: { type: string; id?: string; date?: string } | null;
  undo: ReturnType<typeof jest.fn>;
  resetAlias: ReturnType<typeof jest.fn>;
  send: ReturnType<typeof jest.fn>;
  resolve: ReturnType<typeof jest.fn>;
  loadRecentMessages: ReturnType<typeof jest.fn>;
  loadMoreMessages: ReturnType<typeof jest.fn>;
  jumpToMessage: ReturnType<typeof jest.fn>;
  jumpToDate: ReturnType<typeof jest.fn>;
  clearJumpTarget: ReturnType<typeof jest.fn>;
}

export function createMockChatStore(overrides: Partial<ChatStoreState> = {}): ChatStoreState {
  return {
    messages: [],
    summaryCard: null,
    loading: false,
    undoneCards: {},
    jumpTarget: null,
    undo: jest.fn(),
    resetAlias: jest.fn(),
    send: jest.fn(),
    resolve: jest.fn(),
    loadRecentMessages: jest.fn(),
    loadMoreMessages: jest.fn(),
    jumpToMessage: jest.fn(),
    jumpToDate: jest.fn(),
    clearJumpTarget: jest.fn(),
    ...overrides,
  };
}
