// MemoryModal — 语义记忆管理中心（MEMORY_SPEC §9.4，T56）
// 复刻 SearchModal 的全屏玻璃 modal 模式：BlurView + LinearGradient + 顶栏三栏布局。
// 分组卡片视觉对齐 settings.tsx 的 GlassSectionCard 惯例（圆角18 + cardStroke描边 + 轻阴影）。

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
import { Glass } from '@/constants/theme';
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

  // Light nested-card shadow — distinct from Glass.shadow, which is tuned for
  // cards floating over the gradient background, not cards nested inside a
  // modal that's already blurred.
  const cardShadow = isDark
    ? { shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.28, shadowRadius: 18, elevation: 4 }
    : { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.06, shadowRadius: 14, elevation: 3 };
  const cardFill = { backgroundColor: glass.backgroundStrong, borderColor: glass.cardStroke };

  const [data, setData] = useState<MemoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleGroup = useCallback((type: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  // Reset state when modal opens → fetch data
  useEffect(() => {
    if (visible) {
      setLoading(true);
      setData(null);
      setCollapsed(new Set());
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

  const renderSectionHeader = (
    emoji: string,
    title: string,
    count?: number,
    toggle?: { collapsed: boolean; onPress: () => void },
  ) => {
    const content = (
      <>
        <ThemedText style={styles.groupEmoji}>{emoji}</ThemedText>
        <ThemedText themeColor="textSecondary" style={styles.groupTitle}>
          {title}
        </ThemedText>
        {count !== undefined && (
          <ThemedText themeColor="textTertiary" style={styles.groupCount}>
            · {count}
          </ThemedText>
        )}
        {toggle && (
          <>
            <View style={styles.groupHeaderSpacer} />
            <SymbolView
              name={{ ios: 'chevron.down' as const, android: 'expand_more' as const, web: 'expand_more' as const }}
              size={12}
              tintColor={theme.textTertiary}
              style={toggle.collapsed ? styles.chevronCollapsed : undefined}
            />
          </>
        )}
      </>
    );
    if (toggle) {
      return (
        <TouchableOpacity
          style={styles.groupHeader}
          onPress={toggle.onPress}
          activeOpacity={0.6}
          hitSlop={4}
        >
          {content}
        </TouchableOpacity>
      );
    }
    return <View style={styles.groupHeader}>{content}</View>;
  };

  const renderMemoryRow = (item: MemoryItem, isLast: boolean) => {
    return (
      <View
        key={item.id}
        style={[
          styles.memoryRow,
          !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.hairline },
        ]}
      >
        <View style={styles.memoryRowContent}>
          <ThemedText style={styles.memoryContent} numberOfLines={2}>
            {item.content}
          </ThemedText>
          <ThemedText themeColor="textTertiary" style={styles.memorySource}>
            {daysAgoStr(item.created_at)}
          </ThemedText>
        </View>
        <TouchableOpacity
          style={styles.deleteBtn}
          onPress={() => handleDelete(item)}
          hitSlop={8}
          activeOpacity={0.5}
        >
          <SymbolView
            name={{ ios: 'xmark' as const, android: 'close' as const, web: 'close' as const }}
            size={13}
            tintColor={theme.textTertiary}
          />
        </TouchableOpacity>
      </View>
    );
  };

  const renderGroup = (group: MemoryGroup) => {
    const meta = GROUP_META[group.type] ?? { emoji: '📌', title: group.type };
    const isCollapsed = collapsed.has(group.type);
    return (
      <View key={group.type} style={styles.groupSection}>
        {renderSectionHeader(meta.emoji, meta.title, group.count, {
          collapsed: isCollapsed,
          onPress: () => toggleGroup(group.type),
        })}
        {!isCollapsed && (
          <View style={[styles.groupCard, cardShadow, cardFill]}>
            {group.items.map((item, index) => renderMemoryRow(item, index === group.items.length - 1))}
          </View>
        )}
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
                <View style={[styles.emptyIconBadge, { backgroundColor: theme.backgroundElement }]}>
                  <SymbolView
                    name={{ ios: 'brain.head.profile' as const, android: 'person' as const, web: 'brain' as const }}
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
              <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
              >
                {/* Memory groups */}
                {data?.groups.map(renderGroup)}

                {/* Manage section: pause toggle + clear all, styled as its own card */}
                <View style={styles.groupSection}>
                  {renderSectionHeader('⚙️', '管理')}
                  <View style={[styles.groupCard, cardShadow, cardFill]}>
                    <View
                      style={[
                        styles.toggleRow,
                        { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.hairline },
                      ]}
                    >
                      <ThemedText style={styles.toggleLabel}>暂停 AI 记忆</ThemedText>
                      <Switch
                        value={data?.paused ?? false}
                        onValueChange={handleTogglePause}
                        trackColor={{ false: 'rgba(128,128,128,0.3)', true: glass.tint }}
                        thumbColor={Platform.OS === 'android' ? '#FFFFFF' : undefined}
                        ios_backgroundColor="rgba(128,128,128,0.3)"
                      />
                    </View>
                    <TouchableOpacity
                      style={styles.clearAllBtn}
                      onPress={handleClearAll}
                      activeOpacity={0.6}
                    >
                      <SymbolView
                        name={{ ios: 'trash' as const, android: 'delete' as const, web: 'delete' as const }}
                        size={15}
                        tintColor="#FF3B30"
                      />
                      <ThemedText style={styles.clearAllText}>清除所有记忆</ThemedText>
                    </TouchableOpacity>
                  </View>
                </View>

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

  // Scroll
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    gap: 20,
  },

  // Group section header — aligned with settings.tsx SectionHeader convention
  groupSection: {
    gap: 8,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 4,
    gap: 6,
  },
  groupHeaderSpacer: {
    flex: 1,
  },
  chevronCollapsed: {
    transform: [{ rotate: '-90deg' }],
  },
  groupEmoji: {
    fontSize: 14,
  },
  groupTitle: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  groupCount: {
    fontSize: 12,
  },

  // Group card — radius 18 to match GlassSectionCard in settings.tsx
  groupCard: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },

  // Memory row
  memoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
    paddingHorizontal: 14,
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
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Toggle row (inside manage card)
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  toggleLabel: {
    fontSize: 15,
  },

  // Clear all (inside manage card)
  clearAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 13,
  },
  clearAllText: {
    fontSize: 15,
    fontWeight: '500',
    color: '#FF3B30',
  },
});
