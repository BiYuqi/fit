import { StyleSheet, View } from 'react-native';
import { GlassCard } from '@/components/glass-card';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import type { ExerciseCardPayload } from '@/types/chat';

export function ExerciseCard({ payload }: { payload: ExerciseCardPayload }) {
  const theme = useTheme();
  return (
    <View style={styles.wrapper}>
      <GlassCard style={styles.card}>
        <View style={styles.row}>
          <ThemedText style={styles.icon}>🏃</ThemedText>
          <View style={styles.info}>
            <ThemedText style={styles.type}>
              {payload.type} · {payload.duration_min}min
            </ThemedText>
            <ThemedText style={[styles.calories, { color: theme.textSecondary }]}>
              消耗约 {payload.calories_burned} kcal
            </ThemedText>
          </View>
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
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  icon: {
    fontSize: 24,
  },
  info: {
    gap: 2,
  },
  type: {
    fontSize: 15,
    fontWeight: '600',
  },
  calories: {
    fontSize: 13,
  },
});
