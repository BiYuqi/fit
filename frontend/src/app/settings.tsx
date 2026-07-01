import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';
import { BlurView } from 'expo-blur';

import { ThemedText } from '@/components/themed-text';
import { apiFetch } from '@/lib/api';
import { clearCache } from '@/lib/db';
import { queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth-store';
import { useOnboardingReviewStore, type OnboardingFormData } from '@/stores/onboarding-review-store';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors, Glass, BottomTabInset, Spacing, FontSize } from '@/constants/theme';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Profile {
  id: string;
  account: string;
  name: string | null;
  gender: 'male' | 'female' | null;
  age: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  target_weight_kg: number | null;
  activity_level: string | null;
  goal_type: string | null;
  daily_deficit: number | null;
  custom_tdee: number | null;
  onboarded: boolean;
  created_at: string;
  bmr?: number;
  tdee?: number;
  target_calories?: number;
  target_protein?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ACTIVITY_OPTIONS = [
  { value: 'sedentary' as const, label: '久坐', desc: '几乎不运动，以办公室生活为主' },
  { value: 'light' as const, label: '轻度', desc: '每周轻度运动 1–3 天' },
  { value: 'moderate' as const, label: '中度', desc: '每周运动 3–5 天' },
  { value: 'active' as const, label: '高强度', desc: '每周高强度训练 6–7 天' },
  { value: 'very_active' as const, label: '极高', desc: '体力工作，或每天高强度训练' },
];

const GENDER_OPTIONS = [
  { value: 'male' as const, label: '男' },
  { value: 'female' as const, label: '女' },
];

const GOAL_OPTIONS = [
  { value: 'cut' as const, label: '减脂' },
  { value: 'maintain' as const, label: '维持' },
];

const DEFICIT_MIN = 150;
const DEFICIT_MAX = 1500;

const ACTIVITY_LABEL: Record<string, string> = Object.fromEntries(
  ACTIVITY_OPTIONS.map((o) => [o.value, o.label]),
);
const GENDER_LABEL: Record<string, string> = Object.fromEntries(
  GENDER_OPTIONS.map((o) => [o.value, o.label]),
);
const GOAL_LABEL: Record<string, string> = Object.fromEntries(
  GOAL_OPTIONS.map((o) => [o.value, o.label]),
);

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return Math.round(n).toLocaleString('zh-CN');
}

// ─── Deficit Slider ─────────────────────────────────────────────────────────

function DeficitSlider({
  value,
  onValueChange,
  colors,
  accent,
}: {
  value: number;
  onValueChange: (v: number) => void;
  colors: typeof Colors.light | typeof Colors.dark;
  accent: string;
}) {
  const trackRef = useRef<View>(null);
  const trackWidth = useRef(280);
  const fraction = Math.min(1, Math.max(0, (value - DEFICIT_MIN) / (DEFICIT_MAX - DEFICIT_MIN)));

  const updateFromX = useCallback(
    (pageX: number) => {
      trackRef.current?.measureInWindow((x, _y, w) => {
        if (w > 0) trackWidth.current = w;
        const ratio = Math.min(1, Math.max(0, (pageX - x) / trackWidth.current));
        const newVal = Math.round(DEFICIT_MIN + ratio * (DEFICIT_MAX - DEFICIT_MIN));
        onValueChange(newVal);
      });
    },
    [onValueChange],
  );

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        updateFromX(evt.nativeEvent.pageX);
      },
      onPanResponderMove: (evt) => {
        updateFromX(evt.nativeEvent.pageX);
      },
      onPanResponderRelease: () => {},
    }),
  ).current;

  return (
    <View style={sliderStyles.wrap}>
      <View style={sliderStyles.labels}>
        <ThemedText themeColor="textTertiary" style={sliderStyles.label}>
          温和 {DEFICIT_MIN}
        </ThemedText>
        <ThemedText themeColor="textTertiary" style={sliderStyles.label}>
          激进 {DEFICIT_MAX}
        </ThemedText>
      </View>
      <View
        ref={trackRef}
        style={[sliderStyles.track, { backgroundColor: colors.backgroundElement }]}
        {...panResponder.panHandlers}
      >
        <View
          style={[
            sliderStyles.fill,
            { width: `${fraction * 100}%`, backgroundColor: accent },
          ]}
        />
        <View
          style={[
            sliderStyles.thumb,
            {
              left: `${fraction * 100}%`,
              marginLeft: -12,
              backgroundColor: '#FFFFFF',
              shadowColor: '#000000',
              borderColor: colors.hairline,
            },
          ]}
        />
      </View>
    </View>
  );
}

