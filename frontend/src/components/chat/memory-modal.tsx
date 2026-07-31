// MemoryModal — 语义记忆管理中心（MEMORY_SPEC §9.4）
// 结构：筛选条 + 扁平时间流。后端的 5 个 type 在展示层合并成 3 个日常说法的桶
// （健康 / 习惯 / 近况），一条流按「最近说的」倒序排；删除靠左滑，暂停与清空收进
// 右上 ··· 菜单，正文里不留常驻控件。
//
// 注意：内容区不能再套 backdrop 的 TouchableOpacity —— 外层 Touchable 会抢走触摸
// 起始责任，把 FlatList 的滚动手势卡死。这里用全屏玻璃面板 + 左上关闭按钮。

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { SymbolView } from 'expo-symbols';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Glass, Radius } from '@/constants/theme';
import { apiFetch } from '@/lib/api';
import { useAuthStore } from '@/stores/auth-store';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';

// ── Types ──

interface MemoryItem {
  id: string;
  type: string;
  entity: string;
  content: string;
  importance_class: string;
  repetition_count: number;
  state: string;
  score: number;
  created_at: string;
  last_accessed_at: string;
}

interface MemoryGroup {
  type: string;
  items: MemoryItem[];
}

interface MemoryData {
  groups: MemoryGroup[];
  total: number;
  paused: boolean;
}

// ── Buckets：后端 type → 用户看得懂的三桶 ──

type BucketKey = 'health' | 'habit' | 'recent' | 'other';

const BUCKETS: { key: BucketKey; label: string; color: string }[] = [
  { key: 'health', label: '健康', color: '#FF453A' },
  { key: 'habit',  label: '习惯', color: '#30D158' },
  { key: 'recent', label: '近况', color: '#FF9F0A' },
  { key: 'other',  label: '其他', color: '#8E8E93' },
];

const TYPE_TO_BUCKET: Record<string, BucketKey> = {
  constraint:    'health',
  preference:    'habit',
  habit:         'habit',
  context_state: 'recent',
  goal:          'recent',
};

function bucketOf(type: string): BucketKey {
  return TYPE_TO_BUCKET[type] ?? 'other';
}

// ── Helpers ──

function daysAgoStr(isoStr: string): string {
  const now = Date.now();
  const then = new Date(isoStr).getTime();
  const days = Math.floor((now - then) / (1000 * 60 * 60 * 24));
  if (days <= 0) return '今天说的';
  if (days === 1) return '昨天说的';
  if (days < 7) return `${days}天前说的`;
  if (days < 30) return `${Math.floor(days / 7)}周前说的`;
  return `${Math.floor(days / 30)}个月前说的`;
}

// ── Props ──

type Props = {
  visible: boolean;
  onClose: () => void;
  onMemoryCountChange?: (count: number, paused: boolean) => void;
};

// ── Component ──

