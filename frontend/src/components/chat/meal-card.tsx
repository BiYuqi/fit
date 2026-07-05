import { useState } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { GlassCard } from '@/components/glass-card';
import { ThemedText } from '@/components/themed-text';
import { FontSize, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import type { MealCardPayload, UndoPrevState } from '@/types/chat';

const MEAL_LABEL: Record<string, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};

const MACRO_COLORS = {
  protein: '#30D158',
  fat: '#FF9F0A',
  carbs: '#0A84FF',
};

export function MealCard({
  payload,
}: {
  payload: MealCardPayload;
  messageId?: string; // 父组件仍传，T53 后组件内不再用（撤销态按 record_id）
}) {
  const colors = useTheme();
  const [expanded, setExpanded] = useState(true);
  const { undo, undoneRecords } = useChatStore();
  const { token } = useAuthStore();

  const meal = MEAL_LABEL[payload.meal_key?.meal_type ?? ''] ?? '';
  const isEmpty = payload.items.length === 0;
  // T53：项级撤销——按 record_id 存多条，批量改的每条各自独立可撤销。
  // 读兼容 T53 前的单槽 last_change（历史卡）：包成单元素数组。
  const lastChanges =
    payload.last_changes ?? (payload.last_change ? [payload.last_change] : []);

  const handleUndo = (recordId: string, prevState?: UndoPrevState) => {
    if (undoneRecords[recordId] || !token) return;
    undo(recordId, prevState, token);
  };

  return (
    <View style={styles.wrapper}>
      <GlassCard padding={10} gap={6} style={[styles.card, isEmpty && styles.cardEmpty]}>
        <TouchableOpacity
          style={styles.headerRow}
          onPress={() => setExpanded((e) => !e)}
          activeOpacity={0.7}
          disabled={isEmpty}
        >
          <SymbolView
            name="checkmark.circle.fill"
            size={12}
            tintColor={MACRO_COLORS.protein}
            style={styles.badgeIcon}
          />
          <ThemedText style={styles.headerText} numberOfLines={1}>
            {meal ? `${meal} · ` : ''}
            {payload.item_count} 项
          </ThemedText>
          <View style={styles.calBlock}>
            <ThemedText style={styles.calNum}>{payload.totals.calories}</ThemedText>
            <ThemedText themeColor="textSecondary" style={styles.calUnit}>
              kcal
            </ThemedText>
          </View>
        </TouchableOpacity>

        {isEmpty ? (
          <ThemedText themeColor="textSecondary" style={styles.emptyText}>
            已清空
          </ThemedText>
        ) : (
          <>
            {expanded &&
              payload.items.map((item) => {
                const itemChange = lastChanges.find((c) => c.record_id === item.record_id);
                const showUndo = !!itemChange;
                const itemUndone = showUndo && !!undoneRecords[item.record_id];
                // 主显示（T52）：有可数份数 → `食物名 ×N（Ng）`；否则 `食物名 Ng`
                const itemLabel =
                  item.count != null
                    ? `${item.food_name} ×${item.count}（${item.weight_g}g）`
                    : `${item.food_name} ${item.weight_g}g`;
                return (
                  <View
                    key={item.record_id}
                    style={[styles.itemRow, itemUndone && styles.itemUndone]}
                  >
                    <ThemedText style={styles.itemName} numberOfLines={1}>
                      {itemLabel}
                      {item.is_estimated && (
                        <ThemedText themeColor="textSecondary" style={styles.estBadge}>
                          {' '}
                          估
                        </ThemedText>
                      )}
                    </ThemedText>
                    <View style={styles.itemRight}>
                      <ThemedText style={styles.itemCal}>{item.calories}</ThemedText>
                      {showUndo &&
                        (itemUndone ? (
                          <ThemedText themeColor="textSecondary" style={styles.undoneLabel}>
                            已撤销
                          </ThemedText>
                        ) : (
                          <TouchableOpacity
                            style={styles.undoBtn}
                            onPress={() => handleUndo(item.record_id, itemChange?.prev_state)}
                            activeOpacity={0.6}
                          >
                            <SymbolView
                              name="arrow.uturn.backward"
                              size={11}
                              tintColor={colors.textSecondary}
                            />
                            <ThemedText themeColor="textSecondary" style={styles.undoLabel}>
                              撤销
                            </ThemedText>
                          </TouchableOpacity>
                        ))}
                    </View>
                  </View>
                );
              })}

            <View style={styles.macrosRow}>
              <MacroInline label="蛋白" value={payload.totals.protein_g} color={MACRO_COLORS.protein} />
              <MacroInline label="脂肪" value={payload.totals.fat_g} color={MACRO_COLORS.fat} />
              <MacroInline label="碳水" value={payload.totals.carbs_g} color={MACRO_COLORS.carbs} />
            </View>
          </>
        )}
      </GlassCard>
    </View>
  );
}

/** Inline macro: `● 蛋白 35g` — label + value on same line, dot for colour. */
function MacroInline({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={styles.macroItem}>
      <View style={[styles.macroDot, { backgroundColor: color }]} />
      <ThemedText style={styles.macroText}>
        {label} {value}g
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginVertical: 6,
    alignItems: 'flex-start',
  },
  card: {
    width: '90%' as any,
  },
  cardEmpty: {
    opacity: 0.55,
  },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  badgeIcon: {
    marginTop: 1,
  },
  headerText: {
    flex: 1,
    fontSize: FontSize.base,
    fontWeight: '500',
  },
  calBlock: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    marginLeft: Spacing.one,
  },
  calNum: {
    fontSize: 22,
    fontWeight: '700',
  },
  calUnit: {
    fontSize: 12,
  },

  emptyText: {
    fontSize: FontSize.sm,
    fontStyle: 'italic',
  },

  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.one,
  },
  itemUndone: {
    opacity: 0.55,
  },
  itemName: {
    flex: 1,
    fontSize: FontSize.sm,
  },
  estBadge: {
    fontSize: 11,
  },
  itemRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    flexShrink: 0,
  },
  itemCal: {
    fontSize: FontSize.sm,
    fontVariant: ['tabular-nums'],
  },

  macrosRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  macroItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  macroDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  macroText: {
    fontSize: 12,
  },

  undoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  undoLabel: {
    fontSize: 12,
  },
  undoneLabel: {
    fontSize: 12,
    fontStyle: 'italic',
  },
});
