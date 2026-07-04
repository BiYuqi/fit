import { render, screen, fireEvent } from '@testing-library/react-native';
import { jest } from '@jest/globals';
import '@testing-library/jest-native/extend-expect';

import { DeleteConfirmCard } from '../delete-confirm-card';
import { createMockAuthStore, createMockChatStore } from '@/test/mocks';
import type { DeleteConfirmCardPayload } from '@/types/chat';

// ─── Module mocks (hoisted by Jest) ─────────────────────────────────────
const mockUseAuthStore = jest.fn();
const mockUseChatStore = jest.fn();

jest.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector?: (s: unknown) => unknown) =>
    selector ? selector(mockUseAuthStore()) : mockUseAuthStore(),
}));

jest.mock('@/stores/chat-store', () => ({
  useChatStore: (selector?: (s: unknown) => unknown) =>
    selector ? selector(mockUseChatStore()) : mockUseChatStore(),
}));

jest.mock('@/hooks/use-color-scheme', () => ({
  useColorScheme: () => 'light',
}));

// ─── Helpers ─────────────────────────────────────────────────────────────
function basePayload(overrides?: Partial<DeleteConfirmCardPayload>): DeleteConfirmCardPayload {
  return {
    pending_id: 'p1',
    record_id: 'r1',
    name: '粽子',
    meal_type: 'breakfast',
    calories: 29,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('DeleteConfirmCard', () => {
  beforeEach(() => {
    mockUseAuthStore.mockReturnValue(createMockAuthStore());
    mockUseChatStore.mockReturnValue(createMockChatStore());
  });

  it('待确认态：显示确认文案与两个按钮', () => {
    render(<DeleteConfirmCard payload={basePayload()} isResolved={false} />);
    expect(screen.getByText('确认删除「粽子」？')).toBeOnTheScreen();
    expect(screen.getByText('确认删除')).toBeOnTheScreen();
    expect(screen.getByText('取消')).toBeOnTheScreen();
  });

  it('点确认：调用 resolve(pending_id, confirm)', () => {
    const resolve = jest.fn();
    mockUseChatStore.mockReturnValue(createMockChatStore({ resolve }));
    render(<DeleteConfirmCard payload={basePayload()} isResolved={false} />);
    fireEvent.press(screen.getByText('确认删除'));
    expect(resolve).toHaveBeenCalledWith('p1', 'confirm', expect.anything());
  });

  it('已确认态：显示「已删除」且不再渲染操作按钮（2026-07-04 空白卡回归）', () => {
    render(<DeleteConfirmCard payload={basePayload()} isResolved={true} />);
    expect(screen.getByText('已删除「粽子」')).toBeOnTheScreen();
    expect(screen.queryByText('确认删除')).toBeNull();
    expect(screen.queryByText('取消')).toBeNull();
  });

  it('点取消：本地转为已取消态，不调用 resolve', () => {
    const resolve = jest.fn();
    mockUseChatStore.mockReturnValue(createMockChatStore({ resolve }));
    render(<DeleteConfirmCard payload={basePayload()} isResolved={false} />);
    fireEvent.press(screen.getByText('取消'));
    expect(screen.getByText('已取消删除「粽子」')).toBeOnTheScreen();
    expect(resolve).not.toHaveBeenCalled();
  });
});
