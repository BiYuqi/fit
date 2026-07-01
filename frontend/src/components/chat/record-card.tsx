import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { GlassCard } from '@/components/glass-card';
import { ThemedText } from '@/components/themed-text';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import type { RecordCardPayload } from '@/types/chat';

const MEAL_LABEL: Record<string, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};

const MACRO_DOTS = {
  protein: '#30D158',  // green
  fat: '#FF9F0A',      // orange
  carbs: '#0A84FF',    // blue
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
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = Colors[isDark ? 'dark' : 'light'];
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
      <GlassCard padding={12} gap={8} style={[styles.card, isUndone && styles.cardUndone]}>
        {/* badge */}
        <View style={styles.badgeRow}>
          <SymbolView name="checkmark.circle.fill" size={13} tintColor={MACRO_DOTS.protein} />
          <ThemedText style={[styles.badgeText, { color: MACRO_DOTS.protein }]}>已录入</ThemedText>
        </View>

        {/* Food name + calories row */}
        <View style={styles.mainRow}>
          <View style={styles.nameBlock}>
            <ThemedText style={[styles.foodName, { color: colors.text }]} numberOfLines={2}>
              {payload.food_name}
            </ThemedText>
            <ThemedText style={[styles.mealInfo, { color: colors.textSecondary }]}>
              {meal} · {payload.weight_g}g
            </ThemedText>
          </View>
          <View style={styles.calorieBlock}>
            <ThemedText style={[styles.calorieNum, { color: colors.text }]}>
              {payload.calories}
            </ThemedText>
            <ThemedText style={[styles.calorieUnit, { color: colors.textSecondary }]}>kcal</ThemedText>
          </View>
        </View>

        {/* Divider */}
        <View style={[styles.divider, { backgroundColor: colors.hairline }]} />

        {/* Macros */}
        <View style={styles.macros}>
          <MacroItem label="蛋白" value={payload.protein_g} color={MACRO_DOTS.protein} />
          <MacroItem label="脂肪" value={payload.fat_g} color={MACRO_DOTS.fat} />
          <MacroItem label="碳水" value={payload.carbs_g} color={MACRO_DOTS.carbs} />
        </View>

        {/* 撤销（modify 的 update/append 直执行时） */}
        {undoInfo && (
          <>
            <View style={[styles.divider, { backgroundColor: colors.hairline }]} />
            {isUndone ? (
              <ThemedText style={[styles.undoneText, { color: colors.textSecondary }]}>已撤销</ThemedText>
            ) : (
              <TouchableOpacity style={styles.undoRow} onPress={handleUndo} activeOpacity={0.6}>
                <SymbolView name="arrow.uturn.backward" size={12} tintColor={colors.textSecondary} />
                <ThemedText style={[styles.undoText, { color: colors.textSecondary }]}>撤销</ThemedText>
              </TouchableOpacity>
            )}
          </>
        )}
      </GlassCard>
    </View>
  );
}

function MacroItem({ label, value, color }: { label: string; value: number; color: string }) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = Colors[isDark ? 'dark' : 'light'];
  return (
    <View style={styles.macroItem}>
      <View style={styles.macroHeader}>
        <View style={[styles.macroDot, { backgroundColor: color }]} />
        <ThemedText style={[styles.macroLabel, { color: colors.textSecondary }]}>{label}</ThemedText>
      </View>
      <ThemedText style={[styles.macroValue, { color: colors.text }]}>{value}g</ThemedText>
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
  undoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    paddingVertical: 2,
  },
  undoText: {
    fontSize: 13,
    fontWeight: '500',
  },
  undoneText: {
    fontSize: 12,
    fontStyle: 'italic',
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  nameBlock: {
    flex: 1,
    gap: 3,
  },
  foodName: {
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 22,
  },
  mealInfo: {
    fontSize: 13,
  },
  calorieBlock: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 2,
  },
  calorieNum: {
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 32,
  },
  calorieUnit: {
    fontSize: 13,
    fontWeight: '500',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  macros: {
    flexDirection: 'row',
    gap: 24,
  },
  macroItem: {
    gap: 2,
  },
  macroHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  macroDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  macroLabel: {
    fontSize: 12,
  },
  macroValue: {
    fontSize: 15,
    fontWeight: '600',
  },
});
