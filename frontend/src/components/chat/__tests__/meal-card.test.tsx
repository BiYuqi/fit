import { render, screen, fireEvent } from '@testing-library/react-native';
import { jest } from '@jest/globals';
import '@testing-library/jest-native/extend-expect';

import { MealCard } from '../meal-card';
import { createMockAuthStore, createMockChatStore } from '@/test/mocks';
import type { MealCardPayload } from '@/types/chat';

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
function basePayload(overrides?: Partial<MealCardPayload>): MealCardPayload {
  return {
    meal_key: { date: '2026-07-04', meal_type: 'breakfast' },
    last_changes: [],
    items: [
      {
        record_id: 'r1',
        food_name: '全麦面包',
        count: 2,
        count_unit: '片',
        raw_input: '全麦面包2片',
        weight_g: 100,
        calories: 174,
        protein_g: 8,
        fat_g: 3,
        carbs_g: 30,
        is_estimated: false,
        portion_label: 'medium',
      },
      {
        record_id: 'r2',
        food_name: '鸡蛋',
        count: null,
        count_unit: null,
        raw_input: null,
        weight_g: 50,
        calories: 72,
        protein_g: 6,
        fat_g: 5,
        carbs_g: 1,
        is_estimated: true,
        portion_label: 'medium',
      },
    ],
    totals: { calories: 246, protein_g: 14, fat_g: 8, carbs_g: 31 },
    item_count: 2,
    ...overrides,
  };
}

