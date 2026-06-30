import '@/global.css';

import { Platform } from 'react-native';

// Design tokens extracted from PhoneFrame.dc.html / ChatMain.dc.html
export const Colors = {
  light: {
    text: '#1C1C1E',
    background: '#F6F6FB',
    backgroundElement: 'rgba(118,118,128,0.12)',  // --field
    backgroundSelected: 'rgba(118,118,128,0.20)',
    textSecondary: 'rgba(60,60,67,0.62)',           // --text2
    textTertiary: 'rgba(60,60,67,0.34)',            // --text3
    hairline: 'rgba(60,60,67,0.12)',                // --hairline
    ok: '#30D158',
    warn: '#FF9F0A',
  },
  dark: {
    text: '#FFFFFF',
    background: '#0C0C11',
    backgroundElement: 'rgba(118,118,128,0.24)',   // --field dark
    backgroundSelected: 'rgba(118,118,128,0.36)',
    textSecondary: 'rgba(235,235,245,0.62)',        // --text2 dark
    textTertiary: 'rgba(235,235,245,0.34)',         // --text3 dark
    hairline: 'rgba(255,255,255,0.12)',             // --hairline dark
    ok: '#30D158',
    warn: '#FF9F0A',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

// Design tab bar: 9px paddingTop + 25px icon + 3px gap + 10px label + safe area ≈ 88px
export const BottomTabInset = Platform.select({ ios: 82, android: 80 }) ?? 0;
export const MaxContentWidth = 800;

// Liquid Glass design tokens — matched exactly to PhoneFrame.dc.html
export const Glass = {
  light: {
    background: 'rgba(255,255,255,0.60)',       // --card
    backgroundStrong: 'rgba(255,255,255,0.82)', // --card-strong
    border: 'rgba(60,60,67,0.12)',              // --hairline (outer borders)
    cardStroke: 'rgba(255,255,255,0.70)',        // --card-stroke (inner glass borders)
    tint: '#0A84FF',                            // accent
    shadow: { shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.10, shadowRadius: 34, elevation: 8 },
    bubbleAi: 'rgba(255,255,255,0.72)',         // --bubble-ai
    tabInactive: 'rgba(60,60,67,0.50)',         // --tab-inactive
  },
  dark: {
    background: 'rgba(44,44,48,0.55)',          // --card dark
    backgroundStrong: 'rgba(60,60,64,0.72)',    // --card-strong dark
    border: 'rgba(255,255,255,0.12)',            // --hairline dark
    cardStroke: 'rgba(255,255,255,0.14)',        // --card-stroke dark
    tint: '#0A84FF',
    shadow: { shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.45, shadowRadius: 36, elevation: 12 },
    bubbleAi: 'rgba(58,58,62,0.62)',            // --bubble-ai dark
    tabInactive: 'rgba(235,235,245,0.50)',      // --tab-inactive dark
  },
} as const;

// Avatar gradient stops: linear-gradient(150deg, accent, color-mix(accent 40%, #BF5AF2))
export const AvatarGradient = {
  colors: ['#0A84FF', '#6B3FBF'] as const, // accent → blend of accent+purple
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
};

export const Radius = {
  sm: 10,
  md: 16,
  lg: 24,
  xl: 32,
  pill: 999,
} as const;

export const BlurIntensity = {
  glass: 24,   // bubble AI blur level from design
  header: 30,  // header bar blur
  overlay: 40,
} as const;

export const FontSize = {
  xs: 11,
  sm: 13,
  base: 15,
  lg: 17,
  xl: 20,
  '2xl': 24,
  '3xl': 28,
} as const;
