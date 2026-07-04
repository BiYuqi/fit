import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
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

// ── Swipe-back (chat → 首页) ──────────────────────────────────
// chatX: 0 = chat 完全展开；screenW = chat 完全滑出（收起）。
// 所有过渡视觉（chat 平移 / 底页视差 / 暗幕 / tab 栏渐显）都由它驱动。
const EDGE_WIDTH = 28;          // 左边缘起手区宽度
const PARALLAX = 0.28;          // 底页视差比例（iOS 原生栈手感）
const SCRIM_MAX = 0.22;         // chat 全开时底页暗幕不透明度
const SWIPE_SPRING = {
  stiffness: 320,
  damping: 32,
  mass: 1,
  overshootClamping: true,      // 绝不过冲——过冲会在边缘露出底页
  restDisplacementThreshold: 0.5,
  restSpeedThreshold: 10,
};

function TabIcon({ name, isActive, color }: { name: string; isActive: boolean; color: string }) {
  const tab = TABS.find(t => t.name === name)!;
  if (Platform.OS === 'ios') {
    return <SymbolView name={(isActive ? tab.iconActive : tab.icon) as any} size={22} tintColor={color} />;
  }
  return <Text style={[styles.emoji, { color }]}>{tab.emoji}</Text>;
}

type BgTab = Exclude<TabName, 'chat'>;

