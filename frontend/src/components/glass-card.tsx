import { BlurView } from 'expo-blur';
import { Platform, StyleSheet, View, ViewProps } from 'react-native';

import { BlurIntensity, Glass, Radius } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

type GlassCardProps = ViewProps & { blurIntensity?: number };

export function GlassCard({
  style,
  blurIntensity = BlurIntensity.glass,
  children,
  ...props
}: GlassCardProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const glass = Glass[isDark ? 'dark' : 'light'];

  if (Platform.OS === 'ios') {
    return (
      <BlurView
        intensity={blurIntensity}
        tint={isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
        style={[styles.card, { borderColor: glass.border }, style]}
        {...props}>
        {children}
      </BlurView>
    );
  }

  return (
    <View
      style={[styles.card, { backgroundColor: glass.background, borderColor: glass.border }, style]}
      {...props}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    padding: 16,
  },
});
