import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { Colors, Glass, Radius } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import type { CandidateCardPayload } from '@/types/chat';

export function CandidateCard({
  payload,
  isResolved,
}: {
  payload: CandidateCardPayload;
  isResolved: boolean;
}) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = Colors[isDark ? 'dark' : 'light'];
  const glass = Glass[isDark ? 'dark' : 'light'];
  const tint = glass.tint;
  const { resolve } = useChatStore();
  const { token } = useAuthStore();

  const handleChoice = (foodId: string) => {
    if (isResolved || !token) return;
    resolve(payload.pending_id, foodId, token);
  };

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
        {/* Title */}
        <ThemedText style={[styles.title, { color: colors.textSecondary }]}>
          你可能吃的是？
        </ThemedText>

        {isResolved ? (
          <ThemedText style={[styles.resolved, { color: colors.textSecondary }]}>已选择</ThemedText>
        ) : (
          <View style={styles.chips}>
            {payload.foods.slice(0, 4).map((food, idx) => {
              const isFirst = idx === 0;
              return (
                <TouchableOpacity
                  key={food.id}
                  style={[
                    styles.chip,
                    isFirst
                      ? { backgroundColor: tint }
                      : { backgroundColor: isDark ? 'rgba(118,118,128,0.24)' : 'rgba(118,118,128,0.12)' },
                  ]}
                  onPress={() => handleChoice(food.id)}
                  activeOpacity={0.75}>
                  <ThemedText style={[styles.chipText, { color: isFirst ? '#fff' : colors.text }]}>
                    {food.name}
                  </ThemedText>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity
              style={[styles.chip, { backgroundColor: isDark ? 'rgba(118,118,128,0.24)' : 'rgba(118,118,128,0.12)' }]}
              onPress={() => {}}
              activeOpacity={0.75}>
              <ThemedText style={[styles.chipText, { color: colors.text }]}>其他</ThemedText>
            </TouchableOpacity>
          </View>
        )}

        {!isResolved && (
          <ThemedText style={[styles.hint, { color: colors.textSecondary }]}>
            选一个，方便我算得更准
          </ThemedText>
        )}
      </View>
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
    padding: 16,
    gap: 12,
    width: '90%' as any,
  },
  title: {
    fontSize: 13,
    fontWeight: '500',
  },
  resolved: {
    fontSize: 13,
    fontStyle: 'italic',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderRadius: Radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipText: {
    fontSize: 14,
    fontWeight: '500',
  },
  hint: {
    fontSize: 12,
  },
});
