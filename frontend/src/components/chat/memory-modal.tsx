// MemoryModal — 语义记忆管理中心（MEMORY_SPEC §9.4，T56）
// 复刻 SearchModal 的全屏玻璃 modal 模式：BlurView + LinearGradient + 顶栏三栏布局。

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  TouchableOpacity,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { SymbolView } from 'expo-symbols';
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
  title: string;
  emoji: string;
  count: number;
  items: MemoryItem[];
}

interface MemoryData {
  groups: MemoryGroup[];
  total: number;
  paused: boolean;
}

// ── Group config (T56 §3.7) ──

const GROUP_META: Record<string, { title: string; emoji: string }> = {
  constraint:    { title: '饮食禁忌', emoji: '🚫' },
  preference:    { title: '饮食偏好', emoji: '🌶' },
  habit:         { title: '生活习惯', emoji: '☕' },
  context_state: { title: '当前状态', emoji: '📍' },
  goal:          { title: '目标',     emoji: '🎯' },
};

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
  const accentColor = isDark ? '#0A84FF' : '#007AFF';

  const [data, setData] = useState<MemoryData | null>(null);
  const [loading, setLoading] = useState(true);

  // Reset state when modal opens → fetch data
  useEffect(() => {
    if (visible) {
      setLoading(true);
      setData(null);
      loadMemories();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const loadMemories = useCallback(async () => {
    if (!token) return;
    try {
      const res = await apiFetch<MemoryData>('/api/memory', { token });
      setData(res);
      onMemoryCountChange?.(res.total, res.paused);
    } catch {
      // Silently fail — user can close and retry
    } finally {
      setLoading(false);
    }
  }, [token, onMemoryCountChange]);

  // ── Delete single memory ──

  const handleDelete = useCallback(
    (item: MemoryItem) => {
      Alert.alert('删除这条记忆？', `"${item.content}" 将被移除。`, [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            if (!token) return;
            try {
              await apiFetch(`/api/memory/${item.id}`, { token, method: 'DELETE' });
              // Remove from local state
              setData((prev) => {
                if (!prev) return prev;
                const newGroups = prev.groups
                  .map((g) => ({
                    ...g,
                    items: g.items.filter((i) => i.id !== item.id),
                    count: g.items.filter((i) => i.id !== item.id).length,
                  }))
                  .filter((g) => g.count > 0);
                const newTotal = newGroups.reduce((s, g) => s + g.count, 0);
                onMemoryCountChange?.(newTotal, prev.paused);
                return { ...prev, groups: newGroups, total: newTotal };
              });
            } catch {
              Alert.alert('删除失败', '请重试');
            }
          },
        },
      ]);
    },
    [token, onMemoryCountChange],
  );

  // ── Toggle pause ──

  const handleTogglePause = useCallback(
    async (paused: boolean) => {
      if (!token) return;
      try {
        await apiFetch('/api/memory/pause', {
          token,
          method: 'POST',
          body: JSON.stringify({ paused }),
        });
        setData((prev) => (prev ? { ...prev, paused } : prev));
        onMemoryCountChange?.(data?.total ?? 0, paused);
      } catch {
        // Revert on failure
      }
    },
    [token, data?.total, onMemoryCountChange],
  );

  // ── Clear all ──

  const handleClearAll = useCallback(() => {
    Alert.alert(
      '清除所有记忆',
      '清除后 AI 将忘记所有关于你的信息，确定？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清除',
          style: 'destructive',
          onPress: async () => {
            if (!token) return;
            try {
              await apiFetch('/api/memory/clear', { token, method: 'DELETE' });
              setData({ groups: [], total: 0, paused: data?.paused ?? false });
              onMemoryCountChange?.(0, data?.paused ?? false);
            } catch {
              Alert.alert('清除失败', '请重试');
            }
          },
        },
      ],
    );
  }, [token, data?.paused, onMemoryCountChange]);

  // ── Render helpers ──

  const renderMemoryRow = (item: MemoryItem) => {
    const meta = GROUP_META[item.type] ?? { emoji: '📌', title: item.type };
    return (
      <View key={item.id} style={styles.memoryRow}>
        <View style={styles.memoryRowLeft}>
          <ThemedText style={styles.memoryEmoji}>{meta.emoji}</ThemedText>
          <View style={styles.memoryRowContent}>
            <ThemedText style={styles.memoryContent} numberOfLines={2}>
              {item.content}
            </ThemedText>
            <ThemedText themeColor="textTertiary" style={styles.memorySource}>
              {daysAgoStr(item.created_at)}
            </ThemedText>
          </View>
        </View>
        <TouchableOpacity
          style={styles.deleteBtn}
          onPress={() => handleDelete(item)}
          hitSlop={8}
          activeOpacity={0.5}
        >
          <SymbolView
            name={{ ios: 'xmark' as const, android: 'close' as const, web: 'close' as const }}
            size={16}
            tintColor={theme.textTertiary}
          />
        </TouchableOpacity>
      </View>
    );
  };

  const renderGroup = (group: MemoryGroup) => {
    const meta = GROUP_META[group.type] ?? { emoji: '📌', title: group.type };
    return (
      <View key={group.type} style={styles.groupSection}>
        <View style={styles.groupHeader}>
          <ThemedText style={styles.groupEmoji}>{meta.emoji}</ThemedText>
          <ThemedText style={styles.groupTitle}>
            {meta.title}
          </ThemedText>
          <ThemedText themeColor="textTertiary" style={styles.groupCount}>
            ({group.count})
          </ThemedText>
        </View>
        <View style={[styles.groupCard, { borderColor: theme.hairline }]}>
          {group.items.map(renderMemoryRow)}
        </View>
      </View>
    );
  };

  // ── Main render ──

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableOpacity
        style={styles.backdrop}
        activeOpacity={1}
        onPress={onClose}
      >
        <View
          style={styles.card}
          onStartShouldSetResponder={() => true}
        >
          <BlurView intensity={52} tint={blurTint} style={styles.cardInner}>
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
              <TouchableOpacity onPress={onClose} hitSlop={8}>
                <ThemedText style={[styles.cancelBtn, { color: glass.tint }]}>
                  取消
                </ThemedText>
              </TouchableOpacity>
              <ThemedText style={styles.title}>AI 了解我的</ThemedText>
              <View style={styles.cancelBtn} />
            </View>

            {/* Content */}
            {loading ? (
              <View style={styles.centerState}>
                <ActivityIndicator color={glass.tint} />
              </View>
            ) : data && data.total === 0 ? (
              /* Empty state */
              <View style={styles.emptyState}>
                <SymbolView
                  name={{ ios: 'brain.head.profile' as const, android: 'person' as const, web: 'brain' as const }}
                  size={48}
                  tintColor={theme.textTertiary}
                />
                <ThemedText style={styles.emptyTitle}>AI 还不了解你</ThemedText>
                <ThemedText themeColor="textSecondary" style={styles.emptyDesc}>
                  多在聊天里告诉它你的喜好、习惯和禁忌吧
                </ThemedText>
              </View>
            ) : (
              <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
              >
                {/* Memory groups */}
                {data?.groups.map(renderGroup)}

                {/* Pause toggle row */}
                <View style={[styles.toggleRow, { borderColor: theme.hairline }]}>
                  <ThemedText style={styles.toggleLabel}>暂停 AI 记忆</ThemedText>
                  <Switch
                    value={data?.paused ?? false}
                    onValueChange={handleTogglePause}
                    trackColor={{ false: 'rgba(128,128,128,0.3)', true: accentColor }}
                    thumbColor={Platform.OS === 'android' ? (isDark ? '#FFFFFF' : '#FFFFFF') : undefined}
                    ios_backgroundColor="rgba(128,128,128,0.3)"
                  />
                </View>

                {/* Clear all button */}
                <TouchableOpacity
                  style={styles.clearAllBtn}
                  onPress={handleClearAll}
                  activeOpacity={0.7}
                >
                  <ThemedText style={styles.clearAllText}>清除所有记忆</ThemedText>
                </TouchableOpacity>

                <View style={{ height: insets.bottom + 32 }} />
              </ScrollView>
            )}

            <View style={[styles.cardBorder, { borderColor: glassStroke }]} pointerEvents="none" />
          </BlurView>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

