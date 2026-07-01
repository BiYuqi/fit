import { BlurView } from 'expo-blur';
import { Platform, StyleSheet, View, ViewProps } from 'react-native';

import { BlurIntensity, Glass, Radius } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

type GlassCardProps = ViewProps & {
  blurIntensity?: number;
  /** Override default padding (16). Applied to the inner card / BlurView. */
  padding?: number;
  /** Gap between children, applied to the inner card. */
  gap?: number;
};

export function GlassCard({
  style,
  blurIntensity = BlurIntensity.glass,
  padding: paddingOverride,
  gap,
  children,
  ...props
}: GlassCardProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const glass = Glass[isDark ? 'dark' : 'light'];
  const shadow = glass.shadow;

  // Inner card style — starts with base then overrides padding / gap if provided.
  const inner: any[] = [styles.card, { borderColor: glass.border }];
  if (paddingOverride !== undefined) inner.push({ padding: paddingOverride });
  if (gap !== undefined) inner.push({ gap });

  if (Platform.OS === 'ios') {
    return (
      // Shadow must be on an outer View — BlurView overflow:hidden clips it
      <View style={[styles.shadowWrap, shadow, style]}>
        <BlurView
          intensity={blurIntensity}
          tint={isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
          style={inner}
          {...props}>
          {children}
        </BlurView>
      </View>
    );
  }

  // Android / web fallback — solid background; style goes last so caller wins
  inner.push({ backgroundColor: glass.background }, shadow, style);
  return (
    <View style={inner} {...props}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  shadowWrap: {
    borderRadius: Radius.lg,
  },
  card: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    padding: 16,
  },
});