export function MemoryModal({ visible, onClose, onMemoryCountChange }: Props) {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const theme = useTheme();
  const glass = Glass[isDark ? 'dark' : 'light'];
  const { token } = useAuthStore();

  const blurTint = isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight';
  const glassGrad = isDark
    ? (['rgba(94,94,102,0.42)', 'rgba(38,38,44,0.22)', 'rgba(58,58,66,0.34)'] as const)
    : (['rgba(255,255,255,0.82)', 'rgba(255,255,255,0.65)', 'rgba(255,255,255,0.75)'] as const);
  const glassStroke = isDark ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.80)';

  const [items, setItems] = useState<MemoryItem[]>([]);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<BucketKey | 'all'>('all');

  const loadMemories = useCallback(async () => {
    if (!token) return;
    try {
      const res = await apiFetch<MemoryData>('/api/memory', { token });
      // 分组只是后端的传输结构，这里拍平成一条按时间倒序的流
      const flat = res.groups
        .flatMap((g) => g.items)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setItems(flat);
      setPaused(res.paused);
      onMemoryCountChange?.(res.total, res.paused);
    } catch {
      // Silently fail — user can close and retry
    } finally {
      setLoading(false);
    }
  }, [token, onMemoryCountChange]);

  // Reset state when modal opens → fetch data
  useEffect(() => {
    if (visible) {
      setLoading(true);
      setItems([]);
      setFilter('all');
      loadMemories();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // ── Derived ──

  const counts = useMemo(() => {
    const map = new Map<BucketKey, number>();
    for (const it of items) {
      const b = bucketOf(it.type);
      map.set(b, (map.get(b) ?? 0) + 1);
    }
    return map;
  }, [items]);

  const visibleItems = useMemo(
    () => (filter === 'all' ? items : items.filter((it) => bucketOf(it.type) === filter)),
    [items, filter],
  );

  // 删空某一桶后它的 chip 会消失，筛选态得跟着退回「全部」，否则停在空列表上
  useEffect(() => {
    if (filter !== 'all' && (counts.get(filter) ?? 0) === 0) setFilter('all');
  }, [counts, filter]);

  // ── Actions ──

  const handleDelete = useCallback(
    async (item: MemoryItem) => {
      if (!token) return;
      const snapshot = items;
      const next = items.filter((i) => i.id !== item.id);
      setItems(next);
      onMemoryCountChange?.(next.length, paused);
      try {
        await apiFetch(`/api/memory/${item.id}`, { token, method: 'DELETE' });
      } catch {
        setItems(snapshot);
        onMemoryCountChange?.(snapshot.length, paused);
        Alert.alert('删除失败', '请重试');
      }
    },
    [token, items, paused, onMemoryCountChange],
  );

  const handleTogglePause = useCallback(async () => {
    if (!token) return;
    const next = !paused;
    setPaused(next);
    onMemoryCountChange?.(items.length, next);
    try {
      await apiFetch('/api/memory/pause', {
        token,
        method: 'POST',
        body: JSON.stringify({ paused: next }),
      });
    } catch {
      setPaused(!next);
      onMemoryCountChange?.(items.length, !next);
    }
  }, [token, paused, items.length, onMemoryCountChange]);

  const handleClearAll = useCallback(() => {
    Alert.alert('清除所有记忆', '清除后 AI 将忘记所有关于你的信息，确定？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清除',
        style: 'destructive',
        onPress: async () => {
          if (!token) return;
          try {
            await apiFetch('/api/memory/clear', { token, method: 'DELETE' });
            setItems([]);
            onMemoryCountChange?.(0, paused);
          } catch {
            Alert.alert('清除失败', '请重试');
          }
        },
      },
    ]);
  }, [token, paused, onMemoryCountChange]);

  const handleMenu = useCallback(() => {
    const pauseLabel = paused ? '恢复记忆' : '暂停记忆';
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['取消', pauseLabel, '清除所有记忆'],
          cancelButtonIndex: 0,
          destructiveButtonIndex: 2,
          message: paused
            ? 'AI 已暂停记忆，新对话不会产生新记忆'
            : 'AI 会从聊天里记住你的健康状况、口味和近况',
          userInterfaceStyle: isDark ? 'dark' : 'light',
        },
        (index) => {
          if (index === 1) handleTogglePause();
          if (index === 2) handleClearAll();
        },
      );
      return;
    }
    Alert.alert('记忆设置', undefined, [
      { text: '取消', style: 'cancel' },
      { text: pauseLabel, onPress: handleTogglePause },
      { text: '清除所有记忆', style: 'destructive', onPress: handleClearAll },
    ]);
  }, [paused, isDark, handleTogglePause, handleClearAll]);

  // ── Render ──

  const renderRow = useCallback(
    ({ item }: { item: MemoryItem }) => {
      const bucket = BUCKETS.find((b) => b.key === bucketOf(item.type))!;
      const fading = item.state === 'WEAK';
      return (
        <ReanimatedSwipeable
          friction={2}
          rightThreshold={40}
          overshootRight={false}
          renderRightActions={() => (
            <TouchableOpacity
              style={styles.deleteAction}
              onPress={() => handleDelete(item)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`删除记忆：${item.content}`}
            >
              <SymbolView
                name={{ ios: 'trash' as const, android: 'delete' as const, web: 'delete' as const }}
                size={17}
                tintColor="#FFFFFF"
              />
              <ThemedText style={styles.deleteActionText}>删除</ThemedText>
            </TouchableOpacity>
          )}
        >
          <View style={[styles.row, { borderBottomColor: theme.hairline }]}>
            <View style={[styles.dot, { backgroundColor: bucket.color, opacity: fading ? 0.4 : 1 }]} />
            <View style={styles.rowBody}>
              <ThemedText style={[styles.rowContent, fading && styles.rowContentFading]}>
                {item.content}
              </ThemedText>
              <View style={styles.rowMeta}>
                <ThemedText themeColor="textTertiary" style={styles.rowMetaText}>
                  {bucket.label} · {daysAgoStr(item.created_at)}
                </ThemedText>
                {fading && (
                  <View style={[styles.fadingPill, { backgroundColor: theme.backgroundElement }]}>
                    <ThemedText themeColor="textTertiary" style={styles.fadingPillText}>
                      淡忘中
                    </ThemedText>
                  </View>
                )}
              </View>
            </View>
          </View>
        </ReanimatedSwipeable>
      );
    },
    [theme, handleDelete],
  );

  const renderChip = (key: BucketKey | 'all', label: string, count: number) => {
    const active = filter === key;
    return (
      <TouchableOpacity
        key={key}
        style={[
          styles.chip,
          { backgroundColor: active ? glass.tint : theme.backgroundElement },
        ]}
        onPress={() => setFilter(key)}
        activeOpacity={0.7}
      >
        <ThemedText
          style={[styles.chipText, active ? styles.chipTextActive : { color: theme.textSecondary }]}
        >
          {label} {count}
        </ThemedText>
      </TouchableOpacity>
    );
  };

  const headerBtnStyle = [styles.headerBtn, { backgroundColor: theme.backgroundElement }];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.root}>
        <BlurView intensity={52} tint={blurTint} style={styles.panel}>
          <LinearGradient
            colors={glassGrad}
            locations={[0, 0.55, 1]}
            start={{ x: 0.85, y: 0 }}
            end={{ x: 0.15, y: 1 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />

          {/* Top bar */}
          <View style={[styles.topBar, { paddingTop: insets.top + 12 }]}>
            <TouchableOpacity style={headerBtnStyle} onPress={onClose} hitSlop={8} activeOpacity={0.6}>
              <SymbolView
                name={{ ios: 'xmark' as const, android: 'close' as const, web: 'close' as const }}
                size={13}
                tintColor={theme.textSecondary}
              />
            </TouchableOpacity>
            <ThemedText style={styles.title}>AI 了解我的</ThemedText>
            <TouchableOpacity style={headerBtnStyle} onPress={handleMenu} hitSlop={8} activeOpacity={0.6}>
              <SymbolView
                name={{ ios: 'ellipsis' as const, android: 'more_horiz' as const, web: 'more_horiz' as const }}
                size={15}
                tintColor={theme.textSecondary}
              />
            </TouchableOpacity>
          </View>

          {paused && (
            <View style={[styles.pausedBanner, { backgroundColor: 'rgba(255,159,10,0.14)' }]}>
              <SymbolView
                name={{ ios: 'pause.circle' as const, android: 'pause' as const, web: 'pause' as const }}
                size={14}
                tintColor="#FF9F0A"
              />
              <ThemedText style={styles.pausedText}>已暂停 · 新对话不会产生新记忆</ThemedText>
            </View>
          )}

          {loading ? (
            <View style={styles.centerState}>
              <ActivityIndicator color={glass.tint} />
            </View>
          ) : items.length === 0 ? (
            <View style={styles.emptyState}>
              <View style={[styles.emptyIconBadge, { backgroundColor: theme.backgroundElement }]}>
                <SymbolView
                  name={{ ios: 'brain.head.profile' as const, android: 'psychology' as const, web: 'psychology' as const }}
                  size={40}
                  tintColor={theme.textTertiary}
                />
              </View>
              <ThemedText style={styles.emptyTitle}>AI 还不了解你</ThemedText>
              <ThemedText themeColor="textSecondary" style={styles.emptyDesc}>
                多在聊天里告诉它你的喜好、习惯和禁忌吧
              </ThemedText>
            </View>
          ) : (
            <>
              {/* Filter chips */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.chipBar}
                contentContainerStyle={styles.chipBarContent}
              >
                {renderChip('all', '全部', items.length)}
                {BUCKETS.filter((b) => (counts.get(b.key) ?? 0) > 0).map((b) =>
                  renderChip(b.key, b.label, counts.get(b.key)!),
                )}
              </ScrollView>

              <FlatList
                data={visibleItems}
                keyExtractor={(item) => item.id}
                renderItem={renderRow}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
                ListFooterComponent={
                  <ThemedText themeColor="textTertiary" style={styles.hint}>
                    左滑任意一条可以删除
                  </ThemedText>
                }
              />
            </>
          )}

          <View style={[styles.panelBorder, { borderColor: glassStroke }]} pointerEvents="none" />
        </BlurView>
      </GestureHandlerRootView>
    </Modal>
  );
}

