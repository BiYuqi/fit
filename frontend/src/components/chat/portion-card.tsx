import { useState } from 'react';
import { StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { ThemedText } from '@/components/themed-text';
import { Colors, Glass, Radius } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import type { PortionCardPayload } from '@/types/chat';

const PORTION_LABEL: Record<string, string> = {
  small: '小份',
  medium: '中份',
  large: '大份',
  custom: '自定义克数',
};

export function PortionCard({
  payload,
  isResolved,
}: {
  payload: PortionCardPayload;
  isResolved: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [customGrams, setCustomGrams] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = Colors[isDark ? 'dark' : 'light'];
  const glass = Glass[isDark ? 'dark' : 'light'];
  const tint = glass.tint;
  const { resolve } = useChatStore();
  const { token } = useAuthStore();

  const handleChoice = (label: string) => {
    if (isResolved || !token) return;
    if (label === 'custom') {
      setSelected('custom');
      setShowCustom(true);
      return;
    }
    setSelected(label);
    resolve(payload.pending_id, label, token);
  };

  const handleCustomConfirm = () => {
    const grams = parseFloat(customGrams);
    if (isNaN(grams) || grams <= 0 || !token) return;
    resolve(payload.pending_id, { grams }, token);
  };

  const hasCustom = payload.portions.some(p => p.label === 'custom');
  const allPortions = hasCustom
    ? payload.portions
    : [...payload.portions, { label: 'custom', grams: 0 }];

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
        <ThemedText style={[styles.title, { color: colors.textSecondary }]}>
          {payload.food_name ? `「${payload.food_name}」大概多少？` : '这份大概是多少？'}
        </ThemedText>

        {isResolved ? (
          <ThemedText style={[styles.resolved, { color: colors.textSecondary }]}>已选择</ThemedText>
        ) : (
          <>
            {/* 2-column grid */}
            <View style={styles.grid}>
              {allPortions.map(p => {
                const isSelected = selected === p.label;
                const isCustom = p.label === 'custom';
                return (
                  <TouchableOpacity
                    key={p.label}
                    style={[
                      styles.option,
                      isCustom && styles.optionCustom,
                      {
                        borderColor: isSelected ? tint : 'rgba(60,60,67,0.08)',
                        borderWidth: isSelected ? 1.5 : StyleSheet.hairlineWidth,
                        backgroundColor: isSelected
                          ? tint + '14'
                          : isDark ? 'rgba(118,118,128,0.10)' : 'rgba(118,118,128,0.06)',
                      },
                    ]}
                    onPress={() => handleChoice(p.label)}
                    activeOpacity={0.7}>
                    <View style={styles.optionLabelRow}>
                      {isCustom && (
                        <SymbolView name="square.and.pencil" size={13} tintColor={isSelected ? tint : colors.textSecondary} />
                      )}
                      <ThemedText style={[styles.optionName, { color: isSelected ? tint : colors.text }]}>
                        {PORTION_LABEL[p.label] ?? p.label}
                      </ThemedText>
                      {isSelected && !isCustom && (
                        <SymbolView name="checkmark.circle.fill" size={15} tintColor={tint} style={styles.checkIcon} />
                      )}
                    </View>
                    {!isCustom && p.grams > 0 && (
                      <ThemedText style={[styles.optionDetail, { color: colors.textSecondary }]}>
                        ≈ {p.grams}g{p.calories ? ` · 约 ${p.calories} kcal` : ''}
                      </ThemedText>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>

            {showCustom && (
              <View style={styles.customRow}>
                <TextInput
                  style={[styles.customInput, { color: colors.text, borderColor: tint + '80', backgroundColor: isDark ? 'rgba(118,118,128,0.12)' : 'rgba(118,118,128,0.08)' }]}
                  placeholder="克数"
                  placeholderTextColor={colors.textSecondary}
                  keyboardType="numeric"
                  value={customGrams}
                  onChangeText={setCustomGrams}
                  autoFocus
                />
                <TouchableOpacity
                  style={[styles.confirmBtn, { backgroundColor: tint }]}
                  onPress={handleCustomConfirm}
                  activeOpacity={0.8}>
                  <ThemedText style={styles.confirmText}>确认</ThemedText>
                </TouchableOpacity>
              </View>
            )}
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
  title: {
    fontSize: 13,
    fontWeight: '500',
  },
  resolved: {
    fontSize: 13,
    fontStyle: 'italic',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  option: {
    width: '47%',
    borderRadius: Radius.md,
    padding: 12,
    gap: 4,
  },
  optionCustom: {
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 62,
  },
  optionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  optionName: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  checkIcon: {
    flexShrink: 0,
  },
  optionDetail: {
    fontSize: 11,
    lineHeight: 15,
  },
  customRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  customInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: Radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  confirmBtn: {
    borderRadius: Radius.sm,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  confirmText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
