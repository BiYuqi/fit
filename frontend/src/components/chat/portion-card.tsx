import { useState } from 'react';
import { StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { GlassCard } from '@/components/glass-card';
import { ThemedText } from '@/components/themed-text';
import { Colors, FontSize, Glass, Radius, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import type { PortionCardPayload } from '@/types/chat';

const PORTION_LABEL: Record<string, string> = {
  small: '小份',
  medium: '中份',
  large: '大份',
  custom: '自定义',
};

/** Pending cards older than 5 min are non-interactive */
const STALE_MS = 5 * 60 * 1000;

export function PortionCard({
  payload,
  isResolved,
  createdAt,
}: {
  payload: PortionCardPayload;
  isResolved: boolean;
  createdAt: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [customGrams, setCustomGrams] = useState('');
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = Colors[isDark ? 'dark' : 'light'];
  const glass = Glass[isDark ? 'dark' : 'light'];
  const tint = glass.tint;
  const { resolve } = useChatStore();
  const { token } = useAuthStore();

  const isStale = Date.now() - new Date(createdAt).getTime() > STALE_MS;
  const disabled = isResolved || isStale;

  const handleChoice = (label: string) => {
    if (disabled || !token) return;
    setSelected(label);
    if (label !== 'custom') {
      resolve(payload.pending_id, label, token);
    }
  };

  const handleCustomConfirm = () => {
    const grams = parseFloat(customGrams);
    if (isNaN(grams) || grams <= 0 || !token) return;
    resolve(payload.pending_id, { grams }, token);
  };

  const handleCustomCancel = () => {
    setSelected(null);
    setCustomGrams('');
  };

  const resolvedLabel = (() => {
    if (isStale) return '已过期';
    const portion = selected ? payload.portions.find(p => p.label === selected) : null;
    if (selected === 'custom') {
      const g = parseFloat(customGrams);
      if (!isNaN(g) && g > 0) return `已选 ${g}g`;
      return '已选择';
    }
    if (portion && portion.grams > 0) return `已选中份 ≈ ${portion.grams}g`;
    return '已选择';
  })();

  const hasCustom = payload.portions.some(p => p.label === 'custom');
  const allPortions = hasCustom
    ? payload.portions
    : [...payload.portions, { label: 'custom', grams: 0 }];

  return (
    <View style={styles.wrapper}>
      <GlassCard
        padding={isResolved || isStale ? 10 : 10}
        gap={isResolved || isStale ? 5 : 8}
        style={styles.card}
      >
        <ThemedText style={[styles.title, { color: colors.textSecondary }]}>
          {payload.food_name ? `「${payload.food_name}」大概多少？` : '这份大概是多少？'}
        </ThemedText>

        {disabled ? (
          <ThemedText style={[styles.resolved, { color: colors.textSecondary }]}>{resolvedLabel}</ThemedText>
        ) : (
          <>
            {/* 2×2 grid */}
            <View style={styles.grid}>
              {allPortions.map((p, i) => {
                const isSelected = selected === p.label;
                const isCustom = p.label === 'custom';
                const isLastOdd = i === allPortions.length - 1 && allPortions.length % 2 !== 0;
                return (
                  <TouchableOpacity
                    key={p.label}
                    style={[
                      styles.option,
                      isLastOdd && styles.optionFull,
                      isSelected
                        ? { backgroundColor: tint }
                        : { backgroundColor: isDark ? 'rgba(118,118,128,0.16)' : 'rgba(118,118,128,0.08)' },
                    ]}
                    onPress={() => handleChoice(p.label)}
                    activeOpacity={0.75}>
                    <View style={styles.optionRow}>
                      {isSelected && !isCustom && (
                        <SymbolView name="checkmark" size={11} weight="bold" tintColor="#fff" />
                      )}
                      {isCustom && !isSelected && (
                        <SymbolView name="square.and.pencil" size={11} tintColor={colors.textSecondary} />
                      )}
                      <ThemedText style={[styles.optionLabel, { color: isSelected ? '#fff' : colors.text }]}>
                        {PORTION_LABEL[p.label] ?? p.label}
                      </ThemedText>
                    </View>
                    {!isCustom && p.grams > 0 && (
                      <ThemedText style={[styles.optionHint, { color: isSelected ? 'rgba(255,255,255,0.70)' : colors.textSecondary }]}>
                        ≈ {p.grams}g{p.calories ? `  ·  ${p.calories} kcal` : ''}
                      </ThemedText>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>

            {selected === 'custom' && (
              <View style={styles.customRow}>
                <TextInput
                  style={[styles.customInput, { color: colors.text, borderColor: tint + '60', backgroundColor: isDark ? 'rgba(118,118,128,0.12)' : 'rgba(118,118,128,0.06)' }]}
                  placeholder="克数"
                  placeholderTextColor={colors.textSecondary}
                  keyboardType="numeric"
                  value={customGrams}
                  onChangeText={setCustomGrams}
                  autoFocus
                />
                <TouchableOpacity
                  style={[styles.customBtn, { backgroundColor: tint }]}
                  onPress={handleCustomConfirm}
                  activeOpacity={0.8}>
                  <ThemedText style={styles.customBtnText}>确认</ThemedText>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.customBtn, styles.cancelBtn, { backgroundColor: isDark ? 'rgba(118,118,128,0.24)' : 'rgba(118,118,128,0.12)' }]}
                  onPress={handleCustomCancel}
                  activeOpacity={0.7}>
                  <ThemedText style={[styles.customBtnText, { color: colors.text }]}>取消</ThemedText>
                </TouchableOpacity>
              </View>
            )}
          </>
        )}
      </GlassCard>
    </View>
  );
}

const CUSTOM_ROW_H = 34;

const styles = StyleSheet.create({
  wrapper: {
    marginVertical: 6,
    alignItems: 'flex-start',
  },
  card: {
    width: '90%' as any,
  },
  title: {
    fontSize: FontSize.sm,
    fontWeight: '500',
  },
  resolved: {
    fontSize: FontSize.sm,
    fontStyle: 'italic',
  },

  // 2×2 grid
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  option: {
    flex: 1,
    minWidth: '45%',
    borderRadius: Radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 2,
  },
  optionFull: {
    minWidth: '100%',
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  optionLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  optionHint: {
    fontSize: 11,
    lineHeight: 15,
  },

  // Custom grams row
  customRow: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
  },
  customInput: {
    flex: 1,
    height: CUSTOM_ROW_H,
    borderWidth: 1,
    borderRadius: Radius.sm,
    paddingHorizontal: 10,
    fontSize: 14,
    paddingVertical: 0,
  },
  customBtn: {
    height: CUSTOM_ROW_H,
    borderRadius: Radius.sm,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtn: {
    paddingHorizontal: 12,
  },
  customBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
