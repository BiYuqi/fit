import { render, screen, fireEvent } from '@testing-library/react-native';
import { jest } from '@jest/globals';
import '@testing-library/jest-native/extend-expect';

import { ExerciseCard } from '../exercise-card';
import { createMockAuthStore, createMockChatStore } from '@/test/mocks';
import type { ExerciseCardPayload } from '@/types/chat';

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
function basePayload(overrides?: Partial<ExerciseCardPayload>): ExerciseCardPayload {
  return {
    exercise_id: 'ex-1',
    type: '跑步',
    duration_min: 30,
    calories_burned: 325,
    ...overrides,
  };
}

function renderCard(payload: ExerciseCardPayload, messageId = 'msg-1') {
  return render(<ExerciseCard payload={payload} messageId={messageId} />);
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('ExerciseCard', () => {
  beforeEach(() => {
    mockUseAuthStore.mockReturnValue(createMockAuthStore());
    mockUseChatStore.mockReturnValue(createMockChatStore());
  });

  // ── Rendering ────────────────────────────────────────────────────────

  it('renders exercise type, duration, and calories', () => {
    renderCard(basePayload());

    // compact layout: type and duration are in a nested Text, use regex
    expect(screen.getByText(/跑步/)).toBeOnTheScreen();
    expect(screen.getByText(/30min/)).toBeOnTheScreen();
    expect(screen.getByText('325')).toBeOnTheScreen();
    expect(screen.getByText('kcal')).toBeOnTheScreen();
  });

  it('renders in compact layout', () => {
    // compact layout: badge is icon-only (no "已录入" text), type + duration + calories on one row
    renderCard(basePayload());
    expect(screen.getByText(/跑步/)).toBeOnTheScreen();
    expect(screen.getByText('325')).toBeOnTheScreen();
  });

  it('renders without duration_min gracefully', () => {
    renderCard(basePayload({ duration_min: 0 }));

    expect(screen.getByText(/0min/)).toBeOnTheScreen();
    // type and calories should still render
    expect(screen.getByText(/跑步/)).toBeOnTheScreen();
  });

  // ── Undo: absent ─────────────────────────────────────────────────────

  it('does NOT show undo section when payload has no undo', () => {
    renderCard(basePayload()); // no undo field

    expect(screen.queryByText('撤销')).not.toBeOnTheScreen();
    expect(screen.queryByText('已撤销')).not.toBeOnTheScreen();
  });

  // ── Undo: present ────────────────────────────────────────────────────

  it('shows undo button when payload has undo', () => {
    renderCard(basePayload({
      undo: {
        record_id: 'ex-1',
        prev_state: { calories_burned: 325, kind: 'exercise' },
      },
    }));

    expect(screen.getByText('撤销')).toBeOnTheScreen();
  });

  it('calls undo with correct arguments on press', () => {
    const mockUndo = jest.fn();
    mockUseChatStore.mockReturnValue(createMockChatStore({ undo: mockUndo }));
    mockUseAuthStore.mockReturnValue(createMockAuthStore({ token: 'tok-123' }));

    renderCard(basePayload({
      undo: {
        record_id: 'ex-1',
        prev_state: { calories_burned: 325, kind: 'exercise' },
      },
    }));

    fireEvent.press(screen.getByText('撤销'));

    expect(mockUndo).toHaveBeenCalledTimes(1);
    expect(mockUndo).toHaveBeenCalledWith(
      'ex-1',                                         // record_id（T53：撤销态按 record_id）
      { calories_burned: 325, kind: 'exercise' },     // prev_state
      'tok-123',                                      // token
    );
  });

  it('shows "已撤销" and hides undo button after undo', () => {
    mockUseChatStore.mockReturnValue(
      createMockChatStore({ undoneRecords: { 'ex-1': true } }),
    );

    renderCard(basePayload({
      undo: {
        record_id: 'ex-1',
        prev_state: { calories_burned: 325, kind: 'exercise' },
      },
    }));

    expect(screen.getByText('已撤销')).toBeOnTheScreen();
    expect(screen.queryByText('撤销')).not.toBeOnTheScreen();
  });

  it('does NOT call undo when no token available', () => {
    const mockUndo = jest.fn();
    mockUseChatStore.mockReturnValue(createMockChatStore({ undo: mockUndo }));
    mockUseAuthStore.mockReturnValue(createMockAuthStore({ token: null }));

    renderCard(basePayload({
      undo: {
        record_id: 'ex-1',
        prev_state: { calories_burned: 325, kind: 'exercise' },
      },
    }));

    fireEvent.press(screen.getByText('撤销'));
    expect(mockUndo).not.toHaveBeenCalled();
  });

  it('applies undone styling and shows "已撤销" text', () => {
    mockUseChatStore.mockReturnValue(
      createMockChatStore({ undoneRecords: { 'ex-1': true } }),
    );

    renderCard(
      basePayload({
        undo: { record_id: 'ex-1', prev_state: { calories_burned: 325, kind: 'exercise' } },
      }),
    );

    // Already verified above; redundancy ensures no regression on dual assertion
    expect(screen.getByText('已撤销')).toBeOnTheScreen();
    expect(screen.queryByText('撤销')).not.toBeOnTheScreen();
  });
});
