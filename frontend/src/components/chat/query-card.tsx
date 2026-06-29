import { StyleSheet, View } from 'react-native';
import { GlassCard } from '@/components/glass-card';
import { ThemedText } from '@/components/themed-text';
import { Glass } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';
import type { ContextCard } from '@/types/chat';

function ProgressBar({ ratio, tint }: { ratio: number; tint: string }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <View style={styles.trackOuter}>
      <View style={[styles.trackFill, { width: `${clamped * 100}%` as any, backgroundColor: tint }]} />
    </View>
  );
}

export function QueryCard({
  content,
  payload,
}: {
  content?: string | null;
  payload: ContextCard;
}) {
  const scheme = useColorScheme();
  const theme = useTheme();
  const tint = Glass[scheme === 'dark' ? 'dark' : 'light'].tint;
  const { today, targets } = payload;
  const ratio = targets.calories > 0 ? today.in / targets.calories : 0;
  const remaining = Math.max(0, today.remaining);

  return (
    <View style={styles.wrapper}>
      <GlassCard style={styles.card}>
        {content ? (
          <ThemedText style={styles.answer}>{content}</ThemedText>
        ) : null}
        <View style={styles.statsRow}>
          <ThemedText style={[styles.statsLabel, { color: theme.textSecondary }]}>今日摄入</ThemedText>
          <ThemedText style={styles.statsValue}>
            {today.in}
            <ThemedText style={[styles.statsMax, { color: theme.textSecondary }]}>
              {' '}/ {targets.calories} kcal
            </ThemedText>
          </ThemedText>
        </View>
        <ProgressBar ratio={ratio} tint={tint} />
        <ThemedText style={[styles.remaining, { color: tint }]}>
          还可以吃 {remaining} kcal
        </ThemedText>
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
    maxWidth: '90%',
    gap: 8,
  },
  answer: {
    fontSize: 14,
    lineHeight: 21,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  statsLabel: {
    fontSize: 13,
  },
  statsValue: {
    fontSize: 16,
    fontWeight: '700',
  },
  statsMax: {
    fontWeight: '400',
    fontSize: 13,
  },
  trackOuter: {
    height: 6,
    backgroundColor: 'rgba(128,128,128,0.2)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  trackFill: {
    height: '100%',
    borderRadius: 3,
  },
  remaining: {
    fontSize: 13,
    fontWeight: '500',
  },
});
