import { useEffect, useState } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';
import { useThemeStore } from '@/stores/theme-store';

/**
 * To support static rendering, this value needs to be re-calculated on the client side for web.
 * Also respects the user's theme preference from the theme store.
 */
export function useColorScheme(): 'light' | 'dark' {
  const [hasHydrated, setHasHydrated] = useState(false);
  const systemScheme = useRNColorScheme();
  const preference = useThemeStore((s) => s.preference);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  // If user picked a specific theme, use it regardless of hydration state
  if (preference === 'light') return 'light';
  if (preference === 'dark') return 'dark';

  // 'system' — follow device
  if (hasHydrated) {
    return systemScheme === 'dark' ? 'dark' : 'light';
  }

  return 'light';
}
