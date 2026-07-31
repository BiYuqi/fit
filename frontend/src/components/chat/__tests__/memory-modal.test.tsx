import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { jest } from '@jest/globals';
import '@testing-library/jest-native/extend-expect';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { MemoryModal } from '../memory-modal';
import { createMockAuthStore } from '@/test/mocks';

// ─── Module mocks ───────────────────────────────────
const mockUseAuthStore = jest.fn();
const mockApiFetch = jest.fn();

jest.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector?: (s: unknown) => unknown) =>
    selector ? selector(mockUseAuthStore()) : mockUseAuthStore(),
}));
jest.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));
jest.mock('@/hooks/use-color-scheme', () => ({
  useColorScheme: () => 'light',
}));

// ─── Helpers ────────────────────────────────────────

function memory(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    type: 'constraint',
    entity: 'peanut',
    content: '花生过敏',
    importance_class: 'medical',
    repetition_count: 1,
    state: 'ACTIVE',
    score: 1,
    created_at: new Date().toISOString(),
    last_accessed_at: new Date().toISOString(),
    ...overrides,
  };
}

// 后端按 type 分组下发；组件把它拍平成一条流，所以测试也照真实结构喂
function payload(items: ReturnType<typeof memory>[], paused = false) {
  const byType = new Map<string, ReturnType<typeof memory>[]>();
  for (const it of items) {
    byType.set(it.type, [...(byType.get(it.type) ?? []), it]);
  }
  return {
    groups: [...byType].map(([type, groupItems]) => ({ type, items: groupItems })),
    total: items.length,
    paused,
  };
}

// 列表按 created_at 倒序，所以时间戳必须写死区分开，不能都用 now
const SAMPLE = [
  memory({ id: 'm-1', type: 'constraint', content: '花生过敏', created_at: '2026-07-01T00:00:00.000Z' }),
  memory({
    id: 'm-2',
    type: 'habit',
    content: '每天30分钟羽毛球',
    importance_class: 'normal',
    created_at: '2026-07-10T00:00:00.000Z',
  }),
  memory({
    id: 'm-3',
    type: 'context_state',
    content: '一两周没降体重了',
    importance_class: 'normal',
    state: 'WEAK',
    created_at: '2026-07-20T00:00:00.000Z',
  }),
];

// useSafeAreaInsets 在测试里拿不到原生 metrics，得自己喂一份
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function renderModal(props: Partial<React.ComponentProps<typeof MemoryModal>> = {}) {
  return render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <MemoryModal visible onClose={jest.fn()} {...props} />
    </SafeAreaProvider>,
  );
}

// ─── Tests ──────────────────────────────────────────

describe('MemoryModal', () => {
  beforeEach(() => {
    mockUseAuthStore.mockReturnValue(createMockAuthStore());
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue(payload(SAMPLE) as never);
  });

  it('renders every memory in one flat list, newest first, no grouping headers', async () => {
    renderModal();
    expect(await screen.findByText('花生过敏')).toBeOnTheScreen();
    expect(screen.getAllByText(/花生过敏|每天30分钟羽毛球|一两周没降体重了/).map((n) => n.props.children))
      .toEqual(['一两周没降体重了', '每天30分钟羽毛球', '花生过敏']);
    expect(screen.getByText('每天30分钟羽毛球')).toBeOnTheScreen();
    expect(screen.getByText('一两周没降体重了')).toBeOnTheScreen();
    // 旧版的分组标题不该再出现
    expect(screen.queryByText('饮食禁忌')).not.toBeOnTheScreen();
    expect(screen.queryByText('当前状态')).not.toBeOnTheScreen();
  });

  it('shows a filter chip per non-empty bucket with its count', async () => {
    renderModal();
    expect(await screen.findByText('全部 3')).toBeOnTheScreen();
    expect(screen.getByText('健康 1')).toBeOnTheScreen();
    expect(screen.getByText('习惯 1')).toBeOnTheScreen();
    expect(screen.getByText('近况 1')).toBeOnTheScreen();
  });

  it('filters the list down to the tapped bucket', async () => {
    renderModal();
    fireEvent.press(await screen.findByText('健康 1'));
    expect(screen.getByText('花生过敏')).toBeOnTheScreen();
    expect(screen.queryByText('每天30分钟羽毛球')).not.toBeOnTheScreen();
    expect(screen.queryByText('一两周没降体重了')).not.toBeOnTheScreen();
  });

  it('marks WEAK memories as fading', async () => {
    renderModal();
    expect(await screen.findByText('淡忘中')).toBeOnTheScreen();
    // 只有 WEAK 那条带标记
    expect(screen.getAllByText('淡忘中')).toHaveLength(1);
  });

  it('deletes optimistically and reports the new count', async () => {
    const onCount = jest.fn();
    renderModal({ onMemoryCountChange: onCount });
    await screen.findByText('花生过敏');

    fireEvent.press(screen.getByLabelText('删除记忆：花生过敏'));

    await waitFor(() => expect(screen.queryByText('花生过敏')).not.toBeOnTheScreen());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/memory/m-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(onCount).toHaveBeenLastCalledWith(2, false);
  });

  it('restores the row when the delete request fails', async () => {
    renderModal();
    await screen.findByText('花生过敏');
    mockApiFetch.mockRejectedValueOnce(new Error('offline') as never);

    fireEvent.press(screen.getByLabelText('删除记忆：花生过敏'));

    await waitFor(() => expect(screen.getByText('花生过敏')).toBeOnTheScreen());
  });

  it('falls back to 全部 when the active filter runs out of items', async () => {
    renderModal();
    fireEvent.press(await screen.findByText('健康 1'));
    fireEvent.press(screen.getByLabelText('删除记忆：花生过敏'));

    await waitFor(() => expect(screen.getByText('每天30分钟羽毛球')).toBeOnTheScreen());
    expect(screen.queryByText('健康 1')).not.toBeOnTheScreen();
  });

  it('shows the paused banner when memory extraction is off', async () => {
    mockApiFetch.mockResolvedValue(payload(SAMPLE, true) as never);
    renderModal();
    expect(await screen.findByText('已暂停 · 新对话不会产生新记忆')).toBeOnTheScreen();
  });

  it('shows the empty state and no filter bar when there are no memories', async () => {
    mockApiFetch.mockResolvedValue(payload([]) as never);
    renderModal();
    expect(await screen.findByText('AI 还不了解你')).toBeOnTheScreen();
    expect(screen.queryByText('全部 0')).not.toBeOnTheScreen();
  });
});