const sliderStyles = StyleSheet.create({
  wrap: { paddingTop: 10 },
  labels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 7,
  },
  label: { fontSize: 11 },
  track: {
    height: 6,
    borderRadius: 4,
    position: 'relative',
    justifyContent: 'center',
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: '100%',
    borderRadius: 4,
  },
  thumb: {
    position: 'absolute',
    top: -9,
    width: 24,
    height: 24,
    borderRadius: 12,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
});

// ─── Settings Row (tappable list row with chevron) ──────────────────────────

function SettingsRow({
  label,
  value,
  valueColor,
  onPress,
  colors,
  showDivider = true,
}: {
  label: string;
  value: string;
  valueColor?: string;
  onPress: () => void;
  colors: typeof Colors.light | typeof Colors.dark;
  showDivider?: boolean;
}) {
  return (
    <>
      {showDivider && <View style={[styles.rowDivider, { backgroundColor: colors.hairline }]} />}
      <TouchableOpacity
        style={styles.row}
        onPress={onPress}
        activeOpacity={0.6}
      >
        <ThemedText style={styles.rowLabel}>{label}</ThemedText>
        <ThemedText
          style={[styles.rowValue, valueColor ? { color: valueColor } : undefined]}
          themeColor={valueColor ? undefined : 'textSecondary'}
        >
          {value}
        </ThemedText>
        <SymbolView
          name={{ ios: 'chevron.right' as const, android: 'chevron_right' as const, web: 'chevron_right' as const }}
          size={16}
          tintColor={colors.textTertiary}
          style={styles.rowChevron}
        />
      </TouchableOpacity>
    </>
  );
}

// ─── Picker Modal (for gender, activity level, goal type) ───────────────────

function PickerModal<T extends string>({
  visible,
  title,
  options,
  value,
  onSelect,
  onClose,
  colors,
  glass,
  accent,
  isDark,
}: {
  visible: boolean;
  title: string;
  options: { value: T; label: string; desc?: string }[];
  value: T;
  onSelect: (v: T) => void;
  onClose: () => void;
  colors: typeof Colors.light | typeof Colors.dark;
  glass: typeof Glass.light | typeof Glass.dark;
  accent: string;
  isDark: boolean;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={modalStyles.backdrop} onPress={onClose}>
        <View />
      </Pressable>
      <View style={modalStyles.sheet} pointerEvents="box-none">
        <Pressable
          style={[
            modalStyles.card,
            {
              backgroundColor: isDark ? 'rgba(44,44,48,0.95)' : 'rgba(255,255,255,0.95)',
              borderColor: glass.border,
            },
          ]}
        >
          <ThemedText style={modalStyles.title}>{title}</ThemedText>
          {options.map((opt, i) => {
            const selected = opt.value === value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[
                  modalStyles.option,
                  i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
                ]}
                onPress={() => {
                  onSelect(opt.value);
                  onClose();
                }}
                activeOpacity={0.6}
              >
                <View style={modalStyles.optionText}>
                  <ThemedText
                    style={[
                      modalStyles.optionLabel,
                      { color: selected ? accent : colors.text },
                    ]}
                  >
                    {opt.label}
                  </ThemedText>
                  {opt.desc && (
                    <ThemedText themeColor="textSecondary" style={modalStyles.optionDesc}>
                      {opt.desc}
                    </ThemedText>
                  )}
                </View>
                {selected && (
                  <SymbolView
                    name={{ ios: 'checkmark' as const, android: 'check' as const, web: 'check' as const }}
                    size={18}
                    tintColor={accent}
                    style={{ width: 18, height: 18 }}
                  />
                )}
              </TouchableOpacity>
            );
          })}
        </Pressable>
      </View>
    </Modal>
  );
}

