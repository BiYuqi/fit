import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
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

const TABS: { name: TabName; label: string; icon: string; iconActive: string; emoji: string }[] = [
  { name: 'today',    label: 'Today',    icon: 'chart.pie',              iconActive: 'chart.pie.fill',         emoji: '📊' },
  { name: 'chat',     label: 'Chat',     icon: 'bubble.left',            iconActive: 'bubble.left.fill',       emoji: '💬' },
  { name: 'history',  label: 'History',  icon: 'clock.arrow.circlepath', iconActive: 'clock.arrow.circlepath', emoji: '🕐' },
  { name: 'settings', label: 'Settings', icon: 'gearshape',              iconActive: 'gearshape.fill',         emoji: '⚙️' },
];

const SCREENS: Record<TabName, React.ComponentType<{ isActive?: boolean }>> = {
  chat: ChatScreen, today: TodayScreen, history: HistoryScreen, settings: SettingsScreen,
};

// Glass tokens extracted exactly from PhoneFrame.dc.html
const GLASS = {
  light: {
    // CSS: blur(52px) saturate(220%) brightness(1.06) + rgba(255,255,255,.58/.26/.40)
    // RN has no brightness/saturate filter → compensate by boosting white overlay opacity
    gradColors: ['rgba(255,255,255,0.82)', 'rgba(255,255,255,0.65)', 'rgba(255,255,255,0.75)'] as const,
    gradLocs:   [0, 0.55, 1] as const,
    stroke:     'rgba(255,255,255,0.80)',
    // glassInset highlights
    topHighlight:    'rgba(255,255,255,0.95)', // inset top 1.2px
    bottomHighlight: 'rgba(255,255,255,0.40)', // inset bottom 1px
    innerBorder:     'rgba(255,255,255,0.30)', // inner 0.5px border
    // glassShadow: 0 18px 44px rgba(31,33,46,.2), 0 6px 14px rgba(31,33,46,.1)
    shadowColor:   'rgba(31,33,46,1)',
    shadowOpacity: 0.20,
    shadowOffset:  { width: 0, height: 14 } as { width: number; height: number },
    shadowRadius:  36,
    elevation:     14,
  },
  dark: {
    // linear-gradient(165deg, rgba(94,94,102,.42), rgba(38,38,44,.22) 55%, rgba(58,58,66,.34))
    gradColors: ['rgba(94,94,102,0.42)', 'rgba(38,38,44,0.22)', 'rgba(58,58,66,0.34)'] as const,
    gradLocs:   [0, 0.55, 1] as const,
    stroke:     'rgba(255,255,255,0.22)',
    topHighlight:    'rgba(255,255,255,0.35)',
    bottomHighlight: 'rgba(255,255,255,0.08)',
    innerBorder:     'rgba(255,255,255,0.10)',
    shadowColor:   'rgba(0,0,0,1)',
    shadowOpacity: 0.50,
    shadowOffset:  { width: 0, height: 16 } as { width: number; height: number },
    shadowRadius:  44,
    elevation:     20,
  },
};

// Active indicator tokens
const INDICATOR = {
  // bg: linear-gradient(180deg, accent 26%, accent 13%)
  gradColors: ['rgba(10,132,255,0.26)', 'rgba(10,132,255,0.13)'] as const,
  topHighlight: 'rgba(255,255,255,0.50)',  // inset 0 1px 0
  border:       'rgba(10,132,255,0.45)',    // inset 0 0 0 .5px
};

const SPRING = { damping: 22, stiffness: 220, mass: 0.8 };
const BACK = 38;

function TabIcon({ name, isActive, color }: { name: string; isActive: boolean; color: string }) {
  const tab = TABS.find(t => t.name === name)!;
  if (Platform.OS === 'ios') {
    return <SymbolView name={(isActive ? tab.iconActive : tab.icon) as any} size={22} tintColor={color} />;
  }
  return <Text style={[styles.emoji, { color }]}>{tab.emoji}</Text>;
}

