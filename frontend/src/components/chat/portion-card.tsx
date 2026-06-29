import { useState } from 'react';
import { StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { GlassCard } from '@/components/glass-card';
import { ThemedText } from '@/components/themed-text';
import { Glass, Radius } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import type { PortionCardPayload } from '@/types/chat';

const PORTION_LABEL: Record<string, string> = {
  small: '小份',
  medium: '中份',
  large: '大份',
  custom: '自定义',
};

export function PortionCard({
  payload,
  isResolved,
}: {
  payload: PortionCardPayload;
  isResolved: boolean;
}) {
  const [customGrams, setCustomGrams] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const scheme = useColorScheme();
  const theme = useTheme();
  const tint = Glass[scheme === 'dark' ? 'dark' : 'light'].tint;
  const { resolve } = useChatStore();
  const { token } = useAuthStore();

  const handleChoice = (label: string) => {
    if (isResolved || !token) return;
    if (label === 'custom') {
      setShowCustom(true);
      return;
    }
    resolve(payload.pending_id, label, token);
  };

  const handleCustomConfirm = () => {
    const grams = parseFloat(customGrams);
    if (isNaN(grams) || grams <= 0 || !token) return;
    resolve(payload.pending_id, { grams }, token);
  };

  return (
    <View style={styles.wrapper}>
      <GlassCard style={styles.card}>
        <ThemedText style={styles.title}>
          请选择 <ThemedText style={styles.highlight}>{payload.food_name}</ThemedText> 的份量
        </ThemedText>
        {isResolved ? (
          <ThemedText style={[styles.resolved, { color: theme.textSecondary }]}>已选择</ThemedText>
        ) : (
          <>
            <View style={styles.options}>
              {payload.portions.map(p => (
                <TouchableOpacity
                  key={p.label}
                  style={[styles.option, { borderColor: tint + '60' }]}
                  onPress={() => handleChoice(p.label)}
                  activeOpacity={0.7}>
                  <ThemedText style={[styles.optionLabel, { color: tint }]}>
                    {PORTION_LABEL[p.label] ?? p.label}
                  </ThemedText>
                  <ThemedText style={[styles.optionGrams, { color: theme.textSecondary }]}>
                    ≈{p.grams}g
                  </ThemedText>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={[styles.option, { borderColor: tint + '60' }]}
                onPress={() => handleChoice('custom')}
                activeOpacity={0.7}>
                <ThemedText style={[styles.optionLabel, { color: tint }]}>自定义</ThemedText>
                <ThemedText style={[styles.optionGrams, { color: theme.textSecondary }]}>
                  克数
                </ThemedText>
              </TouchableOpacity>
            </View>
            {showCustom && (
              <View style={styles.customRow}>
                <TextInput
                  style={[styles.customInput, { color: theme.text, borderColor: tint + '60' }]}
                  placeholder="克数"
                  placeholderTextColor={theme.textSecondary}
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
    gap: 10,
  },
  title: {
    fontSize: 14,
    lineHeight: 20,
  },
  highlight: {
    fontWeight: '600',
  },
  resolved: {
    fontSize: 13,
    fontStyle: 'italic',
  },
  options: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  option: {
    borderRadius: Radius.md,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: 'center',
    minWidth: 64,
  },
  optionLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  optionGrams: {
    fontSize: 11,
    marginTop: 2,
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
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 15,
  },
  confirmBtn: {
    borderRadius: Radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  confirmText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
