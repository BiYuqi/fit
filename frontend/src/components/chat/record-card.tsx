import { StyleSheet, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { ThemedText } from '@/components/themed-text';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors, Glass, Radius } from '@/constants/theme';
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
}: {
  payload: RecordCardPayload;
  mealType?: string;
}) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = Colors[isDark ? 'dark' : 'light'];
  const glass = Glass[isDark ? 'dark' : 'light'];
  const meal = MEAL_LABEL[mealType ?? ''] ?? '加餐';

  return (
    <View style={styles.wrapper}>
      <View style={[
        styles.card,
        {
          backgroundColor: isDark ? 'rgba(44,44,48,0.92)' : '#FFFFFF',
          borderColor: glass.border,
          ...glass.shadow,
        },
      ]}>
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
      </View>
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
    paddingHorizontal: 16,
    marginVertical: 6,
    alignItems: 'flex-start',
  },
  card: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 8,
    width: '90%' as any,
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
