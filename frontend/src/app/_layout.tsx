import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { LoginScreen } from '@/components/login-screen';
import { OnboardingScreen } from '@/components/onboarding-screen';
import { Colors } from '@/constants/theme';
import { apiFetch } from '@/lib/api';
import { getCached, setCached } from '@/lib/db';
import { queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth-store';
import { useOnboardingReviewStore } from '@/stores/onboarding-review-store';
import { useThemeStore } from '@/stores/theme-store';

type Profile = { onboarded: boolean };

const PROFILE_CACHE_KEY = 'profile';

// Inner shell — lives inside QueryClientProvider.
function AppShell() {
  const colorScheme = useColorScheme();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';
  const { token, isLoading, init } = useAuthStore();
  const { active: reviewActive, initialData: reviewData, endReview } = useOnboardingReviewStore();
  const initTheme = useThemeStore((s) => s.init);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileVersion, setProfileVersion] = useState(0);

  useEffect(() => {
    init();
    initTheme();
  }, []);

  const loadProfile = useCallback(async () => {
    if (!token) return;
    // 1. SQLite — instant if cached
    const cached = await getCached<Profile>(PROFILE_CACHE_KEY);
    if (cached) {
      setProfile(cached);
      setProfileLoading(false);
    }
    // 2. API — background refresh
    try {
      const fresh = await apiFetch<Profile>('/api/user/profile', { token });
      await setCached(PROFILE_CACHE_KEY, fresh);
      setProfile(fresh);
    } catch { /* keep cached data on error */ }
    finally { setProfileLoading(false); }
  }, [token]);

  useEffect(() => {
    if (!isLoading && token) { void loadProfile(); }
  }, [isLoading, token, loadProfile, profileVersion]);

  const refreshProfile = useCallback(() => setProfileVersion(v => v + 1), []);

  const showLoading = isLoading || (!!token && profileLoading);

  const handleOnboardingComplete = () => {
    endReview();
    refreshProfile();
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
          onComplete={refreshProfile}
        />
      )}
      {!showLoading && token && profile?.onboarded && !reviewActive && <AppTabs />}
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <AppShell />
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
