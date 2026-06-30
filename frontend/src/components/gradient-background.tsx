import { StyleSheet, type ViewProps } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function GradientBackground({ style, children, ...props }: ViewProps) {
  const isDark = useColorScheme() === 'dark';

  const base: [string, string] = isDark
    ? ['#0C0C11', '#000000']
    : ['#F6F6FB', '#EBEBF1'];

  const accentGlow = isDark ? 'rgba(10,132,255,0.34)' : 'rgba(10,132,255,0.22)';

  return (
    <LinearGradient
      colors={base}
      start={{ x: 0, y: 0 }}
      end={{ x: 0, y: 1 }}
      style={[styles.root, style]}
      {...(props as any)}
    >
      <LinearGradient
        colors={[accentGlow, 'rgba(0,0,0,0)', 'rgba(0,0,0,0)']}
        locations={[0, 0.38, 1]}
        start={{ x: 1, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
