import { StyleSheet, View } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { Glass, Radius } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function UserBubble({ content }: { content?: string | null }) {
  const scheme = useColorScheme();
  const tint = Glass[scheme === 'dark' ? 'dark' : 'light'].tint;

  return (
    <View style={styles.row}>
      <View style={[styles.bubble, { backgroundColor: tint }]}>
        <ThemedText style={styles.text}>{content ?? ''}</ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginVertical: 4,
  },
  bubble: {
    maxWidth: '85%',
    borderRadius: Radius.lg,
    borderBottomRightRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  text: {
    color: '#ffffff',
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '500',
  },
});