export default function AppTabs() {
  const [active, setActive] = useState<TabName>('chat');
  // Lazy mount: only mount screens that have been visited at least once.
  // Once mounted, they stay resident so tab switches are instant.
  const [mounted, setMounted] = useState<Set<TabName>>(new Set(['chat', 'today']));
  // Chat 底下露出的那一页：进 chat 前所在的 tab，滑动返回也回到它
  const [lastBgTab, setLastBgTab] = useState<BgTab>('today');
  // 手势进行中 → 提前挂载 tab 栏让它随滑动渐显
  const [swiping, setSwiping] = useState(false);
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

  // ── Swipe back: chat → lastBgTab ──────────────────────────────
  const { width: screenW } = useWindowDimensions();
  const chatX = useSharedValue(0); // 首启即 chat，故初始 0（展开）

  const finishClose = useCallback(() => {
    Keyboard.dismiss();
    setSwiping(false);
    setActive(lastBgTab);
  }, [lastBgTab]);

  const cancelClose = useCallback(() => setSwiping(false), []);

  // 返回按钮与手势共用同一条收起动画
  const animateClose = useCallback(() => {
    chatX.value = withSpring(screenW, SWIPE_SPRING, (finished) => {
      if (finished) runOnJS(finishClose)();
    });
  }, [screenW, finishClose]);

  const openChat = useCallback(() => {
    setMounted(prev => (prev.has('chat') ? prev : new Set([...prev, 'chat'])));
    if (activeRef.current !== 'chat') setLastBgTab(activeRef.current as BgTab);
    setActive('chat');
    // 进入期间 tab 栏保持挂载，随滑入渐隐（对称于滑出渐显）
    setSwiping(true);
    chatX.value = withSpring(0, SWIPE_SPRING, (finished) => {
      if (finished) runOnJS(cancelClose)();
    });
  }, [cancelClose]);

  // chat 关闭时停在屏幕右侧外（不切 display，避免显示翻转的闪帧）；
  // 尺寸变化（旋转）时把收起位置对齐到新宽度
  useEffect(() => {
    if (activeRef.current !== 'chat') chatX.value = screenW;
  }, [screenW]);

  const backPan = Gesture.Pan()
    .hitSlop({ left: 0, width: EDGE_WIDTH }) // 只在左边缘起手
    .activeOffsetX(12)                        // 明确横向意图才激活
    .failOffsetY([-16, 16])                   // 竖向滚动让位给聊天列表
    .onStart(() => {
      runOnJS(setSwiping)(true);
    })
    .onUpdate(e => {
      chatX.value = Math.min(Math.max(e.translationX, 0), screenW);
    })
    .onEnd(e => {
      const shouldClose =
        e.velocityX > 800 || (chatX.value > screenW * 0.4 && e.velocityX > -500);
      if (shouldClose) {
        chatX.value = withSpring(screenW, { ...SWIPE_SPRING, velocity: e.velocityX }, (finished) => {
          if (finished) runOnJS(finishClose)();
        });
      } else {
        // 回弹结束后再卸载 tab 栏，让它随动画淡出而不是瞬间消失
        chatX.value = withSpring(0, { ...SWIPE_SPRING, velocity: e.velocityX }, (finished) => {
          if (finished) runOnJS(cancelClose)();
        });
      }
    });

  const chatLayerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: chatX.value }],
  }));
  // 底页视差：chat 全开时底页藏在左侧 -28%，随滑出归位
  const bgParallaxStyle = useAnimatedStyle(() => ({
    transform: [{
      translateX: interpolate(chatX.value, [0, screenW], [-screenW * PARALLAX, 0], Extrapolation.CLAMP),
    }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(chatX.value, [0, screenW], [SCRIM_MAX, 0], Extrapolation.CLAMP),
  }));
  const pillFadeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(chatX.value, [0, screenW], [0, 1], Extrapolation.CLAMP),
  }));

  return (
    <GradientBackground style={styles.root}>
      {/* Background screens — rendered first so Chat stacks on top.
          chat 在场时 lastBgTab 保持可见（被不透明的 chat 层盖住），
          手势一开始平移 chat 就能立刻露出它，不存在挂载延迟。 */}
      <Animated.View style={[styles.bgGroup, bgParallaxStyle]}>
        {TABS.filter(t => t.name !== 'chat').map(tab => {
          if (!mounted.has(tab.name)) return null;
          const Screen = SCREENS[tab.name];
          const isActiveTab = tab.name === active;
          const isUnderlay = isChat && tab.name === lastBgTab;
          return (
            <View
              key={tab.name}
              style={isActiveTab || isUnderlay ? styles.screenOn : styles.screenOff}
              pointerEvents={isActiveTab ? 'auto' : 'none'}
            >
              <Screen isActive={isActiveTab} />
            </View>
          );
        })}
      </Animated.View>

      {/* 底页暗幕：chat 越展开越暗，滑出过程渐亮 */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]}
      />

      {/* Chat — always on top of other screens.
          自带不透明 GradientBackground：平移时绝不透出底页。 */}
      {mounted.has('chat') && (
        <GestureDetector gesture={backPan}>
          <Animated.View
            key="chat"
            style={[styles.chatLayer, chatLayerStyle]}
            pointerEvents={isChat ? 'auto' : 'none'}
          >
            <GradientBackground style={styles.chatBg}>
              <ChatScreen isActive={isChat} />

              {/* 左缘投影：滑动时压在底页上，模拟原生栈卡片阴影 */}
              <LinearGradient
                colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.16)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.edgeShadow}
                pointerEvents="none"
              />

              {/* ── Back button（随 chat 层一起滑动）── */}
              <View style={[
                styles.backShadow,
                { top: insets.top + 10,
                  shadowColor: g.shadowColor, shadowOpacity: g.shadowOpacity,
                  shadowOffset: g.shadowOffset, shadowRadius: g.shadowRadius,
                  elevation: g.elevation },
              ]}>
                <Pressable style={styles.backClip} onPress={animateClose} hitSlop={8}>
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
            </GradientBackground>
          </Animated.View>
        </GestureDetector>
      )}

      {/* ── Floating pill tab bar ──
          swiping 时也挂载：随 chat 滑出渐显，落地不突兀 */}
      {(!isChat || swiping) && (
        <Animated.View
          pointerEvents="box-none"
          style={[
            styles.pillOuter,
            { bottom: Math.max(20, insets.bottom - 10) },
            pillFadeStyle,
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
                      if (tab.name === 'chat') { openChat(); return; }
                      // chat 不切 display，若正处于进入动画中途切走，直接收到屏幕外
                      chatX.value = screenW;
                      setSwiping(false);
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
        </Animated.View>
      )}
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  root:      { flex: 1 },
  screenOn:   { flex: 1 },
  screenOff:  { display: 'none' },
  bgGroup:    { flex: 1 },
  scrim:      { backgroundColor: '#000' },

  // ── Chat sliding layer ──
  chatLayer: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 20,
  },
  chatBg: { flex: 1 },
  edgeShadow: {
    position: 'absolute',
    left: -16,
    top: 0,
    bottom: 0,
    width: 16,
  },

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