// ── Styles ──

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  panel: {
    flex: 1,
    overflow: 'hidden',
  },
  panelBorder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 0.5,
  },

  // Top bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },

  // Paused banner
  pausedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: Radius.sm,
  },
  pausedText: {
    fontSize: 13,
    color: '#FF9F0A',
  },

  // Filter chips
  chipBar: {
    flexGrow: 0,
    marginBottom: 4,
  },
  chipBarContent: {
    paddingHorizontal: 16,
    paddingVertical: 4,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: Radius.pill,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '500',
  },
  chipTextActive: {
    color: '#FFFFFF',
  },

  // Memory row
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginTop: 7,
  },
  rowBody: {
    flex: 1,
  },
  rowContent: {
    fontSize: 15,
    lineHeight: 21,
  },
  rowContentFading: {
    opacity: 0.55,
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 3,
  },
  rowMetaText: {
    fontSize: 12,
  },
  fadingPill: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: Radius.pill,
  },
  fadingPillText: {
    fontSize: 11,
  },

  // Swipe-to-delete action
  deleteAction: {
    width: 84,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    backgroundColor: '#FF3B30',
  },
  deleteActionText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },

  // Footer hint
  hint: {
    fontSize: 12,
    textAlign: 'center',
    paddingTop: 16,
  },

  // States
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyIconBadge: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 6,
  },
  emptyDesc: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
});
