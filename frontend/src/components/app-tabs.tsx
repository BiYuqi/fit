import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import ChatScreen from '@/app/index';
import TodayScreen from '@/app/today';
import HistoryScreen from '@/app/history';
import SettingsScreen from '@/app/settings';

import { Glass } from '@/constants/theme';
import { GradientBackground } from '@/components/gradient-background';
import { useColorScheme } from '@/hooks/use-color-scheme';

type TabName = 'chat' | 'today' | 'history' | 'settings';

const TABS: {
  name: TabName;
  label: string;
  icon: string;
  iconActive: string;
  emoji: string;
}[] = [
  { name: 'chat',     label: 'Chat',     icon: 'message',               iconActive: 'message.fill',            emoji: '💬' },
  { name: 'today',    label: 'Today',    icon: 'chart.pie',             iconActive: 'chart.pie.fill',          emoji: '📊' },
  { name: 'history',  label: 'History',  icon: 'clock.arrow.circlepath', iconActive: 'clock.arrow.circlepath', emoji: '🕐' },
  { name: 'settings', label: 'Settings', icon: 'gearshape',             iconActive: 'gearshape.fill',         emoji: '⚙️' },
];

const SCREENS: Record<TabName, React.ComponentType> = {
  chat:     ChatScreen,
  today:    TodayScreen,
  history:  HistoryScreen,
  settings: SettingsScreen,
};

function TabIcon({ name, isActive, color }: { name: string; isActive: boolean; color: string }) {
  const tab = TABS.find(t => t.name === name)!;
  if (Platform.OS === 'ios') {
    return (
      <SymbolView
        name={(isActive ? tab.iconActive : tab.icon) as any}
        size={25}
        tintColor={color}
      />
    );
  }
  // Web / Android fallback — emoji icon
  return <Text style={[styles.emoji, { color }]}>{tab.emoji}</Text>;
}

export default function AppTabs() {
  const [active, setActive] = useState<TabName>('chat');
  const scheme = useColorScheme() ?? 'light';
  const isDark = scheme === 'dark';
  const glass = Glass[isDark ? 'dark' : 'light'];
  const insets = useSafeAreaInsets();

  const Screen = SCREENS[active];

  return (
    <GradientBackground style={styles.root}>
      <Screen />

      {/* Bottom tab bar — PhoneFrame.dc.html: h=88px, pt=9px, items center/gap:3 */}
      <BlurView
        intensity={34}
        tint={isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
        style={[
          styles.tabBar,
          { borderTopColor: glass.border, paddingBottom: insets.bottom },
        ]}
      >
        {TABS.map(tab => {
          const isActive = active === tab.name;
          const color = isActive ? glass.tint : glass.tabInactive;
          return (
            <Pressable
              key={tab.name}
              style={styles.tabItem}
              onPress={() => setActive(tab.name)}
              hitSlop={8}
            >
              <TabIcon name={tab.name} isActive={isActive} color={color} />
              <Text style={[styles.tabLabel, { color }]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </BlurView>
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  tabBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingTop: 9,
    paddingHorizontal: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
  },
  emoji: {
    fontSize: 22,
    lineHeight: 26,
  },
  tabLabel: {
    fontSize: 10,
    fontWeight: '500',
  },
});
