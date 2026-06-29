import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { LoginScreen } from '@/components/login-screen';
import { queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth-store';

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const { token, isLoading, init } = useAuthStore();

  useEffect(() => {
    init();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AnimatedSplashOverlay />
        {!isLoading && (token ? <AppTabs /> : <LoginScreen />)}
      </ThemeProvider>
    </QueryClientProvider>
  );
}
