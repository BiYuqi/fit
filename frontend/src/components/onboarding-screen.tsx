import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GradientBackground } from '@/components/gradient-background';
import { Colors, FontSize, Glass } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { apiFetch } from '@/lib/api';
import { useAuthStore } from '@/stores/auth-store';

// ─── Constants ──────────────────────────────────────────────────────────────

const TOTAL_STEPS = 7;

const ACTIVITY_OPTIONS = [
  { value: 'sedentary' as const, label: '久坐', desc: '几乎不运动，以办公室生活为主', icon: { ios: 'laptopcomputer' as const, android: 'computer' as const, web: 'computer' as const } },
  { value: 'light' as const, label: '轻度', desc: '每周轻度运动 1-3 天', icon: { ios: 'figure.walk' as const, android: 'directions_walk' as const, web: 'directions_walk' as const } },
  { value: 'moderate' as const, label: '中度', desc: '每周运动 3-5 天', icon: { ios: 'figure.run' as const, android: 'directions_run' as const, web: 'directions_run' as const } },
  { value: 'active' as const, label: '高强度', desc: '每周高强度训练 6-7 天', icon: { ios: 'dumbbell' as const, android: 'fitness_center' as const, web: 'fitness_center' as const } },
  { value: 'very_active' as const, label: '极高', desc: '体力工作，或每天高强度训练', icon: { ios: 'flame' as const, android: 'local_fire_department' as const, web: 'local_fire_department' as const } },
];

const PACE_OPTIONS = [
  { value: 250, label: '温和', desc: '约 0.25 kg/周 - 最容易坚持', recommended: false },
  { value: 420, label: '标准', desc: '约 0.4 kg/周 - 速度与可持续兼顾', recommended: true },
  { value: 600, label: '激进', desc: '约 0.6 kg/周 - 需要更强毅力', recommended: false },
];

const GOAL_TYPE_OPTIONS = [
  { value: 'cut' as const, label: '减脂', desc: '创造热量缺口，逐步降低体重', icon: { ios: 'arrow.down.circle' as const, android: 'trending_down' as const, web: 'trending_down' as const } },
  // 维持模式暂隐藏（引导只做减脂，goal_type 默认 cut）。恢复时取消下一行注释即可。
  // { value: 'maintain' as const, label: '维持', desc: '保持当前体重，摄入约等于消耗', icon: { ios: 'equal.circle' as const, android: 'balance' as const, web: 'balance' as const } },
];

const ACTIVITY_COEFF: Record<string, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

// ─── Types ───────────────────────────────────────────────────────────────────

type FormData = {
  gender: 'male' | 'female';
  age: number;
  height_cm: number;
  weight_kg: number;
  target_weight_kg: number;
  activity_level: 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
  goal_type: 'cut' | 'maintain';
  daily_deficit: number;
};

