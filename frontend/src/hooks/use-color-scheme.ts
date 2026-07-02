import { useColorScheme as useSystemColorScheme } from 'react-native';
import { useThemeStore } from '@/stores/theme-store';

export function useColorScheme(): 'light' | 'dark' {
  const systemScheme = useSystemColorScheme();
  const preference = useThemeStore((s) => s.preference);

  if (preference === 'light' || preference === 'dark') return preference;

  // 'system' — follow device. Fall back to 'light' when unspecified.
  return systemScheme === 'dark' ? 'dark' : 'light';
}
