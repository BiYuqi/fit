import { StyleSheet, View } from 'react-native';
import { GlassCard } from '@/components/glass-card';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import type { RecordCardPayload } from '@/types/chat';

const MEAL_LABEL: Record<string, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};

function MacroItem({ label, value }: { label: string; value: number }) {
  const theme = useTheme();
  return (
    <View style={styles.macroItem}>
      <ThemedText style={[styles.macroValue, { color: theme.text }]}>{value}g</ThemedText>
      <ThemedText style={[styles.macroLabel, { color: theme.textSecondary }]}>{label}</ThemedText>
    </View>
  );
}

export function RecordCard({
  payload,
  mealType,
}: {
  payload: RecordCardPayload;
  mealType?: string;
}) {
  const theme = useTheme();
  const meal = MEAL_LABEL[mealType ?? ''] ?? '加餐';

  return (
    <View style={styles.wrapper}>
      <GlassCard style={styles.card}>
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <ThemedText style={styles.foodName}>{payload.food_name}</ThemedText>
            {payload.is_estimated && (
              <ThemedText style={[styles.badge, { color: theme.textSecondary }]}>估算</ThemedText>
            )}
          </View>
          <ThemedText style={[styles.calories, { color: theme.text }]}>
            {payload.calories} kcal
          </ThemedText>
        </View>
        <ThemedText style={[styles.sub, { color: theme.textSecondary }]}>
          {meal} · {payload.weight_g}g
        </ThemedText>
        <View style={[styles.divider, { backgroundColor: theme.textSecondary + '30' }]} />
        <View style={styles.macros}>
          <MacroItem label="蛋白" value={payload.protein_g} />
          <MacroItem label="脂肪" value={payload.fat_g} />
          <MacroItem label="碳水" value={payload.carbs_g} />
        </View>
      </GlassCard>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: 16,
    marginVertical: 4,
    alignItems: 'flex-start',
  },
  card: {
    maxWidth: '84%',
    gap: 6,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  foodName: {
    fontSize: 16,
    fontWeight: '600',
    flexShrink: 1,
  },
  badge: {
    fontSize: 11,
    borderWidth: 1,
    borderColor: 'currentColor',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  calories: {
    fontSize: 16,
    fontWeight: '700',
  },
  sub: {
    fontSize: 13,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 4,
  },
  macros: {
    flexDirection: 'row',
    gap: 16,
  },
  macroItem: {
    alignItems: 'center',
  },
  macroValue: {
    fontSize: 14,
    fontWeight: '600',
  },
  macroLabel: {
    fontSize: 12,
  },
});