function renderCard(payload: MealCardPayload, messageId = 'msg-m1') {
  return render(<MealCard payload={payload} messageId={messageId} />);
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('MealCard', () => {
  beforeEach(() => {
    mockUseAuthStore.mockReturnValue(createMockAuthStore());
    mockUseChatStore.mockReturnValue(createMockChatStore());
  });

  // ── Rendering (default expanded) ────────────────────────────────────

  it('renders header with meal label, item count, and total calories', () => {
    renderCard(basePayload());
    expect(screen.getByText(/早餐/)).toBeOnTheScreen();
    expect(screen.getByText(/2 项/)).toBeOnTheScreen();
    expect(screen.getByText('246')).toBeOnTheScreen();
    expect(screen.getByText('kcal')).toBeOnTheScreen();
  });

  it('renders item as food_name ×count（weight）when count present', () => {
    renderCard(basePayload());
    expect(screen.getByText(/全麦面包 ×2（100g）/)).toBeOnTheScreen();
    expect(screen.getByText('174')).toBeOnTheScreen();
  });

  it('falls back to food_name + weight_g when count is missing', () => {
    renderCard(basePayload());
    expect(screen.getByText(/鸡蛋 50g/)).toBeOnTheScreen();
    expect(screen.getByText('72')).toBeOnTheScreen();
  });

  it('shows "估" badge for estimated items only', () => {
    renderCard(basePayload());
    // 鸡蛋 is_estimated: true → badge; 全麦面包 is_estimated: false → no badge attached to it
    expect(screen.getByText(/估/)).toBeOnTheScreen();
  });

  it('renders macro totals', () => {
    renderCard(basePayload());
    expect(screen.getByText(/14g/)).toBeOnTheScreen();
    expect(screen.getByText(/8g/)).toBeOnTheScreen();
    expect(screen.getByText(/31g/)).toBeOnTheScreen();
  });

  // ── Collapse / expand ───────────────────────────────────────────────

  it('collapses to header + macro summary on header press (items hidden)', () => {
    renderCard(basePayload());
    fireEvent.press(screen.getByText(/早餐/));

    expect(screen.queryByText(/全麦面包2片/)).not.toBeOnTheScreen();
    expect(screen.queryByText(/鸡蛋50g/)).not.toBeOnTheScreen();
    // header + macros row still visible
    expect(screen.getByText(/2 项/)).toBeOnTheScreen();
    expect(screen.getByText(/14g/)).toBeOnTheScreen();
  });

  it('expands again on second header press', () => {
    renderCard(basePayload());
    const header = screen.getByText(/早餐/);
    fireEvent.press(header);
    fireEvent.press(header);
    expect(screen.getByText(/全麦面包 ×2（100g）/)).toBeOnTheScreen();
  });

  // ── last_changes / 项级独立撤销（T53）──────────────────────────────

  it('shows undo button only on items present in last_changes', () => {
    renderCard(basePayload({ last_changes: [{ record_id: 'r2' }] }));
    expect(screen.getByText('撤销')).toBeOnTheScreen();
    expect(screen.getAllByText('撤销')).toHaveLength(1);
  });

  it('批量改多条：每条各显示独立撤销按钮（T53 核心）', () => {
    renderCard(basePayload({ last_changes: [{ record_id: 'r1' }, { record_id: 'r2' }] }));
    expect(screen.getAllByText('撤销')).toHaveLength(2);
  });

  it('calls undo with record_id, prev_state, token on press', () => {
    const mockUndo = jest.fn();
    mockUseChatStore.mockReturnValue(createMockChatStore({ undo: mockUndo }));
    mockUseAuthStore.mockReturnValue(createMockAuthStore({ token: 'tok-abc' }));

    renderCard(
      basePayload({
        last_changes: [{ record_id: 'r2', prev_state: { food_id: 'f1', portion_label: 'medium', weight_g: 40 } }],
      }),
    );

    fireEvent.press(screen.getByText('撤销'));

    expect(mockUndo).toHaveBeenCalledTimes(1);
    expect(mockUndo).toHaveBeenCalledWith(
      'r2',
      { food_id: 'f1', portion_label: 'medium', weight_g: 40 },
      'tok-abc',
    );
  });

  it('撤销串扰：三条批量改，一条已撤销只影响那一条', () => {
    // r1/r2 都可撤销，r2 已进入 undoneRecords → 只有 r2 显示"已撤销"，r1 仍显示"撤销"
    mockUseChatStore.mockReturnValue(createMockChatStore({ undoneRecords: { r2: true } }));
    renderCard(basePayload({ last_changes: [{ record_id: 'r1' }, { record_id: 'r2' }] }));

    expect(screen.getByText('已撤销')).toBeOnTheScreen();
    expect(screen.getAllByText('撤销')).toHaveLength(1); // 只剩 r1
  });

  it('does NOT call undo when that record already undone', () => {
    const mockUndo = jest.fn();
    mockUseChatStore.mockReturnValue(
      createMockChatStore({ undo: mockUndo, undoneRecords: { r2: true } }),
    );
    renderCard(basePayload({ last_changes: [{ record_id: 'r2' }] }));
    expect(mockUndo).not.toHaveBeenCalled();
  });

  it('reads legacy single-slot last_change (T53 前历史卡兼容)', () => {
    renderCard(basePayload({ last_change: { record_id: 'r2' }, last_changes: undefined }));
    expect(screen.getByText('撤销')).toBeOnTheScreen();
  });

  it('shows no undo button anywhere when last_changes empty', () => {
    renderCard(basePayload({ last_changes: [] }));
    expect(screen.queryByText('撤销')).not.toBeOnTheScreen();
    expect(screen.queryByText('已撤销')).not.toBeOnTheScreen();
  });

  // ── Empty meal ───────────────────────────────────────────────────────

  it('shows "已清空" when items is empty', () => {
    renderCard(basePayload({ items: [], item_count: 0, totals: { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }));
    expect(screen.getByText('已清空')).toBeOnTheScreen();
  });

  it('does not render item rows or macro totals when empty', () => {
    renderCard(basePayload({ items: [], item_count: 0, totals: { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } }));
    expect(screen.queryByText(/全麦面包/)).not.toBeOnTheScreen();
    expect(screen.queryByText(/蛋白/)).not.toBeOnTheScreen();
  });
});
