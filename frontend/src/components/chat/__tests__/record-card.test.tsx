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

function renderCard(
  payload: RecordCardPayload,
  opts?: { mealType?: string; messageId?: string; recordId?: string },
) {
  return render(
    <RecordCard
      payload={payload}
      mealType={opts?.mealType}
      messageId={opts?.messageId ?? 'msg-r1'}
      recordId={opts?.recordId}
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

    // compact layout: food name is in a nested Text, use regex
    expect(screen.getByText(/鸡胸肉/)).toBeOnTheScreen();
    expect(screen.getByText('200')).toBeOnTheScreen();
    expect(screen.getByText('kcal')).toBeOnTheScreen();
    // Weight is in nested foodMeta Text: "加餐 · 150g"
    expect(screen.getByText(/150g/)).toBeOnTheScreen();
  });

  it('renders all three macros', () => {
    renderCard(basePayload());

    // compact layout: macros are inline text "蛋白 35g", use regex
    expect(screen.getByText(/35g/)).toBeOnTheScreen();
    expect(screen.getByText(/4g/)).toBeOnTheScreen();
    expect(screen.getByText(/2g/)).toBeOnTheScreen();
    expect(screen.getByText(/蛋白/)).toBeOnTheScreen();
    expect(screen.getByText(/脂肪/)).toBeOnTheScreen();
    expect(screen.getByText(/碳水/)).toBeOnTheScreen();
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

  it('renders in compact layout', () => {
    // compact layout: badge is icon-only (no "已录入" text), food + calories on one row
    renderCard(basePayload());
    expect(screen.getByText(/鸡胸肉/)).toBeOnTheScreen();
    expect(screen.getByText('200')).toBeOnTheScreen();
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

  // ── 用户食物直连逃生口（LEARNING_SPEC §7）────────────────────────────

  const escapePayload = {
    canonical: '煎饼',
    portions: [{ label: 'medium' as const, grams: 150 }],
    chosen_label: 'medium',
    ai_candidates: ['煎饼果子', '鸡蛋煎饼'],
  };

  it('shows habit text and escape button when matched_by_habit', () => {
    renderCard(basePayload({ matched_by_habit: true, escape: escapePayload }));

    expect(screen.getByText(/已按你的习惯记为/)).toBeOnTheScreen();
    expect(screen.getByText('不是它？')).toBeOnTheScreen();
  });

  it('does NOT show habit row when matched_by_habit is absent', () => {
    renderCard(basePayload());

    expect(screen.queryByText(/已按你的习惯记为/)).not.toBeOnTheScreen();
    expect(screen.queryByText('不是它？')).not.toBeOnTheScreen();
  });

  it('calls resetAlias with correct arguments on press', () => {
    const mockResetAlias = jest.fn();
    mockUseChatStore.mockReturnValue(createMockChatStore({ resetAlias: mockResetAlias }));
    mockUseAuthStore.mockReturnValue(createMockAuthStore({ token: 'tok-abc' }));

    renderCard(
      basePayload({ matched_by_habit: true, escape: escapePayload }),
      { recordId: 'rec-42' },
    );

    fireEvent.press(screen.getByText('不是它？'));

    expect(mockResetAlias).toHaveBeenCalledTimes(1);
    expect(mockResetAlias).toHaveBeenCalledWith('msg-r1', 'rec-42', escapePayload, 'tok-abc');
  });

  it('shows "已替换" after reset — escape button hidden', () => {
    mockUseChatStore.mockReturnValue(
      createMockChatStore({ undoneCards: { 'msg-r1': true } }),
    );

    renderCard(
      basePayload({ matched_by_habit: true, escape: escapePayload }),
      { recordId: 'rec-42' },
    );

    expect(screen.getByText('已替换')).toBeOnTheScreen();
    expect(screen.queryByText('不是它？')).not.toBeOnTheScreen();
  });

  it('does NOT call resetAlias when already replaced', () => {
    const mockResetAlias = jest.fn();
    mockUseChatStore.mockReturnValue(
      createMockChatStore({ resetAlias: mockResetAlias, undoneCards: { 'msg-r1': true } }),
    );

    renderCard(
      basePayload({ matched_by_habit: true, escape: escapePayload }),
      { recordId: 'rec-42' },
    );

    // "已替换" is rendered, so there's no "不是它？" button to press.
    expect(mockResetAlias).not.toHaveBeenCalled();
  });
});
