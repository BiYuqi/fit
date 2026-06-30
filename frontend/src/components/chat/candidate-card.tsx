import { useState } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
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
  const [selected, setSelected] = useState<string | null>(null);
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = Colors[isDark ? 'dark' : 'light'];
  const glass = Glass[isDark ? 'dark' : 'light'];
  const tint = glass.tint;
  const { resolve } = useChatStore();
  const { token } = useAuthStore();

  const handleChoice = (foodName: string) => {
    if (isResolved || selected || !token) return;
    setSelected(foodName);
    resolve(payload.pending_id, foodName, token);
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
        <View style={styles.titleRow}>
          <SymbolView name="magnifyingglass" size={13} tintColor={colors.textSecondary} />
          <ThemedText style={[styles.title, { color: colors.textSecondary }]}>
            你可能吃的是？
          </ThemedText>
        </View>

        {isResolved ? (
          <ThemedText style={[styles.resolved, { color: colors.textSecondary }]}>已选择</ThemedText>
        ) : (
          <>
            <View style={styles.chips}>
              {payload.foods.slice(0, 4).map((food) => {
                const isSelected = selected === food.name;
                return (
                  <TouchableOpacity
                    key={food.name}
                    style={[
                      styles.chip,
                      isSelected
                        ? { backgroundColor: tint }
                        : { backgroundColor: isDark ? 'rgba(118,118,128,0.24)' : 'rgba(118,118,128,0.12)' },
                    ]}
                    onPress={() => handleChoice(food.name)}
                    activeOpacity={0.75}>
                    {isSelected && (
                      <SymbolView name="checkmark.circle.fill" size={14} tintColor="#fff" style={styles.checkIcon} />
                    )}
                    <ThemedText style={[styles.chipName, { color: isSelected ? '#fff' : colors.text }]}>
                      {food.name}
                    </ThemedText>
                    {food.calorie_hint != null && (
                      <ThemedText style={[styles.chipCal, { color: isSelected ? 'rgba(255,255,255,0.75)' : colors.textSecondary }]}>
                        ≈{food.calorie_hint}kcal
                      </ThemedText>
                    )}
                  </TouchableOpacity>
                );
              })}
              {/* 其他 */}
              <TouchableOpacity
                style={[styles.chip, { backgroundColor: isDark ? 'rgba(118,118,128,0.24)' : 'rgba(118,118,128,0.12)' }]}
                activeOpacity={0.75}>
                <SymbolView name="pencil" size={12} tintColor={colors.textSecondary} />
                <ThemedText style={[styles.chipName, { color: colors.text }]}>其他描述</ThemedText>
              </TouchableOpacity>
            </View>

            <ThemedText style={[styles.hint, { color: colors.textSecondary }]}>
              选一个，方便我算得更准
            </ThemedText>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: 16,
    marginVertical: 6,
  },
  card: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 12,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  checkIcon: {
    flexShrink: 0,
  },
  chipName: {
    fontSize: 14,
    fontWeight: '500',
  },
  chipCal: {
    fontSize: 11,
  },
  hint: {
    fontSize: 12,
  },
});