export default function AppTabs() {
  const [active, setActive] = useState<TabName>('chat');
  // Lazy mount: only mount screens that have been visited at least once.
  // Once mounted, they stay resident so tab switches are instant.
  const [mounted, setMounted] = useState<Set<TabName>>(new Set(['chat', 'today']));
  const scheme   = useColorScheme() ?? 'light';
  const isDark   = scheme === 'dark';
  const glass    = Glass[isDark ? 'dark' : 'light'];
  const g        = GLASS[isDark ? 'dark' : 'light'];
  const insets   = useSafeAreaInsets();
  const blurTint = isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight';

  // ── Sliding indicator ──────────────────────────────────────────
  const indicatorLeft  = useSharedValue(0);
  const indicatorWidth = useSharedValue(0);
  const tabLayouts = useRef<Array<{ x: number; width: number } | null>>(
    new Array(TABS.length).fill(null),
  );
  const initialized = useRef(false);
  const activeRef   = useRef<TabName>(active);
  activeRef.current = active;

  const syncIndicator = useCallback((animate: boolean) => {
    const idx    = TABS.findIndex(t => t.name === activeRef.current);
    const layout = tabLayouts.current[idx];
    if (!layout) return;
    if (animate) {
      indicatorLeft.value  = withSpring(layout.x, SPRING);
      indicatorWidth.value = withSpring(layout.width, SPRING);
    } else {
      indicatorLeft.value  = layout.x;
      indicatorWidth.value = layout.width;
    }
  }, []);

  const handleTabLayout = useCallback((index: number, e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    tabLayouts.current[index] = { x, width };
    const allReady = tabLayouts.current.every(l => l !== null);
    if (allReady && !initialized.current) {
      initialized.current = true;
      syncIndicator(false);
    }
  }, [syncIndicator]);

  useEffect(() => {
    if (initialized.current) syncIndicator(true);
  }, [active, syncIndicator]);

  const indicatorStyle = useAnimatedStyle(() => ({
    left:  indicatorLeft.value,
    width: indicatorWidth.value,
  }));

  const isChat = active === 'chat';

  return (
    <GradientBackground style={styles.root}>
      {/* Background screens — rendered first so Chat stacks on top */}
      {TABS.filter(t => t.name !== 'chat').map(tab => {
        if (!mounted.has(tab.name)) return null;
        const Screen = SCREENS[tab.name];
        const isActiveTab = tab.name === active;
        return (
          <View
            key={tab.name}
            style={isActiveTab ? styles.screenOn : styles.screenOff}
            pointerEvents={isActiveTab ? 'auto' : 'none'}
          >
            <Screen isActive={isActiveTab} />
          </View>
        );
      })}

      {/* Chat — always on top of other screens */}
      {mounted.has('chat') && (
        <View
          key="chat"
          style={active === 'chat' ? styles.screenOn : styles.screenOff}
          pointerEvents={active === 'chat' ? 'auto' : 'none'}
        >
          <ChatScreen isActive={active === 'chat'} />
        </View>
      )}

      {/* ── Back button ── */}
      {isChat && (
        // Shadow wrapper (no overflow:hidden so shadow renders)
        <View style={[
          styles.backShadow,
          { top: insets.top + 10,
            shadowColor: g.shadowColor, shadowOpacity: g.shadowOpacity,
            shadowOffset: g.shadowOffset, shadowRadius: g.shadowRadius,
            elevation: g.elevation },
        ]}>
          <Pressable style={styles.backClip} onPress={() => {
            setMounted(prev => prev.has('today') ? prev : new Set([...prev, 'today']));
            setActive('today');
          }} hitSlop={8}>
            {/* Blur */}
            <BlurView intensity={40} tint={blurTint} style={StyleSheet.absoluteFill} />
            {/* Glass gradient */}
            <LinearGradient
              colors={g.gradColors}
              locations={g.gradLocs}
              start={{ x: 0.85, y: 0 }}
              end={{ x: 0.15, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            {/* Top inner highlight */}
            <View style={[styles.backTopHL, { backgroundColor: g.topHighlight }]} pointerEvents="none" />
            {/* Border */}
            <View style={[styles.backBorder, { borderColor: g.stroke }]} pointerEvents="none" />
            {/* Icon */}
            {Platform.OS === 'ios'
              ? <SymbolView name="chevron.left" size={17} tintColor={glass.tabInactive} weight="semibold" />
              : <Text style={[styles.backArrow, { color: glass.tabInactive }]}>‹</Text>}
          </Pressable>
        </View>
      )}

      {/* ── Floating pill tab bar ── */}
      {!isChat && (
        <View
          pointerEvents="box-none"
          style={[
            styles.pillOuter,
            { bottom: Math.max(20, insets.bottom - 10) },
          ]}
        >
          {/* Shadow wrapper */}
          <View style={[
            styles.pillShadow,
            { shadowColor: g.shadowColor, shadowOpacity: g.shadowOpacity,
              shadowOffset: g.shadowOffset, shadowRadius: g.shadowRadius,
              elevation: g.elevation },
          ]}>
            {/* BlurView = clip container — intensity 38 avoids gray cast on light bg */}
            <BlurView intensity={38} tint={blurTint} style={styles.pill}>

              {/* 1. Glass gradient tint over blur */}
              <LinearGradient
                colors={g.gradColors}
                locations={g.gradLocs}
                start={{ x: 0.85, y: 0 }}
                end={{ x: 0.15, y: 1 }}
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
              />

              {/* 2. Top inner highlight line (glassInset: inset 0 1.2px 0 white) */}
              <View style={[styles.pillTopHL, { backgroundColor: g.topHighlight }]} pointerEvents="none" />

              {/* 4. Inner border overlay (glassInset: inset 0 0 0 .5px white) */}
              <View style={[styles.pillBorder, { borderColor: g.stroke }]} pointerEvents="none" />

              {/* 5. Sliding active indicator
                     Outer: carries shadow (no overflow:hidden so the blue glow escapes into pill padding)
                     Inner: clips gradient to rounded rect                                               */}
              <Animated.View
                style={[styles.indicatorOuter, indicatorStyle, {
                  shadowColor: '#0A84FF',
                  shadowOffset: { width: 0, height: 3 },
                  shadowOpacity: 0.30,
                  shadowRadius: 8,
                  elevation: 6,
                }]}
                pointerEvents="none"
              >
                <View style={styles.indicatorClip}>
                  {/* Gradient bg: accent 26% → 13% (PhoneFrame: color-mix accent 26%/13%, transparent) */}
                  <LinearGradient
                    colors={INDICATOR.gradColors}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 0, y: 1 }}
                    style={StyleSheet.absoluteFill}
                  />
                  {/* inset 0 1px 0 rgba(255,255,255,.5) — top highlight */}
                  <View style={[styles.indicatorTopHL, { backgroundColor: INDICATOR.topHighlight }]} />
                  {/* inset 0 0 0 .5px accent 45% — inner border */}
                  <View style={[styles.indicatorBorder, { borderColor: INDICATOR.border }]} />
                </View>
              </Animated.View>

              {/* 6. Tab items */}
              {TABS.map((tab, index) => {
                const isActive = active === tab.name;
                const color = isActive ? glass.tint : glass.tabInactive;
                return (
                  <Pressable
                    key={tab.name}
                    style={styles.tabItem}
                    onLayout={e => handleTabLayout(index, e)}
                    onPress={() => {
                      setMounted(prev => prev.has(tab.name) ? prev : new Set([...prev, tab.name]));
                      setActive(tab.name);
                    }}
                    hitSlop={4}
                  >
                    <TabIcon name={tab.name} isActive={isActive} color={color} />
                    <Text style={[styles.tabLabel, { color }]}>{tab.label}</Text>
                  </Pressable>
                );
              })}

            </BlurView>
          </View>
        </View>
      )}
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  root:      { flex: 1 },
  screenOn:   { flex: 1 },
  screenOff:  { display: 'none' },

  // ── Back button ──
  backShadow: {
    position: 'absolute',
    left: 14,
    zIndex: 30,
    width: BACK,
    height: BACK,
    borderRadius: BACK / 2,
  },
  backClip: {
    width: BACK,
    height: BACK,
    borderRadius: BACK / 2,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backTopHL: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 1.2,
    borderTopLeftRadius: BACK / 2,
    borderTopRightRadius: BACK / 2,
  },
  backBorder: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: BACK / 2,
    borderWidth: 0.5,
  },
  backArrow: { fontSize: 22, lineHeight: 26 },

  // ── Pill ──
  pillOuter: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 50,
  },
  pillShadow: {
    borderRadius: 26,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderRadius: 26,
    overflow: 'hidden',
  },
  // Glass overlay layers
  pillTopHL: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 1.2,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
  },
  pillBorder: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 26,
    borderWidth: 0.5,
  },

  // ── Sliding indicator ──
  indicatorOuter: {
    position: 'absolute',
    top: 5,      // matches pill paddingVertical
    bottom: 5,
    borderRadius: 19,
    // No overflow:hidden here — lets blue shadow bleed into pill padding
  },
  indicatorClip: {
    flex: 1,
    borderRadius: 19,
    overflow: 'hidden',
  },
  indicatorTopHL: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 1,
    borderTopLeftRadius: 19,
    borderTopRightRadius: 19,
  },
  indicatorBorder: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 19,
    borderWidth: 0.5,
  },

  // ── Tab items ──
  tabItem: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: 3,
    paddingVertical: 7,
    paddingHorizontal: 13,
    borderRadius: 19,
  },
  tabLabel: {
    fontSize: 10,
    fontWeight: '600',
    lineHeight: 11,
  },
  emoji: {
    fontSize: 22,
    lineHeight: 26,
  },
});
