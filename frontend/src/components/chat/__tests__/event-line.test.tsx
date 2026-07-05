import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { jest } from '@jest/globals';
import '@testing-library/jest-native/extend-expect';

import { EventLine } from '../event-line';
import { createMockAuthStore, createMockChatStore } from '@/test/mocks';
import type { EventCardPayload } from '@/types/chat';

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

// ─── Helpers ─────────────────────────────────────────────────────────────
function basePayload(overrides?: Partial<EventCardPayload>): EventCardPayload {
  return {
    event_type: 'deleted',
    text: '已删除 李子 · -38 kcal',
    record_id: 'r1',
    undo: { prev_state: {} },
    undone: false,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('EventLine', () => {
  beforeEach(() => {
    mockUseAuthStore.mockReturnValue(createMockAuthStore());
    mockUseChatStore.mockReturnValue(createMockChatStore());
  });

  it('删除事件：显示文案 + 撤销按钮', () => {
    render(<EventLine payload={basePayload()} messageId="m1" />);
    expect(screen.getByText('已删除 李子 · -38 kcal')).toBeOnTheScreen();
    expect(screen.getByText('撤销')).toBeOnTheScreen();
  });

  it('点撤销：调用 undoEvent(messageId, token)', async () => {
    const undoEvent = jest.fn(() => Promise.resolve());
    mockUseChatStore.mockReturnValue(createMockChatStore({ undoEvent }));
    render(<EventLine payload={basePayload()} messageId="m1" />);
    await act(async () => {
      fireEvent.press(screen.getByText('撤销'));
    });
    expect(undoEvent).toHaveBeenCalledWith('m1', expect.anything());
  });

  it('已撤销态：显示「已撤销」灰态，不再渲染撤销按钮', () => {
    render(<EventLine payload={basePayload({ undone: true })} messageId="m1" />);
    expect(screen.getByText('· 已撤销')).toBeOnTheScreen();
    expect(screen.queryByText('撤销')).toBeNull();
  });

  it('modified 事件（无 undo）：只显示文案，不渲染撤销按钮', () => {
    render(
      <EventLine
        payload={basePayload({ event_type: 'modified', undo: undefined, text: '已修改：米饭 100g → 200g（+130 kcal）' })}
        messageId="m2"
      />,
    );
    expect(screen.getByText('已修改：米饭 100g → 200g（+130 kcal）')).toBeOnTheScreen();
    expect(screen.queryByText('撤销')).toBeNull();
  });
});
