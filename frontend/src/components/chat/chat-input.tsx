import { useRef, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Platform,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { SymbolView } from 'expo-symbols';
import { Colors, Glass } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

type Props = {
  onSend: (text: string) => void;
  isSending: boolean;
};

export function ChatInput({ onSend, isSending }: Props) {
  const [text, setText] = useState('');
  const [resetKey, setResetKey] = useState(0);
  const inputRef = useRef<TextInput>(null);
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = Colors[isDark ? 'dark' : 'light'];
  const glass = Glass[isDark ? 'dark' : 'light'];
  const blurTint = isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight';

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;
    onSend(trimmed);
    setText('');
    setResetKey(k => k + 1);
  };

  const canSend = text.trim().length > 0 && !isSending;

  const handlePlus = () => {
    const options = ['相机', '照片', '文件', '取消'];
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: 3 },
        () => {},
      );
    } else {
      Alert.alert('上传', '', options.slice(0, 3).map(label => ({ text: label, onPress: () => {} })));
    }
  };

  return (
    <View style={styles.row}>
      {/* + 圆形玻璃按钮 */}
      <View style={styles.circleShadow}>
        <TouchableOpacity onPress={handlePlus} activeOpacity={0.7} style={styles.circleClip}>
          <BlurView intensity={24} tint={blurTint} style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, styles.circleBorderOverlay, { borderColor: glass.cardStroke }]} />
          <SymbolView name="plus" size={20} tintColor={colors.text} />
        </TouchableOpacity>
      </View>

      {/* 胶囊输入框 */}
      <View style={styles.pillShadow}>
        <View style={styles.pillClip}>
          <BlurView intensity={24} tint={blurTint} style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, styles.pillBorderOverlay, { borderColor: glass.cardStroke }]} />
          <TextInput
            ref={inputRef}
            key={resetKey}
            style={[styles.input, { color: colors.text }]}
            placeholder="记录你吃了 / 运动了什么..."
            placeholderTextColor={colors.textTertiary}
            value={text}
            onChangeText={setText}
            multiline
            maxLength={2000}
            returnKeyType="default"
            blurOnSubmit={false}
          />
          <TouchableOpacity activeOpacity={0.6} onPress={() => {}}>
            <SymbolView name="mic" size={21} tintColor={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      {/* 发送按钮：默认玻璃卡，有内容时 accent */}
      <View style={[
        styles.circleShadow,
        canSend && { shadowColor: glass.tint, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.45, shadowRadius: 20, elevation: 8 },
      ]}>
        <TouchableOpacity
          onPress={handleSend}
          disabled={!canSend}
          activeOpacity={0.7}
          style={[styles.circleClip, canSend && { backgroundColor: glass.tint }]}>
          {!canSend && (
            <>
              <BlurView intensity={24} tint={blurTint} style={StyleSheet.absoluteFill} />
              <View style={[StyleSheet.absoluteFill, styles.circleBorderOverlay, { borderColor: glass.cardStroke }]} />
            </>
          )}
          <SymbolView name="arrow.up" size={21} tintColor={canSend ? '#fff' : colors.text} weight="semibold" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const PILL_H = 44;
const CIRCLE = 38;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginHorizontal: 14,
    marginBottom: 0,
    paddingTop: 6,
    paddingBottom: 6,
  },

  // 圆形按钮
  circleShadow: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    flexShrink: 0,
  },
  circleClip: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleBorderOverlay: {
    borderRadius: CIRCLE / 2,
    borderWidth: 0.5,
  },

  // 胶囊输入框
  pillShadow: {
    flex: 1,
    minHeight: PILL_H,
    borderRadius: PILL_H / 2,
  },
  pillClip: {
    minHeight: PILL_H,
    borderRadius: PILL_H / 2,
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 8,
  },
  pillBorderOverlay: {
    borderRadius: PILL_H / 2,
    borderWidth: 0.5,
  },
  input: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    maxHeight: 120,
    paddingTop: 0,
    paddingBottom: 0,
    includeFontPadding: false,
  },
});
