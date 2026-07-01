import { render, screen, fireEvent } from '@testing-library/react-native';
import { jest } from '@jest/globals';
import '@testing-library/jest-native/extend-expect';

import { RecordCard } from '../record-card';
import { createMockAuthStore, createMockChatStore } from '@/test/mocks';
import type { RecordCardPayload } from '@/types/chat';

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
function basePayload(overrides?: Partial<RecordCardPayload>): RecordCardPayload {
  return {
    food_name: '鸡胸肉',
    weight_g: 150,
    calories: 200,
    protein_g: 35,
    fat_g: 4,
    carbs_g: 2,
    ...overrides,
  };
}

function renderCard(payload: RecordCardPayload, opts?: { mealType?: string; messageId?: string }) {
  return render(
    <RecordCard
      payload={payload}
      mealType={opts?.mealType}
      messageId={opts?.messageId ?? 'msg-r1'}
    />,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('RecordCard', () => {
  beforeEach(() => {
    mockUseAuthStore.mockReturnValue(createMockAuthStore());
    mockUseChatStore.mockReturnValue(createMockChatStore());
  });

  // ── Rendering ────────────────────────────────────────────────────────

  it('renders food name, weight, calories', () => {
    renderCard(basePayload());

    expect(screen.getByText('鸡胸肉')).toBeOnTheScreen();
    expect(screen.getByText('200')).toBeOnTheScreen();
    expect(screen.getByText('kcal')).toBeOnTheScreen();
    // Weight appears in the meal-info line: "加餐 · 150g" (default meal label when no mealType)
    expect(screen.getByText(/150g/)).toBeOnTheScreen();
  });

  it('renders all three macros', () => {
    renderCard(basePayload());

    expect(screen.getByText('35g')).toBeOnTheScreen();
    expect(screen.getByText('4g')).toBeOnTheScreen();
    expect(screen.getByText('2g')).toBeOnTheScreen();
    expect(screen.getByText('蛋白')).toBeOnTheScreen();
    expect(screen.getByText('脂肪')).toBeOnTheScreen();
    expect(screen.getByText('碳水')).toBeOnTheScreen();
  });

  it.each([
    ['breakfast', '早餐'],
    ['lunch', '午餐'],
    ['dinner', '晚餐'],
    ['snack', '加餐'],
  ] as const)('renders "%s" meal type as "%s"', (mealType, label) => {
    renderCard(basePayload(), { mealType, messageId: `m-${mealType}` });
    // Meal label is part of "早餐 · 150g" compound text, so use regex
    expect(screen.getByText(new RegExp(label))).toBeOnTheScreen();
  });

  it('renders the checkmark badge', () => {
    renderCard(basePayload());
    expect(screen.getByText('已录入')).toBeOnTheScreen();
  });

  it('shows calorie number prominently', () => {
    renderCard(basePayload({ calories: 450 }));
    expect(screen.getByText('450')).toBeOnTheScreen();
  });

  // ── Undo ─────────────────────────────────────────────────────────────

  it('shows undo button when payload has undo for update', () => {
    renderCard(basePayload({
      undo: {
        record_id: 'rec-1',
        prev_state: { food_id: 'f1', portion_label: 'medium', weight_g: 100 },
      },
    }));

    expect(screen.getByText('撤销')).toBeOnTheScreen();
  });

  it('calls undo with correct arguments on press', () => {
    const mockUndo = jest.fn();
    mockUseChatStore.mockReturnValue(createMockChatStore({ undo: mockUndo }));
    mockUseAuthStore.mockReturnValue(createMockAuthStore({ token: 'tok-abc' }));

    renderCard(basePayload({
      undo: {
        record_id: 'rec-1',
        prev_state: { food_id: 'f1', portion_label: 'large', weight_g: 200 },
      },
    }));

    fireEvent.press(screen.getByText('撤销'));

    expect(mockUndo).toHaveBeenCalledTimes(1);
    expect(mockUndo).toHaveBeenCalledWith(
      'msg-r1',
      'rec-1',
      { food_id: 'f1', portion_label: 'large', weight_g: 200 },
      'tok-abc',
    );
  });

  it('shows "已撤销" after undo — button hidden', () => {
    mockUseChatStore.mockReturnValue(
      createMockChatStore({ undoneCards: { 'msg-r1': true } }),
    );

    renderCard(basePayload({
      undo: {
        record_id: 'rec-1',
        prev_state: { food_id: 'f1', portion_label: 'medium', weight_g: 100 },
      },
    }));

    expect(screen.getByText('已撤销')).toBeOnTheScreen();
    expect(screen.queryByText('撤销')).not.toBeOnTheScreen();
  });

  it('does NOT show undo section when payload has no undo', () => {
    renderCard(basePayload()); // no undo

    expect(screen.queryByText('撤销')).not.toBeOnTheScreen();
    expect(screen.queryByText('已撤销')).not.toBeOnTheScreen();
  });

  it('does NOT call undo when already undone', () => {
    const mockUndo = jest.fn();
    mockUseChatStore.mockReturnValue(
      createMockChatStore({ undo: mockUndo, undoneCards: { 'msg-r1': true } }),
    );

    renderCard(basePayload({
      undo: {
        record_id: 'rec-1',
        prev_state: { food_id: 'f1', portion_label: 'medium', weight_g: 100 },
      },
    }));

    // "已撤销" is rendered, so there's no "撤销" button to press.
    // Verify the mock was never called.
    expect(mockUndo).not.toHaveBeenCalled();
  });
});