type ProfileResp = {
  onboarded: boolean;
  bmr: number;
  tdee: number;
  target_calories: number;
  target_protein: number;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function estimateBMR(d: FormData) {
  return d.gender === 'male'
    ? 10 * d.weight_kg + 6.25 * d.height_cm - 5 * d.age + 5
    : 10 * d.weight_kg + 6.25 * d.height_cm - 5 * d.age - 161;
}

function estimateTDEE(d: FormData) {
  return Math.round(estimateBMR(d) * (ACTIVITY_COEFF[d.activity_level] ?? 1.2));
}

function estimateWeeksToGoal(d: FormData): number | null {
  const diff = d.weight_kg - d.target_weight_kg;
  if (diff <= 0) return null;
  return Math.round(diff / 0.4);
}

function fmt(n: number) {
  return n.toLocaleString('en-US');
}

// ─── Component ────────────────────────────────────────────────────────────────

type Props = { onComplete: () => void; initialData?: Partial<FormData & { custom_tdee: number | null }> };

export function OnboardingScreen({ onComplete, initialData }: Props) {
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [profile, setProfile] = useState<ProfileResp | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // TDEE editing state
  const [customTdee, setCustomTdee] = useState<number | null>(
    initialData?.custom_tdee ?? null,
  );
  const [editingTdee, setEditingTdee] = useState(false);
  const [tdeeInputValue, setTdeeInputValue] = useState('');

  const { token } = useAuthStore();

  const scheme = useColorScheme();
  const colors = Colors[scheme];
  const glass = Glass[scheme];
  const accent = glass.tint;
  const accentSoft = scheme === 'light' ? 'rgba(0,122,255,0.10)' : 'rgba(10,132,255,0.14)';
  const cardBg = glass.background;
  const cardBorder = glass.border;
  const text3 = scheme === 'light' ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.28)';
  const hairline = scheme === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.10)';

  const defaults: FormData = {
    gender: 'female',
    age: 25,
    height_cm: 165,
    weight_kg: 60,
    target_weight_kg: 55,
    activity_level: 'light',
    goal_type: 'cut',
    daily_deficit: 420,
  };

  const { watch, setValue, getValues } = useForm<FormData>({
    defaultValues: initialData ? { ...defaults, ...initialData } : defaults,
  });

  const fd = watch();

  // Derived values

  const isResult = step === 7;
  const estimatedTdee = step >= 5 ? estimateTDEE(fd) : 0;
  const effectiveTdee = customTdee ?? estimatedTdee;
  const bmrFloor = step >= 5 ? Math.round(estimateBMR(fd)) : 0;

  const targetEstimate =
    step >= 6 && fd.goal_type === 'cut'
      ? effectiveTdee - fd.daily_deficit
      : 0;

  const weeksToGoal = step >= 3 ? estimateWeeksToGoal(fd) : null;

  const isCustomDeficit =
    step === 6 && fd.daily_deficit > 0 && !PACE_OPTIONS.some((p) => p.value === fd.daily_deficit);

  // Handlers

  const goNext = () => setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  const goBack = () => setStep((s) => Math.max(s - 1, 1));

  const beginEditTdee = () => {
    setTdeeInputValue(String(effectiveTdee));
    setEditingTdee(true);
  };

  const confirmTdee = () => {
    const n = parseInt(tdeeInputValue, 10);
    if (!isNaN(n) && n >= 800 && n <= 6000) {
      setCustomTdee(n);
    }
    setEditingTdee(false);
  };

  const submit = async () => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const data = getValues();
      const body: Record<string, unknown> = {
        gender: data.gender,
        age: data.age,
        height_cm: data.height_cm,
        weight_kg: data.weight_kg,
        target_weight_kg: data.target_weight_kg,
        activity_level: data.activity_level,
        goal_type: data.goal_type,
      };
      if (data.goal_type === 'cut') {
        body.daily_deficit = data.daily_deficit;
      } else {
        body.daily_deficit = 0;
      }
      if (customTdee !== null) {
        body.custom_tdee = customTdee;
      }
      // T51：有 initialData = 从设置页「重看引导」进来的（首次引导不传 initialData）。
      // 重看是回看/调目标，不是称重——告诉后端别把这次的体重当 weight_log 测点。
      if (initialData != null) {
        body.is_review = true;
      }
      const resp = await apiFetch<ProfileResp>('/api/user/profile', {
        method: 'PUT',
        token,
        body: JSON.stringify(body),
      });
      setProfile(resp);
      setStep(7);
    } catch {
      setSubmitError('提交失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  // Stepper — free typing, validates on blur or +/- press

  function Stepper({
    field,
    min,
    max,
    step: inc = 1,
    unit,
    decimals = 0,
    compact = false,
  }: {
    field: keyof FormData;
    min: number;
    max: number;
    step?: number;
    unit: string;
    decimals?: number;
    compact?: boolean;
  }) {
    const formVal = fd[field] as number;
    const [localVal, setLocalVal] = useState<string | null>(null);
    const [focused, setFocused] = useState(false);

    const fmtDisplay = (v: number) =>
      decimals > 0 ? v.toFixed(decimals) : String(Math.round(v));

    const display = focused && localVal !== null ? localVal : fmtDisplay(formVal);

    const clamp = (n: number) =>
      Math.min(max, Math.max(min, parseFloat(n.toFixed(decimals))));

    const commit = (text?: string) => {
      const t = text ?? localVal;
      if (t !== null && t !== '') {
        const n = parseFloat(t);
        if (!isNaN(n)) setValue(field, clamp(n) as FormData[typeof field]);
      }
      setLocalVal(null);
      setFocused(false);
    };

    const adjust = (delta: number) => {
      setValue(field, clamp(formVal + delta) as FormData[typeof field]);
      setLocalVal(null);
    };

    return (
      <View
        style={[
          compact ? ss.stepperCardCompact : ss.stepperCard,
          { backgroundColor: cardBg, borderColor: cardBorder },
        ]}
      >
        <TouchableOpacity
          style={[ss.stepBtn, compact && ss.stepBtnCompact, { backgroundColor: colors.backgroundElement }]}
          onPress={() => adjust(-inc)}
          hitSlop={12}
          activeOpacity={0.7}
        >
          <Text style={[ss.stepBtnText, { color: colors.text }]}>-</Text>
        </TouchableOpacity>
        <View style={ss.stepperCenter}>
          <TextInput
            style={[compact ? ss.stepperValCompact : ss.stepperVal, { color: colors.text }]}
            value={display}
            keyboardType="numeric"
            selectTextOnFocus
            onFocus={() => {
              setLocalVal(fmtDisplay(formVal));
              setFocused(true);
            }}
            onChangeText={(t) => setLocalVal(t)}
            onBlur={() => commit()}
            onSubmitEditing={() => commit()}
          />
          <Text style={[ss.stepperUnit, compact && ss.stepperUnitCompact, { color: colors.textSecondary }]}>
            {unit}
          </Text>
        </View>
        <TouchableOpacity
          style={[ss.stepBtn, compact && ss.stepBtnCompact, { backgroundColor: colors.backgroundElement }]}
          onPress={() => adjust(inc)}
          hitSlop={12}
          activeOpacity={0.7}
        >
          <Text style={[ss.stepBtnText, { color: colors.text }]}>+</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Editable TDEE

  function TdeeValue({ style }: { style?: object }) {
    if (editingTdee) {
      return (
        <TextInput
          style={[ss.tdeeEditInput, { color: accent, borderColor: accent }]}
          value={tdeeInputValue}
          keyboardType="numeric"
          selectTextOnFocus
          autoFocus
          onChangeText={setTdeeInputValue}
          onBlur={confirmTdee}
          onSubmitEditing={confirmTdee}
        />
      );
    }
    return (
      <TouchableOpacity onPress={beginEditTdee} hitSlop={10} activeOpacity={0.6}>
        <Text style={[{ color: accent, fontWeight: '700' }, style]}>
          {fmt(effectiveTdee)}
        </Text>
      </TouchableOpacity>
    );
  }

  // Render

  return (
    <GradientBackground style={ss.container}>
      <SafeAreaView style={ss.safe}>
        <ScrollView
          contentContainerStyle={ss.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Progress header */}
          <View style={ss.header}>
            {!isResult ? (
              <>
                {step > 1 ? (
                  <TouchableOpacity onPress={goBack} hitSlop={14} style={ss.backBtn}>
                    <SymbolView
                      name={{ ios: 'chevron.left', android: 'chevron_left', web: 'chevron_left' }}
                      size={22}
                      tintColor={colors.textSecondary}
                      style={{ width: 22, height: 22 }}
                    />
                  </TouchableOpacity>
                ) : (
                  <View style={ss.backBtnPlaceholder} />
                )}
                <View style={[ss.progressTrack, { backgroundColor: colors.backgroundElement }]}>
                  <View
                    style={[
                      ss.progressFill,
                      { width: `${Math.round((step / TOTAL_STEPS) * 100)}%`, backgroundColor: accent },
                    ]}
                  />
                </View>
                <Text style={[ss.stepLabel, { color: colors.textSecondary }]}>
                  {step}/{TOTAL_STEPS}
                </Text>
              </>
            ) : (
              <>
                <View style={[ss.progressTrack, { flex: 1, backgroundColor: colors.backgroundElement }]}>
                  <View style={[ss.progressFill, { width: '100%', backgroundColor: accent }]} />
                </View>
                <View style={ss.completeTag}>
                  <SymbolView
                    name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }}
                    size={15}
                    tintColor="#34C759"
                    style={{ width: 15, height: 15 }}
                  />
                  <Text style={[ss.completeText, { color: '#34C759' }]}>完成</Text>
                </View>
              </>
            )}
          </View>

          {/* Step 1: Gender */}
          {step === 1 && (
            <View style={ss.stepContent}>
              <Text style={[ss.title, { color: colors.text }]}>你的生理性别？</Text>
              <Text style={[ss.subtitle, { color: colors.textSecondary }]}>
                用于更准确地估算你的基础代谢率（BMR）。
              </Text>
              <View style={ss.genderCards}>
                {(['female', 'male'] as const).map((g) => {
                  const selected = fd.gender === g;
                  return (
                    <TouchableOpacity
                      key={g}
                      style={[
                        ss.genderCard,
                        {
                          backgroundColor: selected ? accentSoft : cardBg,
                          borderWidth: selected ? 1.5 : 0.5,
                          borderColor: selected ? accent : cardBorder,
                        },
                      ]}
                      onPress={() => setValue('gender', g)}
                      activeOpacity={0.8}
                    >
                      <View style={[ss.genderIconBox, { backgroundColor: selected ? accent : colors.backgroundElement }]}>
                        <Text style={[ss.genderIconChar, { color: selected ? '#fff' : g === 'female' ? '#FF2D55' : '#007AFF' }]}>
                          {g === 'female' ? '♀' : '♂'}
                        </Text>
                      </View>
                      <Text style={[ss.genderLabel, { color: selected ? accent : colors.text, flex: 1 }]}>
                        {g === 'female' ? '女' : '男'}
                      </Text>
                      {selected ? (
                        <SymbolView
                          name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }}
                          size={24}
                          tintColor={accent}
                          style={{ width: 24, height: 24 }}
                        />
                      ) : (
                        <View style={[ss.radioCircle, { borderColor: text3 }]} />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {/* Step 2: Age */}
          {step === 2 && (
            <View style={ss.stepContent}>
              <Text style={[ss.title, { color: colors.text }]}>你的年龄？</Text>
              <Text style={[ss.subtitle, { color: colors.textSecondary }]}>
                年龄影响基础代谢的计算结果。
              </Text>
              <View style={ss.singlePickerWrap}>
                <Stepper field="age" min={10} max={100} unit="岁" />
              </View>
            </View>
          )}

          {/* Step 3: Body - height + weight + target weight */}
          {step === 3 && (
            <View style={ss.stepContent}>
              <Text style={[ss.title, { color: colors.text }]}>你的身高和体重？</Text>
              <Text style={[ss.subtitle, { color: colors.textSecondary }]}>
                用来估算基础代谢，越准越好。
              </Text>

              {/* Height + Weight side-by-side */}
              <View style={ss.bodyRow}>
                <View style={ss.bodyPickerWrap}>
                  <Text style={[ss.bodyPickerLabel, { color: colors.textSecondary }]}>身高</Text>
                  <Stepper field="height_cm" min={100} max={250} unit="cm" compact />
                </View>
                <View style={ss.bodyPickerWrap}>
                  <Text style={[ss.bodyPickerLabel, { color: colors.textSecondary }]}>当前体重</Text>
                  <Stepper field="weight_kg" min={30} max={300} step={0.5} unit="kg" decimals={1} compact />
                </View>
              </View>

              {/* Target weight card */}
              <View style={[ss.targetCard, { backgroundColor: accentSoft, borderColor: accent }]}>
                <View style={ss.targetHeader}>
                  <Text style={[ss.targetCardLabel, { color: accent }]}>目标体重</Text>
                  <Text style={[ss.targetDiff, { color: accent }]}>
                    {fd.target_weight_kg < fd.weight_kg
                      ? `比现在轻 ${(fd.weight_kg - fd.target_weight_kg).toFixed(1)} kg`
                      : fd.target_weight_kg > fd.weight_kg
                        ? `比现在重 ${(fd.target_weight_kg - fd.weight_kg).toFixed(1)} kg`
                        : '与当前体重相同'}
                  </Text>
                </View>
                <View style={ss.targetBigNum}>
                  <Text style={[ss.targetNum, { color: accent }]}>{fd.target_weight_kg.toFixed(1)}</Text>
                  <Text style={[ss.targetNumUnit, { color: accent }]}>kg</Text>
                </View>
                <Stepper field="target_weight_kg" min={30} max={300} step={0.5} unit="kg" decimals={1} />
              </View>

              {/* Weeks-to-goal hint */}
              {weeksToGoal !== null && weeksToGoal > 0 && (
                <View style={ss.infoHint}>
                  <SymbolView
                    name={{ ios: 'info.circle', android: 'info', web: 'info' }}
                    size={17}
                    tintColor={colors.textSecondary}
                    style={{ width: 17, height: 17 }}
                  />
                  <Text style={[ss.infoHintText, { color: colors.textSecondary }]}>
                    按推荐节奏，约{' '}
                    <Text style={{ fontWeight: '700', color: colors.text }}>{weeksToGoal} 周</Text>{' '}
                    达成 - 后面可调整。
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* Step 4: Activity Level */}
          {step === 4 && (
            <View style={ss.stepContent}>
              <Text style={[ss.title, { color: colors.text }]}>日常活动水平？</Text>
              <Text style={[ss.subtitle, { color: colors.textSecondary }]}>
                选最接近你一周状态的一档。
              </Text>
              <View style={ss.activityList}>
                {ACTIVITY_OPTIONS.map((opt) => {
                  const selected = fd.activity_level === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[
                        ss.activityCard,
                        {
                          backgroundColor: selected ? accentSoft : cardBg,
                          borderWidth: selected ? 1.5 : 0.5,
                          borderColor: selected ? accent : cardBorder,
                        },
                      ]}
                      onPress={() => setValue('activity_level', opt.value)}
                      activeOpacity={0.8}
                    >
                      <SymbolView
                        name={opt.icon}
                        size={24}
                        tintColor={selected ? accent : colors.textSecondary}
                        style={ss.activityIcon}
                      />
                      <View style={ss.activityText}>
                        <Text style={[ss.activityLabel, { color: selected ? accent : colors.text }]}>
                          {opt.label}
                        </Text>
                        <Text
                          style={[
                            ss.activityDesc,
                            { color: selected ? accent : colors.textSecondary, opacity: selected ? 0.85 : 1 },
                          ]}
                        >
                          {opt.desc}
                        </Text>
                      </View>
                      {selected ? (
                        <SymbolView
                          name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }}
                          size={22}
                          tintColor={accent}
                          style={{ width: 22, height: 22 }}
                        />
                      ) : (
                        <View style={[ss.radioSmall, { borderColor: text3 }]} />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {/* Step 5: Goal Type */}
          {step === 5 && (
            <View style={ss.stepContent}>
              <Text style={[ss.title, { color: colors.text }]}>你的目标是什么？</Text>
              <Text style={[ss.subtitle, { color: colors.textSecondary }]}>
                减脂会创造热量缺口，维持则摄入约等于消耗。
              </Text>
              <View style={ss.activityList}>
                {GOAL_TYPE_OPTIONS.map((opt) => {
                  const selected = fd.goal_type === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      style={[
                        ss.activityCard,
                        {
                          backgroundColor: selected ? accentSoft : cardBg,
                          borderWidth: selected ? 1.5 : 0.5,
                          borderColor: selected ? accent : cardBorder,
                        },
                      ]}
                      onPress={() => setValue('goal_type', opt.value)}
                      activeOpacity={0.8}
                    >
                      <SymbolView
                        name={opt.icon}
                        size={24}
                        tintColor={selected ? accent : colors.textSecondary}
                        style={ss.activityIcon}
                      />
                      <View style={ss.activityText}>
                        <Text style={[ss.activityLabel, { color: selected ? accent : colors.text }]}>
                          {opt.label}
                        </Text>
                        <Text
                          style={[
                            ss.activityDesc,
                            { color: selected ? accent : colors.textSecondary, opacity: selected ? 0.85 : 1 },
                          ]}
                        >
                          {opt.desc}
                        </Text>
                      </View>
                      {selected ? (
                        <SymbolView
                          name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }}
                          size={22}
                          tintColor={accent}
                          style={{ width: 22, height: 22 }}
                        />
                      ) : (
                        <View style={[ss.radioSmall, { borderColor: text3 }]} />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Mini TDEE row for maintain */}
              {fd.goal_type === 'maintain' && (
                <View style={[ss.tdeeMiniCard, { backgroundColor: cardBg, borderColor: cardBorder }]}>
                  <Text style={[ss.tdeeMiniLabel, { color: colors.textSecondary }]}>估算总消耗 TDEE</Text>
                  <View style={ss.tdeeMiniRight}>
                    {editingTdee ? (
                      <TextInput
                        style={[ss.tdeeEditInput, { color: accent, borderColor: accent }]}
                        value={tdeeInputValue}
                        keyboardType="numeric"
                        selectTextOnFocus
                        autoFocus
                        onChangeText={setTdeeInputValue}
                        onBlur={confirmTdee}
                        onSubmitEditing={confirmTdee}
                      />
                    ) : (
                      <TouchableOpacity onPress={beginEditTdee} hitSlop={10} activeOpacity={0.6}>
                        <Text style={[ss.tdeeMiniVal, { color: accent }]}>{fmt(effectiveTdee)}</Text>
                      </TouchableOpacity>
                    )}
                    <Text style={[ss.tdeeMiniUnit, { color: colors.textSecondary }]}>kcal</Text>
                    {!editingTdee && (
                      <TouchableOpacity onPress={beginEditTdee} hitSlop={10}>
                        <SymbolView
                          name={{ ios: 'pencil', android: 'edit', web: 'edit' }}
                          size={14}
                          tintColor={accent}
                          style={{ width: 14, height: 14, marginLeft: 4 }}
                        />
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              )}

              {submitError && fd.goal_type === 'maintain' && (
                <Text style={ss.errorText}>{submitError}</Text>
              )}
            </View>
          )}

          {/* Step 6: Pace (cut only) */}
          {step === 6 && fd.goal_type === 'cut' && (
            <View style={ss.stepContent}>
              <Text style={[ss.title, { color: colors.text }]}>想用什么节奏减？</Text>
              <Text style={[ss.subtitle, { color: colors.textSecondary }]}>
                按你的目标推荐了安全缺口，之后随时能在设置里改。
              </Text>
              <View style={ss.paceList}>
                {PACE_OPTIONS.map((opt) => {
                  const selected = fd.daily_deficit === opt.value;
                  return (
                    <View key={opt.value} style={ss.paceCardWrap}>
                      {opt.recommended && (
                        <View style={[ss.recommendedBadge, { backgroundColor: accent }]}>
                          <Text style={ss.recommendedText}>推荐</Text>
                        </View>
                      )}
                      <TouchableOpacity
                        style={[
                          ss.paceCard,
                          {
                            backgroundColor: selected ? accentSoft : cardBg,
                            borderWidth: selected ? 1.5 : 0.5,
                            borderColor: selected ? accent : cardBorder,
                          },
                        ]}
                        onPress={() => setValue('daily_deficit', opt.value)}
                        activeOpacity={0.8}
                      >
                        <View style={ss.paceText}>
                          <Text style={[ss.paceLabel, { color: selected ? accent : colors.text }]}>
                            {opt.label}
                          </Text>
                          <Text
                            style={[
                              ss.paceDesc,
                              { color: selected ? accent : colors.textSecondary, opacity: selected ? 0.85 : 1 },
                            ]}
                          >
                            {opt.desc}
                          </Text>
                        </View>
                        <View style={ss.paceRight}>
                          <Text style={[ss.paceKcal, { color: selected ? accent : colors.text }]}>
                            -{opt.value}
                          </Text>
                          <Text style={[ss.paceKcalUnit, { color: selected ? accent : colors.textSecondary }]}>
                            kcal/天
                          </Text>
                        </View>
                        {selected ? (
                          <SymbolView
                            name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }}
                            size={22}
                            tintColor={accent}
                            style={{ width: 22, height: 22 }}
                          />
                        ) : (
                          <View style={[ss.radioSmall, { borderColor: text3 }]} />
                        )}
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>

              {/* Custom deficit indicator */}
              {isCustomDeficit && (
                <View style={[ss.customDeficitRow, { backgroundColor: accentSoft, borderColor: accent }]}>
                  <SymbolView
                    name={{ ios: 'info.circle.fill', android: 'info', web: 'info' }}
                    size={15}
                    tintColor={accent}
                    style={{ width: 15, height: 15 }}
                  />
                  <Text style={[ss.customDeficitText, { color: accent }]}>
                    当前自定义缺口 {fmt(fd.daily_deficit)} kcal/天 - 选择上方选项可更改
                  </Text>
                </View>
              )}

              {/* TDEE preview card */}
              <View style={[ss.previewCard, { backgroundColor: cardBg, borderColor: cardBorder }]}>
                {/* Row 1: TDEE */}
                <View style={ss.previewRow}>
                  <Text style={[ss.previewLabel, { color: colors.textSecondary }]}>总消耗 TDEE</Text>
                  <View style={ss.previewValueGroup}>
                    {editingTdee ? (
                      <TextInput
                        style={[ss.tdeeEditInput, { color: accent, borderColor: accent }]}
                        value={tdeeInputValue}
                        keyboardType="numeric"
                        selectTextOnFocus
                        autoFocus
                        onChangeText={setTdeeInputValue}
                        onBlur={confirmTdee}
                        onSubmitEditing={confirmTdee}
                      />
                    ) : (
                      <TouchableOpacity onPress={beginEditTdee} hitSlop={10} activeOpacity={0.6}>
                        <Text style={[ss.previewValue, { color: accent }]}>{fmt(effectiveTdee)}</Text>
                      </TouchableOpacity>
                    )}
                    <Text style={[ss.previewUnit, { color: colors.textSecondary }]}>kcal</Text>
                    {!editingTdee && (
                      <TouchableOpacity onPress={beginEditTdee} hitSlop={10}>
                        <SymbolView
                          name={{ ios: 'pencil', android: 'edit', web: 'edit' }}
                          size={15}
                          tintColor={accent}
                          style={{ width: 15, height: 15, marginLeft: 4 }}
                        />
                      </TouchableOpacity>
                    )}
                  </View>
                </View>

                {/* Row 2: Deficit */}
                <View style={ss.previewRow}>
                  <Text style={[ss.previewLabel, { color: colors.textSecondary }]}>- 每日缺口</Text>
                  <View style={ss.previewValueGroup}>
                    <Text style={[ss.previewValue, { color: '#34C759' }]}>{fmt(fd.daily_deficit)}</Text>
                    <Text style={[ss.previewUnit, { color: colors.textSecondary }]}>kcal</Text>
                  </View>
                </View>

                <View style={[ss.divider, { backgroundColor: hairline }]} />

                {/* Row 3: Target */}
                <View style={ss.previewRow}>
                  <Text style={[ss.previewLabelBold, { color: colors.textSecondary }]}>每天目标摄入</Text>
                  <View style={ss.previewValueGroup}>
                    <Text style={[ss.previewValueBig, { color: accent }]}>
                      {fmt(Math.max(0, targetEstimate))}
                    </Text>
                    <Text style={[ss.previewUnit, { color: colors.textSecondary }]}>kcal</Text>
                  </View>
                </View>
              </View>

              {/* Safety floor */}
              <View style={ss.safetyRow}>
                <SymbolView
                  name={{ ios: 'shield.checkered', android: 'verified_user', web: 'verified_user' }}
                  size={17}
                  tintColor="#34C759"
                  style={{ width: 17, height: 17 }}
                />
                <Text style={[ss.safetyText, { color: colors.textSecondary }]}>
                  已为你避开过低摄入，不会低于基础代谢{' '}
                  <Text style={{ fontWeight: '700', color: colors.text }}>{fmt(bmrFloor)} kcal</Text>。
                </Text>
              </View>

              {/* Settings hint */}
              <Text style={[ss.settingsHint, { color: colors.textSecondary }]}>
                之后随时能在设置里调整。
              </Text>

              {submitError && <Text style={ss.errorText}>{submitError}</Text>}
            </View>
          )}

          {/* Step 7: Result */}
          {step === 7 && profile && (
            <View style={ss.stepContent}>
              <View style={ss.resultHero}>
                <View style={[ss.resultIcon, { backgroundColor: accent, shadowColor: accent }]}>
                  <SymbolView
                    name={{ ios: 'party.popper', android: 'celebration', web: 'celebration' }}
                    size={32}
                    tintColor="#fff"
                    style={{ width: 32, height: 32 }}
                  />
                </View>
                <Text style={[ss.resultTagline, { color: colors.textSecondary }]}>
                  {fd.goal_type === 'maintain'
                    ? '维持当前体重，你每天大约可以吃'
                    : '为你算好啦，你每天大约可以吃'}
                </Text>
                <View style={ss.resultBigNum}>
                  <Text style={[ss.resultBigVal, { color: accent }]}>
                    {fmt(Math.round(profile.target_calories))}
                  </Text>
                  <Text style={[ss.resultBigUnit, { color: colors.textSecondary }]}>kcal</Text>
                </View>
                <Text style={[ss.resultSub, { color: colors.textSecondary }]}>
                  {fd.goal_type === 'maintain'
                    ? '摄入约等于总消耗，保持体重稳定。'
                    : `按每天 -${fmt(profile.tdee - Math.round(profile.target_calories))} kcal 缺口，
                    预计每周减约 ${((profile.tdee - Math.round(profile.target_calories)) / 1000).toFixed(1)} kg`}
                </Text>
              </View>

              {/* Breakdown card */}
              <View style={[ss.breakdownCard, { backgroundColor: cardBg, borderColor: cardBorder }]}>
                {(fd.goal_type === 'maintain'
                  ? [
                      { label: '总消耗 TDEE', val: `${fmt(Math.round(profile.tdee))} kcal`, accent: false },
                      {
                        label: '目标摄入',
                        val: `${fmt(Math.round(profile.target_calories))} kcal`,
                        accent: false,
                        bold: true,
                      },
                    ]
                  : [
                      { label: '总消耗 TDEE', val: `${fmt(Math.round(profile.tdee))} kcal`, accent: false },
                      {
                        label: '每日缺口',
                        val: `- ${fmt(profile.tdee - Math.round(profile.target_calories))} kcal`,
                        accent: true,
                      },
                      {
                        label: '目标摄入',
                        val: `${fmt(Math.round(profile.target_calories))} kcal`,
                        accent: false,
                        bold: true,
                      },
                    ]
                ).map((row, i, arr) => (
                  <View key={row.label}>
                    <View style={ss.breakdownRow}>
                      <Text style={[ss.breakdownLabel, { color: colors.textSecondary }]}>{row.label}</Text>
                      <Text
                        style={[
                          ss.breakdownVal,
                          {
                            color: row.accent ? accent : colors.text,
                            fontWeight: row.bold ? '700' : '600',
                          },
                        ]}
                      >
                        {row.val}
                      </Text>
                    </View>
                    {i < arr.length - 1 && <View style={[ss.divider, { backgroundColor: hairline }]} />}
                  </View>
                ))}
              </View>

              {/* Macro estimates */}
              <View style={ss.macroRow}>
                {[
                  { label: '蛋白', dot: '#34C759', val: `${Math.round(profile.target_protein)}g` },
                  { label: '脂肪', dot: '#FF9F0A', val: `${Math.round((profile.target_calories * 0.30) / 9)}g` },
                  {
                    label: '碳水',
                    dot: '#5E5CE6',
                    val: `${Math.round(
                      (profile.target_calories - profile.target_protein * 4 - profile.target_calories * 0.30) / 4,
                    )}g`,
                  },
                ].map((m) => (
                  <View key={m.label} style={[ss.macroCard, { backgroundColor: cardBg, borderColor: cardBorder }]}>
                    <View style={ss.macroDotRow}>
                      <View style={[ss.macroDot, { backgroundColor: m.dot }]} />
                      <Text style={[ss.macroLabel, { color: colors.textSecondary }]}>{m.label}</Text>
                    </View>
                    <Text style={[ss.macroVal, { color: colors.text }]}>{m.val}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          <View style={{ flex: 1, minHeight: 28 }} />

          {/* CTA buttons */}
          {step < 5 && (
            <TouchableOpacity
              style={[ss.cta, { backgroundColor: accent, shadowColor: accent }]}
              onPress={goNext}
              activeOpacity={0.85}
            >
              <Text style={ss.ctaText}>继续</Text>
              <SymbolView
                name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }}
                size={18}
                tintColor="#fff"
                style={{ width: 18, height: 18 }}
              />
            </TouchableOpacity>
          )}

          {step === 5 && fd.goal_type === 'cut' && (
            <TouchableOpacity
              style={[ss.cta, { backgroundColor: accent, shadowColor: accent }]}
              onPress={goNext}
              activeOpacity={0.85}
            >
              <Text style={ss.ctaText}>继续</Text>
              <SymbolView
                name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }}
                size={18}
                tintColor="#fff"
                style={{ width: 18, height: 18 }}
              />
            </TouchableOpacity>
          )}

          {step === 5 && fd.goal_type === 'maintain' && (
            <TouchableOpacity
              style={[ss.cta, { backgroundColor: accent, shadowColor: accent }]}
              onPress={submit}
              disabled={submitting}
              activeOpacity={0.85}
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Text style={ss.ctaText}>完成设置</Text>
                  <SymbolView
                    name={{ ios: 'checkmark', android: 'check', web: 'check' }}
                    size={18}
                    tintColor="#fff"
                    style={{ width: 18, height: 18 }}
                  />
                </>
              )}
            </TouchableOpacity>
          )}

          {step === 6 && (
            <TouchableOpacity
              style={[ss.cta, { backgroundColor: accent, shadowColor: accent }]}
              onPress={submit}
              disabled={submitting}
              activeOpacity={0.85}
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Text style={ss.ctaText}>完成设置</Text>
                  <SymbolView
                    name={{ ios: 'checkmark', android: 'check', web: 'check' }}
                    size={18}
                    tintColor="#fff"
                    style={{ width: 18, height: 18 }}
                  />
                </>
              )}
            </TouchableOpacity>
          )}

          {step === 7 && (
            <TouchableOpacity
              style={[ss.cta, { backgroundColor: accent, shadowColor: accent }]}
              onPress={onComplete}
              activeOpacity={0.85}
            >
              <Text style={ss.ctaText}>开始记录</Text>
              <SymbolView
                name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }}
                size={18}
                tintColor="#fff"
                style={{ width: 18, height: 18 }}
              />
            </TouchableOpacity>
          )}
        </ScrollView>
      </SafeAreaView>
    </GradientBackground>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const ss = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  safe: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 24, paddingBottom: 40 },

  // Header
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 8, marginBottom: 22 },
  backBtn: { width: 30 },
  backBtnPlaceholder: { width: 30 },
  progressTrack: { flex: 1, height: 5, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3 },
  stepLabel: { fontSize: FontSize.sm, fontWeight: '600', fontVariant: ['tabular-nums'] },
  completeTag: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  completeText: { fontSize: FontSize.sm, fontWeight: '600' },

  // Step content
  stepContent: { gap: 0 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.5, lineHeight: 28 * 1.2 },
  subtitle: { fontSize: FontSize.base, lineHeight: FontSize.base * 1.4, marginTop: 8, marginBottom: 32 },

  // Gender
  genderCards: { gap: 14 },
  genderCard: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 20, borderRadius: 22 },
  genderIconBox: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  genderIconChar: { fontSize: 26, fontWeight: '700' },
  genderLabel: { fontSize: 19, fontWeight: '600' },
  radioCircle: { width: 24, height: 24, borderRadius: 12, borderWidth: 2 },

  // Stepper (default)
  singlePickerWrap: { alignItems: 'center', marginTop: 8 },
  stepperCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    borderRadius: 20,
    borderWidth: 0.5,
    padding: 20,
    width: '100%',
  },
  stepBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  stepBtnCompact: { width: 36, height: 36, borderRadius: 18 },
  stepBtnText: { fontSize: 24, fontWeight: '400', lineHeight: 28 },
  stepperCenter: { flex: 1, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6 },
  stepperVal: { fontSize: 40, fontWeight: '700', letterSpacing: -1, minWidth: 80, textAlign: 'center' },
  stepperUnit: { fontSize: 16, fontWeight: '600' },

  // Stepper (compact for side-by-side)
  stepperCardCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 20,
    borderWidth: 0.5,
    padding: 10,
    width: '100%',
  },
  stepperValCompact: { fontSize: 22, fontWeight: '700', letterSpacing: -0.5, minWidth: 40, textAlign: 'center' },
  stepperUnitCompact: { fontSize: 12, fontWeight: '600' },

  // Body
  bodyRow: { flexDirection: 'row', gap: 12, marginBottom: 18 },
  bodyPickerWrap: { flex: 1, gap: 8 },
  bodyPickerLabel: { fontSize: FontSize.sm, fontWeight: '600', marginLeft: 4 },
  targetCard: { borderRadius: 22, borderWidth: 1.5, padding: 20, gap: 14 },
  targetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  targetCardLabel: { fontSize: 14, fontWeight: '600' },
  targetDiff: { fontSize: 12, opacity: 0.85 },
  targetBigNum: { flexDirection: 'row', alignItems: 'baseline', gap: 5, justifyContent: 'center' },
  targetNum: { fontSize: 46, fontWeight: '800', letterSpacing: -1.5, lineHeight: 50 },
  targetNumUnit: { fontSize: 18, fontWeight: '600' },
  infoHint: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 16 },
  infoHintText: { fontSize: 12.5, lineHeight: 12.5 * 1.4, flex: 1 },

  // Activity
  activityList: { gap: 10 },
  activityCard: { flexDirection: 'row', alignItems: 'center', gap: 13, padding: 15, borderRadius: 18 },
  activityIcon: { width: 28, height: 28 },
  activityText: { flex: 1 },
  activityLabel: { fontSize: 16, fontWeight: '600' },
  activityDesc: { fontSize: 12.5, marginTop: 1 },
  radioSmall: { width: 22, height: 22, borderRadius: 11, borderWidth: 2 },

  // TDEE mini row (step 5 maintain)
  tdeeMiniCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 24,
    borderRadius: 16,
    borderWidth: 0.5,
    padding: 14,
    paddingHorizontal: 16,
  },
  tdeeMiniLabel: { fontSize: FontSize.base },
  tdeeMiniRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tdeeMiniVal: { fontSize: 16, fontWeight: '700' },
  tdeeMiniUnit: { fontSize: 13, fontWeight: '500' },

  // Editable TDEE input
  tdeeEditInput: {
    fontSize: 14,
    fontWeight: '700',
    borderBottomWidth: 1.5,
    paddingVertical: 0,
    paddingHorizontal: 6,
    minWidth: 64,
    textAlign: 'center',
  },

  // Pace
  paceList: { gap: 10, marginBottom: 18 },
  paceCardWrap: { position: 'relative' },
  recommendedBadge: {
    position: 'absolute',
    top: -9,
    left: 16,
    zIndex: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 7,
  },
  recommendedText: { color: '#fff', fontSize: 10, fontWeight: '700', letterSpacing: 0.3 },
  paceCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, paddingHorizontal: 16, borderRadius: 18 },
  paceText: { flex: 1 },
  paceLabel: { fontSize: 16, fontWeight: '600' },
  paceDesc: { fontSize: 12.5, marginTop: 1 },
  paceRight: { alignItems: 'flex-end', marginRight: 4 },
  paceKcal: { fontSize: 15, fontWeight: '700' },
  paceKcalUnit: { fontSize: 10.5 },

  // Custom deficit indicator
  customDeficitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 14,
    borderWidth: 1,
    padding: 10,
    paddingHorizontal: 14,
    marginBottom: 14,
  },
  customDeficitText: { fontSize: 13, fontWeight: '600', flex: 1 },

  // Preview card
  previewCard: { borderRadius: 20, borderWidth: 0.5, padding: 16, paddingHorizontal: 18 },
  previewRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 },
  previewLabel: { fontSize: 14 },
  previewLabelBold: { fontSize: 14, fontWeight: '500' },
  previewValueGroup: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  previewValue: { fontSize: 16, fontWeight: '700' },
  previewValueBig: { fontSize: 28, fontWeight: '800', letterSpacing: -0.6 },
  previewUnit: { fontSize: 12, fontWeight: '500' },
  divider: { height: 0.5, marginVertical: 8 },

  // Safety & hint
  safetyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 14 },
  safetyText: { fontSize: 12.5, lineHeight: 12.5 * 1.4, flex: 1 },
  settingsHint: { fontSize: 14, fontWeight: '600', textAlign: 'center', marginTop: 14 },

  // Result
  resultHero: { alignItems: 'center', textAlign: 'center', marginTop: 14, gap: 0 },
  resultIcon: {
    width: 64,
    height: 64,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.4,
    shadowRadius: 30,
    elevation: 8,
    marginBottom: 20,
  },
  resultTagline: { fontSize: FontSize.base, textAlign: 'center' },
  resultBigNum: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 6 },
  resultBigVal: { fontSize: 60, fontWeight: '800', letterSpacing: -2, lineHeight: 64 },
  resultBigUnit: { fontSize: 20, fontWeight: '600' },
  resultSub: { fontSize: 13.5, textAlign: 'center', lineHeight: 13.5 * 1.4, marginTop: 10, marginBottom: 28 },
  breakdownCard: { borderRadius: 24, borderWidth: 0.5, paddingHorizontal: 18, paddingVertical: 6, marginBottom: 14 },
  breakdownRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  breakdownLabel: { flex: 1, fontSize: FontSize.base },
  breakdownVal: { fontSize: 16, fontWeight: '600' },
  macroRow: { flexDirection: 'row', gap: 10 },
  macroCard: { flex: 1, borderRadius: 16, borderWidth: 0.5, padding: 12, alignItems: 'center' },
  macroDotRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 3 },
  macroDot: { width: 7, height: 7, borderRadius: 3.5 },
  macroLabel: { fontSize: FontSize.xs },
  macroVal: { fontSize: 16, fontWeight: '700' },

  // Error
  errorText: { fontSize: FontSize.sm, color: '#FF3B30', marginTop: 8, textAlign: 'center' },

  // CTA
  cta: {
    height: 54,
    borderRadius: 27,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.42,
    shadowRadius: 28,
    elevation: 8,
  },
  ctaText: { fontSize: 17, fontWeight: '600', color: '#fff' },
});
