import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { GlassCard } from '@/components/glass-card';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import type { RecordCardPayload } from '@/types/chat';

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

export function RecordCard({
  payload,
  mealType,
  messageId,
}: {
  payload: RecordCardPayload;
  mealType?: string;
  messageId: string;
}) {
  const colors = useTheme();
  const meal = MEAL_LABEL[mealType ?? ''] ?? '加餐';

  const { undo, undoneCards } = useChatStore();
  const { token } = useAuthStore();
  const undoInfo = payload.undo;
  const isUndone = !!(undoInfo && undoneCards[messageId]);

  const handleUndo = () => {
    if (!undoInfo || isUndone || !token) return;
    undo(messageId, undoInfo.record_id, undoInfo.prev_state, token);
  };

  return (
    <View style={styles.wrapper}>
      <GlassCard padding={10} gap={5} style={[styles.card, isUndone && styles.cardUndone]}>
        {/* Row 1: badge icon + food name / meta + calorie number */}
        <View style={styles.row1}>
          <SymbolView
            name="checkmark.circle.fill"
            size={12}
            tintColor={MACRO_COLORS.protein}
            style={styles.badgeIcon}
          />
          <ThemedText style={styles.foodLine} numberOfLines={1}>
            {payload.food_name}{' '}
            <ThemedText themeColor="textSecondary" style={styles.foodMeta}>
              {meal} · {payload.weight_g}g
            </ThemedText>
          </ThemedText>
          <View style={styles.calBlock}>
            <ThemedText style={styles.calNum}>{payload.calories}</ThemedText>
            <ThemedText themeColor="textSecondary" style={styles.calUnit}>
              kcal
            </ThemedText>
          </View>
        </View>

        {/* Row 2: macros inline + optional undo */}
        <View style={styles.row2}>
          <View style={styles.macrosInline}>
            <MacroInline label="蛋白" value={payload.protein_g} color={MACRO_COLORS.protein} />
            <MacroInline label="脂肪" value={payload.fat_g} color={MACRO_COLORS.fat} />
            <MacroInline label="碳水" value={payload.carbs_g} color={MACRO_COLORS.carbs} />
          </View>
          {undoInfo &&
            (isUndone ? (
              <ThemedText themeColor="textSecondary" style={styles.undoneLabel}>
                已撤销
              </ThemedText>
            ) : (
              <TouchableOpacity style={styles.undoBtn} onPress={handleUndo} activeOpacity={0.6}>
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
      </GlassCard>
    </View>
  );
}

/** Inline macro: `● 蛋白 35g` — label + value on same line, dot for colour. */
function MacroInline({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
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
  cardUndone: {
    opacity: 0.55,
  },

  // ── Row 1 ──
  row1: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  badgeIcon: {
    marginTop: 1,
  },
  foodLine: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
  },
  foodMeta: {
    fontSize: 13,
  },
  calBlock: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    marginLeft: 4,
  },
  calNum: {
    fontSize: 22,
    fontWeight: '700',
  },
  calUnit: {
    fontSize: 12,
  },

  // ── Row 2 ──
  row2: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  macrosInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  macroItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  macroDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  macroText: {
    fontSize: 12,
  },

  // ── Undo ──
  undoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingLeft: 8,
  },
  undoLabel: {
    fontSize: 12,
  },
  undoneLabel: {
    fontSize: 12,
    fontStyle: 'italic',
  },
});
