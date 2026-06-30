import { SafeAreaView } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native';

import { GlassCard } from '@/components/glass-card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Spacing } from '@/constants/theme';

export default function HistoryScreen() {
  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <ThemedText type="title">历史</ThemedText>
        <GlassCard style={styles.card}>
          <ThemedText type="subtitle">趋势</ThemedText>
          <ThemedText themeColor="textSecondary">日/周/月缺口与营养趋势</ThemedText>
        </GlassCard>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  safe: {
    flex: 1,
    padding: Spacing.four,
    gap: Spacing.three,
    paddingBottom: BottomTabInset + Spacing.three,
  },
  card: { gap: Spacing.two },
});
