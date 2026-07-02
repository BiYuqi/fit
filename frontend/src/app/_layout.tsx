import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { LoginScreen } from '@/components/login-screen';
import { OnboardingScreen } from '@/components/onboarding-screen';
import { Colors } from '@/constants/theme';
import { apiFetch } from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth-store';
import { useOnboardingReviewStore } from '@/stores/onboarding-review-store';
import { useThemeStore } from '@/stores/theme-store';

type Profile = { onboarded: boolean };

// Inner shell — lives inside QueryClientProvider, so useQuery works.
function AppShell() {
  const colorScheme = useColorScheme();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';
  const { token, isLoading, init } = useAuthStore();
  const { active: reviewActive, initialData: reviewData, endReview } = useOnboardingReviewStore();
  const initTheme = useThemeStore((s) => s.init);

  useEffect(() => {
    init();
    initTheme();
  }, []);

  const { data: profile, isLoading: profileLoading } = useQuery<Profile>({
    queryKey: ['profile'],
    queryFn: () => apiFetch<Profile>('/api/user/profile', { token }),
    enabled: !isLoading && !!token,
    staleTime: Infinity,
  });

  const showLoading = isLoading || (!!token && profileLoading);

  const handleOnboardingComplete = () => {
    endReview();
    queryClient.invalidateQueries({ queryKey: ['profile'] });
  };

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      {showLoading && (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors[scheme].background }}>
          <ActivityIndicator size="large" />
        </View>
      )}
      {!showLoading && !token && <LoginScreen />}
      {!showLoading && token && reviewActive && (
        <OnboardingScreen
          initialData={reviewData ?? undefined}
          onComplete={handleOnboardingComplete}
        />
      )}
      {!showLoading && token && profile && !profile.onboarded && !reviewActive && (
        <OnboardingScreen
          onComplete={() => queryClient.invalidateQueries({ queryKey: ['profile'] })}
        />
      )}
      {!showLoading && token && profile?.onboarded && !reviewActive && <AppTabs />}
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}