// ── Styles ──

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
  },
  card: {
    flex: 1,
  },
  cardInner: {
    flex: 1,
    overflow: 'hidden',
  },
  cardBorder: {
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
  cancelBtn: {
    fontSize: 16,
    width: 48,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },

  // States
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Empty state
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 6,
  },
  emptyDesc: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },

  // Scroll
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    gap: 18,
  },

  // Group
  groupSection: {
    gap: 8,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    gap: 6,
  },
  groupEmoji: {
    fontSize: 16,
  },
  groupTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  groupCount: {
    fontSize: 13,
  },

  // Group card
  groupCard: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },

  // Memory row
  memoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.12)',
  },
  memoryRowLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  memoryEmoji: {
    fontSize: 20,
    width: 28,
    textAlign: 'center',
  },
  memoryRowContent: {
    flex: 1,
  },
  memoryContent: {
    fontSize: 15,
    lineHeight: 20,
  },
  memorySource: {
    fontSize: 12,
    marginTop: 2,
  },
  deleteBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Toggle row
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    paddingHorizontal: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(128,128,128,0.12)',
  },
  toggleLabel: {
    fontSize: 15,
  },

  // Clear all
  clearAllBtn: {
    alignItems: 'center',
    paddingVertical: 14,
  },
  clearAllText: {
    fontSize: 15,
    fontWeight: '500',
    color: '#FF3B30',
  },
});
