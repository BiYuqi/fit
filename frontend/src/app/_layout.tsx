import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { LoginScreen } from '@/components/login-screen';
import { OnboardingScreen } from '@/components/onboarding-screen';
import { Colors, Glass } from '@/constants/theme';
import { apiFetch } from '@/lib/api';
import { useAuthStore } from '@/stores/auth-store';
import { useCachedQuery } from '@/hooks/use-cached-query';
import { useOnboardingReviewStore } from '@/stores/onboarding-review-store';
import { useThemeStore } from '@/stores/theme-store';

type Profile = { onboarded: boolean };

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

  // T57：'profile' 键与 settings 共享——冷启动缓存秒出，后台静默刷新
  const {
    data: profile,
    loading: profileLoading,
    refetch: refetchProfile,
  } = useCachedQuery<Profile>(
    !isLoading && token ? 'profile' : null,
    () => apiFetch<Profile>('/api/user/profile', { token }),
  );

  const showLoading = isLoading || (!!token && profileLoading);

  const handleOnboardingComplete = () => {
    endReview();
    refetchProfile();
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
          onComplete={refetchProfile}
        />
      )}
      {!showLoading && token && profile?.onboarded && !reviewActive && <AppTabs />}
      {/* 冷启动无缓存且请求失败：给重试入口，不再白屏 */}
      {!showLoading && token && !profile && !reviewActive && (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors[scheme].background }}>
          <Text style={{ color: Colors[scheme].textSecondary, marginBottom: 16 }}>加载失败，请检查网络</Text>
          <Pressable onPress={refetchProfile} hitSlop={12}>
            <Text style={{ color: Glass[scheme].tint, fontSize: 16 }}>重试</Text>
          </Pressable>
        </View>
      )}
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppShell />
    </GestureHandlerRootView>
  );
}
