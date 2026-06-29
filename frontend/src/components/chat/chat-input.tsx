import { useRef, useState } from 'react';
import { Platform, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { ThemedText } from '@/components/themed-text';
import { Glass, Radius } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  onSend: (text: string) => void;
  isSending: boolean;
};

export function ChatInput({ onSend, isSending }: Props) {
  const [text, setText] = useState('');
  const inputRef = useRef<TextInput>(null);
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const theme = useTheme();
  const glass = Glass[isDark ? 'dark' : 'light'];

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;
    onSend(trimmed);
    setText('');
  };

  const canSend = text.trim().length > 0 && !isSending;

  const inputBar = (
    <View style={styles.innerRow}>
      <TouchableOpacity style={styles.sideBtn} activeOpacity={0.6} onPress={() => {}}>
        <ThemedText style={[styles.sideBtnText, { color: theme.textSecondary }]}>＋</ThemedText>
      </TouchableOpacity>

      <TextInput
        ref={inputRef}
        style={[styles.input, { color: theme.text }]}
        placeholder="记录饮食、运动…"
        placeholderTextColor={theme.textSecondary}
        value={text}
        onChangeText={setText}
        multiline
        maxLength={2000}
        returnKeyType="default"
        blurOnSubmit={false}
      />

      <TouchableOpacity style={styles.sideBtn} activeOpacity={0.6} onPress={() => {}}>
        <ThemedText style={[styles.sideBtnText, { color: theme.textSecondary }]}>🎤</ThemedText>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.sendBtn, { backgroundColor: canSend ? glass.tint : theme.backgroundElement }]}
        onPress={handleSend}
        disabled={!canSend}
        activeOpacity={0.7}>
        <ThemedText style={[styles.sendArrow, { color: canSend ? '#fff' : theme.textSecondary }]}>
          ↑
        </ThemedText>
      </TouchableOpacity>
    </View>
  );

  if (Platform.OS === 'ios') {
    return (
      <BlurView
        intensity={40}
        tint={isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
        style={[styles.container, { borderTopColor: glass.border }]}>
        {inputBar}
      </BlurView>
    );
  }

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: glass.background, borderTopColor: glass.border },
      ]}>
      {inputBar}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
  },
  innerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  sideBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sideBtnText: {
    fontSize: 20,
  },
  input: {
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    maxHeight: 120,
    minHeight: 36,
    paddingTop: 7,
    paddingBottom: 7,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendArrow: {
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 22,
  },
});