// ─── Stepper Modal (for numeric values) ─────────────────────────────────────

function StepperModal({
  visible,
  title,
  value,
  unit,
  min,
  max,
  step = 1,
  decimals = 0,
  onValueChange,
  onClose,
  colors,
  glass,
  accent,
  isDark,
}: {
  visible: boolean;
  title: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step?: number;
  decimals?: number;
  onValueChange: (v: number) => void;
  onClose: () => void;
  colors: typeof Colors.light | typeof Colors.dark;
  glass: typeof Glass.light | typeof Glass.dark;
  accent: string;
  isDark: boolean;
}) {
  const [text, setText] = useState('');
  const [local, setLocal] = useState(value);

  function fmt(v: number) {
    return decimals > 0 ? v.toFixed(decimals) : String(Math.round(v));
  }

  useEffect(() => {
    if (visible) {
      setLocal(value);
      setText(fmt(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, value]);

  const handleDone = () => {
    const n = parseFloat(text);
    if (!isNaN(n)) {
      const clamped = Math.min(max, Math.max(min, parseFloat(n.toFixed(decimals))));
      onValueChange(clamped);
    }
    onClose();
  };

  // +/- buttons adjust based on last parsed value
  const adjust = (delta: number) => {
    const base = !isNaN(parseFloat(text)) ? parseFloat(text) : local;
    const next = parseFloat((base + delta).toFixed(decimals));
    if (next >= min && next <= max) {
      const s = fmt(next);
      setLocal(next);
      setText(s);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={modalStyles.backdrop} onPress={onClose}>
        <View />
      </Pressable>
      <View style={modalStyles.sheet} pointerEvents="box-none">
        <Pressable
          style={[
            modalStyles.card,
            {
              backgroundColor: isDark ? 'rgba(44,44,48,0.95)' : 'rgba(255,255,255,0.95)',
              borderColor: glass.border,
            },
          ]}
        >
          <View style={modalStyles.stepperHeader}>
            <ThemedText style={modalStyles.title}>{title}</ThemedText>
            <TouchableOpacity onPress={handleDone} activeOpacity={0.7}>
              <ThemedText style={[modalStyles.doneBtn, { color: accent }]}>完成</ThemedText>
            </TouchableOpacity>
          </View>

          <View style={modalStyles.stepperBody}>
            <TouchableOpacity
              style={[modalStyles.stepperBtn, { backgroundColor: colors.backgroundElement }]}
              onPress={() => adjust(-step)}
              activeOpacity={0.7}
            >
              <ThemedText style={modalStyles.stepperBtnText}>−</ThemedText>
            </TouchableOpacity>

            <View style={modalStyles.stepperCenter}>
              <TextInput
                style={[modalStyles.stepperVal, { color: colors.text }]}
                value={text}
                keyboardType="numeric"
                selectTextOnFocus
                onChangeText={setText}
              />
              <ThemedText themeColor="textSecondary" style={modalStyles.stepperUnit}>
                {unit}
              </ThemedText>
            </View>

            <TouchableOpacity
              style={[modalStyles.stepperBtn, { backgroundColor: colors.backgroundElement }]}
              onPress={() => adjust(step)}
              activeOpacity={0.7}
            >
              <ThemedText style={modalStyles.stepperBtnText}>+</ThemedText>
            </TouchableOpacity>
          </View>
        </Pressable>
      </View>
    </Modal>
  );
}

// ─── Glass Section Card ─────────────────────────────────────────────────────

function GlassSectionCard({
  children,
  isDark,
  glass,
}: {
  children: React.ReactNode;
  isDark: boolean;
  glass: typeof Glass.light | typeof Glass.dark;
}) {
  if (Platform.OS === 'ios') {
    return (
      <View style={[styles.sectionCardOuter, glass.shadow]}>
        <BlurView
          intensity={24}
          tint={isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
          style={[styles.sectionCardBlur, { borderColor: glass.cardStroke }]}
        >
          {children}
        </BlurView>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.sectionCardBlur,
        { backgroundColor: glass.background, borderColor: glass.cardStroke },
        glass.shadow,
      ]}
    >
      {children}
    </View>
  );
}

// ─── Section Header ─────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <View style={styles.sectionHeader}>
      <ThemedText themeColor="textSecondary" style={styles.sectionHeaderText}>
        {label}
      </ThemedText>
    </View>
  );
}

// ─── Main Screen ────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const { token } = useAuthStore();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = Colors[isDark ? 'dark' : 'light'];
  const glass = Glass[isDark ? 'dark' : 'light'];
  const accent = glass.tint;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [modalType, setModalType] = useState<
    | 'gender' | 'age' | 'height' | 'weight'
    | 'activity' | 'targetWeight' | 'goalType'
    | 'targetCalories' | 'tdee'
    | null
  >(null);

  // ── Load profile ────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      const data = await apiFetch<Profile>('/api/user/profile', { token });
      setProfile(data);
    } catch {
      setError('加载失败，请下拉重试');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  // ── Save ────────────────────────────────────────────────────────────────

  const saveField = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!token || !profile) return;
      setProfile((p) => (p ? { ...p, ...patch } : p));
      try {
        const updated = await apiFetch<Profile>('/api/user/profile', {
          method: 'PUT',
          token,
          body: JSON.stringify(patch),
        });
        setProfile(updated);
        queryClient.invalidateQueries({ queryKey: ['profile'] });
      } catch {
        // keep optimistic value
      }
    },
    [token, profile],
  );

  // ── Clear cache ─────────────────────────────────────────────────────────

  const handleClearCache = () => {
    Alert.alert('清除本地缓存', '将清除本地缓存的聊天记录，重新进入聊天页面时会从服务端同步。', [
      { text: '取消', style: 'cancel' },
      {
        text: '确认清除',
        style: 'destructive',
        onPress: async () => {
          try {
            await clearCache();
            Alert.alert('已清除', '本地缓存已清除。');
          } catch {
            Alert.alert('失败', '清除缓存失败，请重试。');
          }
        },
      },
    ]);
  };

  // ── Derived values ──────────────────────────────────────────────────────

  const targetCalories = profile?.target_calories ?? 0;
  const tdee = profile?.tdee ?? 0;
  const deficit = profile?.daily_deficit ?? 500;
  const gender = profile?.gender ?? 'female';
  const age = profile?.age ?? 25;
  const height = profile?.height_cm ?? 165;
  const weight = profile?.weight_kg ?? 60;
  const targetWeight = profile?.target_weight_kg ?? 55;
  const goalType = profile?.goal_type ?? 'cut';
  const activityLevel = profile?.activity_level ?? 'light';

  // ── Summary card editing ───────────────────────────────────────────────

  const handleTargetCaloriesChange = (newTarget: number) => {
    // target_calories = TDEE - deficit → deficit = TDEE - target_calories
    const newDeficit = Math.round(tdee - newTarget);
    const clamped = Math.min(DEFICIT_MAX, Math.max(DEFICIT_MIN, newDeficit));
    saveField({ daily_deficit: clamped });
  };

  const handleTdeeChange = (newTdee: number) => {
    saveField({ custom_tdee: newTdee });
  };

  // ── Revisit onboarding ──────────────────────────────────────────────────

  const startReview = useOnboardingReviewStore((s) => s.startReview);

  const handleRevisitOnboarding = () => {
    if (!profile) return;
    startReview({
      gender: (profile.gender as 'male' | 'female') ?? 'female',
      age: profile.age ?? 25,
      height_cm: profile.height_cm ?? 165,
      weight_kg: profile.weight_kg ?? 60,
      target_weight_kg: profile.target_weight_kg ?? 55,
      activity_level: (profile.activity_level as OnboardingFormData['activity_level']) ?? 'light',
      goal_type: (profile.goal_type as OnboardingFormData['goal_type']) ?? 'cut',
      daily_deficit: profile.daily_deficit ?? 500,
      custom_tdee: profile.custom_tdee ?? null,
    });
  };

  // ── Render ──────────────────────────────────────────────────────────────

  const openModal = (type: NonNullable<typeof modalType>) => setModalType(type);
  const closeModal = () => setModalType(null);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      {/* Header — design: padding 10px 22px 8px, font-size 30px */}
      <View style={styles.header}>
        <ThemedText style={styles.title}>设置</ThemedText>
      </View>

      {loading ? (
        <View style={styles.loader}>
          <ActivityIndicator color={accent} />
        </View>
      ) : error ? (
        <View style={styles.errorWrap}>
          <ThemedText themeColor="textSecondary" style={styles.errorText}>{error}</ThemedText>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {/* ── Summary Card ──────────────────────────────────────────── */}
          <View style={[styles.summaryOuter, glass.shadow]}>
            {Platform.OS === 'ios' ? (
              <BlurView
                intensity={28}
                tint={isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
                style={[
                  styles.summaryBlur,
                  {
                    borderColor: isDark
                      ? 'rgba(10,132,255,0.25)'
                      : 'rgba(0,122,255,0.20)',
                  },
                ]}
              >
                <View
                  style={[
                    StyleSheet.absoluteFill,
                    {
                      backgroundColor: isDark
                        ? 'rgba(10,132,255,0.08)'
                        : 'rgba(0,122,255,0.06)',
                    },
                  ]}
                />
                <View style={styles.summaryInner}>
                  <View style={styles.liveBadge}>
                    <SymbolView
                      name={{ ios: 'arrow.triangle.2.circlepath' as const, android: 'sync' as const, web: 'sync' as const }}
                      size={14}
                      tintColor={accent}
                      style={{ width: 14, height: 14 }}
                    />
                    <ThemedText themeColor="textSecondary" style={styles.liveBadgeText}>
                      改动后实时更新
                    </ThemedText>
                  </View>

                  <View style={styles.summaryValues}>
                    <TouchableOpacity onPress={() => openModal('targetCalories')} activeOpacity={0.6}>
                      <ThemedText themeColor="textSecondary" style={styles.summaryLabel}>
                        每日目标摄入
                      </ThemedText>
                      <View style={styles.summaryBigRow}>
                        <ThemedText style={[styles.summaryBigVal, { color: accent }]}>
                          {fmt(targetCalories)}
                        </ThemedText>
                        <ThemedText themeColor="textSecondary" style={styles.summaryBigUnit}>
                          kcal
                        </ThemedText>
                      </View>
                    </TouchableOpacity>
                    <View style={{ flex: 1 }} />
                    <TouchableOpacity style={styles.summaryMetaItem} onPress={() => openModal('tdee')} activeOpacity={0.6}>
                      <ThemedText themeColor="textSecondary" style={styles.summaryMetaLabel}>
                        TDEE
                      </ThemedText>
                      <ThemedText style={styles.summaryMetaVal}>{fmt(tdee)}</ThemedText>
                    </TouchableOpacity>
                    <View style={styles.summaryMetaItem}>
                      <ThemedText themeColor="textSecondary" style={styles.summaryMetaLabel}>
                        缺口
                      </ThemedText>
                      <ThemedText style={[styles.summaryMetaVal, { color: colors.ok }]}>
                        −{fmt(deficit)}
                      </ThemedText>
                    </View>
                  </View>
                </View>
              </BlurView>
            ) : (
              <View
                style={[
                  styles.summaryBlur,
                  {
                    backgroundColor: isDark
                      ? 'rgba(44,44,48,0.55)'
                      : 'rgba(255,255,255,0.60)',
                    borderColor: isDark
                      ? 'rgba(10,132,255,0.25)'
                      : 'rgba(0,122,255,0.20)',
                  },
                ]}
              >
                <View style={styles.summaryInner}>
                  <View style={styles.liveBadge}>
                    <SymbolView
                      name={{ ios: 'arrow.triangle.2.circlepath' as const, android: 'sync' as const, web: 'sync' as const }}
                      size={14}
                      tintColor={accent}
                      style={{ width: 14, height: 14 }}
                    />
                    <ThemedText themeColor="textSecondary" style={styles.liveBadgeText}>
                      改动后实时更新
                    </ThemedText>
                  </View>

                  <View style={styles.summaryValues}>
                    <TouchableOpacity onPress={() => openModal('targetCalories')} activeOpacity={0.6}>
                      <ThemedText themeColor="textSecondary" style={styles.summaryLabel}>
                        每日目标摄入
                      </ThemedText>
                      <View style={styles.summaryBigRow}>
                        <ThemedText style={[styles.summaryBigVal, { color: accent }]}>
                          {fmt(targetCalories)}
                        </ThemedText>
                        <ThemedText themeColor="textSecondary" style={styles.summaryBigUnit}>
                          kcal
                        </ThemedText>
                      </View>
                    </TouchableOpacity>
                    <View style={{ flex: 1 }} />
                    <TouchableOpacity style={styles.summaryMetaItem} onPress={() => openModal('tdee')} activeOpacity={0.6}>
                      <ThemedText themeColor="textSecondary" style={styles.summaryMetaLabel}>
                        TDEE
                      </ThemedText>
                      <ThemedText style={styles.summaryMetaVal}>{fmt(tdee)}</ThemedText>
                    </TouchableOpacity>
                    <View style={styles.summaryMetaItem}>
                      <ThemedText themeColor="textSecondary" style={styles.summaryMetaLabel}>
                        缺口
                      </ThemedText>
                      <ThemedText style={[styles.summaryMetaVal, { color: colors.ok }]}>
                        −{fmt(deficit)}
                      </ThemedText>
                    </View>
                  </View>
                </View>
              </View>
            )}
          </View>

          {/* ── Body Data Section ────────────────────────────────────── */}
          <View>
            <SectionHeader label="身体数据" />
            <GlassSectionCard isDark={isDark} glass={glass}>
            <View style={styles.sectionCardInner}>
              <SettingsRow
                label="身高"
                value={`${fmt(height)} cm`}
                onPress={() => openModal('height')}
                colors={colors}
                showDivider={false}
              />
              <SettingsRow
                label="体重"
                value={`${weight % 1 === 0 ? Math.round(weight) : weight.toFixed(1)} kg`}
                onPress={() => openModal('weight')}
                colors={colors}
              />
              <SettingsRow
                label="年龄"
                value={`${Math.round(age)}`}
                onPress={() => openModal('age')}
                colors={colors}
              />
              <SettingsRow
                label="性别"
                value={GENDER_LABEL[gender] ?? ''}
                onPress={() => openModal('gender')}
                colors={colors}
              />
              <SettingsRow
                label="活动水平"
                value={ACTIVITY_LABEL[activityLevel] ?? ''}
                onPress={() => openModal('activity')}
                colors={colors}
              />
            </View>
          </GlassSectionCard>
          </View>

          {/* ── Goals Section ────────────────────────────────────────── */}
          <View>
            <SectionHeader label="目标" />
            <GlassSectionCard isDark={isDark} glass={glass}>
            <View style={styles.sectionCardInner}>
              <SettingsRow
                label="目标体重"
                value={`${targetWeight % 1 === 0 ? Math.round(targetWeight) : targetWeight.toFixed(1)} kg`}
                onPress={() => openModal('targetWeight')}
                colors={colors}
                showDivider={false}
              />
              <SettingsRow
                label="目标类型"
                value={GOAL_LABEL[goalType] ?? ''}
                valueColor={accent}
                onPress={() => openModal('goalType')}
                colors={colors}
              />
              {/* Deficit slider (inline, no chevron) */}
              <View style={[styles.rowDivider, { backgroundColor: colors.hairline }]} />
              <View style={styles.deficitBlock}>
                <View style={styles.deficitHeader}>
                  <ThemedText style={styles.rowLabel}>每日缺口</ThemedText>
                  <ThemedText style={[styles.deficitVal, { color: accent }]}>
                    {fmt(deficit)} kcal
                  </ThemedText>
                </View>
                <DeficitSlider
                  value={deficit}
                  onValueChange={(v) => saveField({ daily_deficit: v })}
                  colors={colors}
                  accent={accent}
                />
              </View>
            </View>
          </GlassSectionCard>
          </View>

          {/* ── Revisit Onboarding ───────────────────────────────────── */}
          <GlassSectionCard isDark={isDark} glass={glass}>
            <View style={styles.sectionCardInner}>
              <SettingsRow
                label="📖 重新查看使用引导"
                value=""
                onPress={handleRevisitOnboarding}
                colors={colors}
                showDivider={false}
              />
            </View>
          </GlassSectionCard>

          {/* ── Clear Cache ──────────────────────────────────────────── */}
          <TouchableOpacity
            style={[styles.clearBtn, { borderColor: colors.warn }]}
            onPress={handleClearCache}
            activeOpacity={0.7}
          >
            <ThemedText style={[styles.clearBtnText, { color: colors.warn }]}>
              清除本地缓存
            </ThemedText>
          </TouchableOpacity>

          {/* ── Logout ───────────────────────────────────────────────── */}
          <TouchableOpacity
            style={[styles.logoutBtn]}
            onPress={() => {
              Alert.alert('退出登录', '确定要退出当前账号吗？', [
                { text: '取消', style: 'cancel' },
                {
                  text: '退出',
                  style: 'destructive',
                  onPress: () => useAuthStore.getState().logout(),
                },
              ]);
            }}
            activeOpacity={0.7}
          >
            <ThemedText style={styles.logoutBtnText}>退出登录</ThemedText>
          </TouchableOpacity>

          <View style={styles.bottomSpacer} />
        </ScrollView>
      )}

      {/* ── Modals ──────────────────────────────────────────────────── */}
      <PickerModal
        visible={modalType === 'gender'}
        title="性别"
        options={GENDER_OPTIONS}
        value={gender}
        onSelect={(v) => saveField({ gender: v })}
        onClose={closeModal}
        colors={colors}
        glass={glass}
        accent={accent}
        isDark={isDark}
      />

      <PickerModal
        visible={modalType === 'activity'}
        title="活动水平"
        options={ACTIVITY_OPTIONS}
        value={activityLevel}
        onSelect={(v) => saveField({ activity_level: v })}
        onClose={closeModal}
        colors={colors}
        glass={glass}
        accent={accent}
        isDark={isDark}
      />

      <PickerModal
        visible={modalType === 'goalType'}
        title="目标类型"
        options={GOAL_OPTIONS}
        value={goalType}
        onSelect={(v) => saveField({ goal_type: v })}
        onClose={closeModal}
        colors={colors}
        glass={glass}
        accent={accent}
        isDark={isDark}
      />

      <StepperModal
        visible={modalType === 'age'}
        title="年龄"
        value={age}
        unit="岁"
        min={10}
        max={120}
        onValueChange={(v) => saveField({ age: v })}
        onClose={closeModal}
        colors={colors}
        glass={glass}
        accent={accent}
        isDark={isDark}
      />

      <StepperModal
        visible={modalType === 'height'}
        title="身高"
        value={height}
        unit="cm"
        min={50}
        max={300}
        onValueChange={(v) => saveField({ height_cm: v })}
        onClose={closeModal}
        colors={colors}
        glass={glass}
        accent={accent}
        isDark={isDark}
      />

      <StepperModal
        visible={modalType === 'weight'}
        title="体重"
        value={weight}
        unit="kg"
        min={20}
        max={500}
        step={0.5}
        decimals={1}
        onValueChange={(v) => saveField({ weight_kg: v })}
        onClose={closeModal}
        colors={colors}
        glass={glass}
        accent={accent}
        isDark={isDark}
      />

      <StepperModal
        visible={modalType === 'targetWeight'}
        title="目标体重"
        value={targetWeight}
        unit="kg"
        min={20}
        max={500}
        step={0.5}
        decimals={1}
        onValueChange={(v) => saveField({ target_weight_kg: v })}
        onClose={closeModal}
        colors={colors}
        glass={glass}
        accent={accent}
        isDark={isDark}
      />

      <StepperModal
        visible={modalType === 'targetCalories'}
        title="每日目标摄入"
        value={targetCalories}
        unit="kcal"
        min={800}
        max={5000}
        step={10}
        onValueChange={handleTargetCaloriesChange}
        onClose={closeModal}
        colors={colors}
        glass={glass}
        accent={accent}
        isDark={isDark}
      />

      <StepperModal
        visible={modalType === 'tdee'}
        title="TDEE"
        value={tdee}
        unit="kcal"
        min={800}
        max={6000}
        step={10}
        onValueChange={handleTdeeChange}
        onClose={closeModal}
        colors={colors}
        glass={glass}
        accent={accent}
        isDark={isDark}
      />
    </SafeAreaView>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Header — design: padding 10px 22px 8px, font-size 30px
  header: { paddingHorizontal: 22, paddingTop: 10, paddingBottom: 8 },
  title: { fontSize: 30, fontWeight: '700', letterSpacing: -0.6, lineHeight: 36 },

  // States
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  errorText: { fontSize: FontSize.base, textAlign: 'center' },

  // Scroll — design: padding 6px 16px 100px, gap 18px
  scroll: { flex: 1 },
  content: {
    paddingTop: 6,
    paddingHorizontal: 16,
    paddingBottom: BottomTabInset + Spacing.three,
    gap: 18,
  },

  // ── Summary Card ──────────────────────────────────────────────────────
  summaryOuter: {
    borderRadius: 22,
  },
  summaryBlur: {
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  summaryInner: {
    padding: 16,
    paddingHorizontal: 18,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 10,
  },
  liveBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  summaryValues: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 18,
  },
  summaryLabel: { fontSize: 11, marginBottom: 2 },
  summaryBigRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  summaryBigVal: { fontSize: 28, fontWeight: '800', letterSpacing: -0.5, lineHeight: 34 },
  summaryBigUnit: { fontSize: 12 },
  summaryMetaItem: { alignItems: 'flex-end' },
  summaryMetaLabel: { fontSize: 11, marginBottom: 2 },
  summaryMetaVal: { fontSize: 15, fontWeight: '700' },

  // ── Section Cards ─────────────────────────────────────────────────────
  sectionCardOuter: {
    borderRadius: 18,
  },
  sectionCardBlur: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  sectionCardInner: { paddingHorizontal: 16 },

  // Section header — design: font-size 12px, text2, font-weight 600, padding 0 6px 7px
  sectionHeader: { paddingHorizontal: 6, paddingBottom: 7 },
  sectionHeaderText: { fontSize: 12, fontWeight: '600', letterSpacing: 0.3 },

  // Settings row — design: padding 13px 0
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
  },
  rowDivider: { height: StyleSheet.hairlineWidth },
  rowLabel: { flex: 1, fontSize: 15 },
  rowValue: { fontSize: 15 },
  rowChevron: { width: 16, height: 16, marginLeft: 8 },

  // Deficit block (inline in section card)
  deficitBlock: { paddingVertical: 13 },
  deficitHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 0,
  },
  deficitVal: { fontSize: 15, fontWeight: '600' },

  // Clear cache button
  clearBtn: {
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 2,
  },
  clearBtnText: { fontSize: 15, fontWeight: '600' },

  // Logout button
  logoutBtn: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  logoutBtnText: { fontSize: 15, fontWeight: '500', color: '#FF3B30' },

  bottomSpacer: { height: 8 },
});

// ─── Modal Styles ───────────────────────────────────────────────────────────

const modalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 40,
  },
  card: {
    marginHorizontal: 16,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    paddingVertical: 12,
    textAlign: 'center',
  },

  // Picker option
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    gap: 12,
  },
  optionText: { flex: 1 },
  optionLabel: { fontSize: 16, fontWeight: '500' },
  optionDesc: { fontSize: 12, marginTop: 1 },

  // Stepper
  stepperHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  doneBtn: { fontSize: 16, fontWeight: '600' },
  stepperBody: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    paddingVertical: 20,
  },
  stepperBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperBtnText: { fontSize: 26, fontWeight: '400', lineHeight: 30 },
  stepperCenter: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    minWidth: 100,
    justifyContent: 'center',
  },
  stepperVal: {
    fontSize: 40,
    fontWeight: '700',
    letterSpacing: -1,
    minWidth: 60,
    textAlign: 'center',
    padding: 0,
  },
  stepperUnit: { fontSize: 16, fontWeight: '600' },
});
