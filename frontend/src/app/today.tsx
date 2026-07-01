import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import Svg, { Circle } from 'react-native-svg';

import { GlassCard } from '@/components/glass-card';
import { ThemedText } from '@/components/themed-text';
import { apiFetch } from '@/lib/api';
import { useAuthStore } from '@/stores/auth-store';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors, Glass, BottomTabInset, Spacing, FontSize } from '@/constants/theme';

// ─── Nutrient palette (matches design) ───────────────────────────────────────
const NUT_COLOR = { protein: '#34C759', fat: '#FF9F0A', carbs: '#5E5CE6' };

// ─── Ring progress (SVG — reliable cross-platform) ───────────────────────────
const RING_SIZE   = 108;
const RING_STROKE = 12;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;       // 48
const RING_CIRC   = 2 * Math.PI * RING_RADIUS;           // ~301.6
const RING_CENTER = RING_SIZE / 2;                        // 54

function RingProgress({ progress, isDark }: { progress: number; isDark: boolean }) {
  const capped  = Math.min(Math.max(progress, 0), 1);
  const tint    = Glass[isDark ? 'dark' : 'light'].tint;
  const track   = Colors[isDark ? 'dark' : 'light'].backgroundElement;
  const offset  = RING_CIRC * (1 - capped);

  return (
    <View style={styles.ringWrap}>
      {/* SVG ring rotated -90° so progress starts from top (12 o'clock) */}
      <Svg
        width={RING_SIZE}
        height={RING_SIZE}
        style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}
      >
        {/* Gray track (full circle) */}
        <Circle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_RADIUS}
          stroke={track}
          strokeWidth={RING_STROKE}
          fill="none"
        />
        {/* Blue progress arc */}
        <Circle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_RADIUS}
          stroke={tint}
          strokeWidth={RING_STROKE}
          fill="none"
          strokeDasharray={RING_CIRC}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </Svg>
      {/* Center label */}
      <View style={styles.ringCenter}>
        <ThemedText style={styles.ringPct}>{Math.round(capped * 100)}%</ThemedText>
        <ThemedText themeColor="textSecondary" style={styles.ringLabel}>已达目标</ThemedText>
      </View>
    </View>
  );
}

// ─── Nutrient row ─────────────────────────────────────────────────────────────
function NutrientRow({
  label, color, current, target, isDark,
}: { label: string; color: string; current: number; target: number; isDark: boolean }) {
  const ratio = target > 0 ? Math.min(current / target, 1) : 0;
  const field = Colors[isDark ? 'dark' : 'light'].backgroundElement;
  return (
    <View style={styles.nutRow}>
      <View style={styles.nutLabelLine}>
        <View style={[styles.nutDot, { backgroundColor: color }]} />
        <ThemedText style={styles.nutName}>{label}</ThemedText>
        <View style={{ flex: 1 }} />
        <ThemedText themeColor="textSecondary" style={styles.nutAmt}>
          <ThemedText style={styles.nutCur}>{Math.round(current)}</ThemedText>
          {` / ${Math.round(target)} g`}
        </ThemedText>
      </View>
      <View style={[styles.nutTrack, { backgroundColor: field }]}>
        <View style={[styles.nutFill, { backgroundColor: color, width: `${ratio * 100}%` }]} />
      </View>
    </View>
  );
}

// ─── Hint text ────────────────────────────────────────────────────────────────
function hint(calIn: number, calTarget: number, totalOut: number, protein: number, proteinTarget: number): string {
  // 真正超标：摄入超过总消耗（TDEE + 运动），缺口为负
  if (totalOut > 0 && calIn > totalOut)
    return '今天热量已超标，晚餐尽量清淡一些。';
  if (proteinTarget > 0 && protein < proteinTarget * 0.5)
    return `蛋白还差 ${Math.round(proteinTarget - protein)}g，晚餐来份鸡胸或鸡蛋补一补。`;
  if (calTarget > 0 && calIn < calTarget * 0.35)
    return '摄入偏少，记得按时吃饭保持代谢。';
  return '保持节奏，今天吃得不错！';
}

// ─── Date header ─────────────────────────────────────────────────────────────
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function todayLabel() {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface DailySummary {
  calories_in: number; total_out: number; deficit: number;
  tdee: number; exercise_out: number; protein: number; fat: number; carbs: number;
  target_calories: number; target_protein: number;
}

interface ExerciseRecord {
  id: string;
  type: string;
  duration_min: number | null;
  calories_burned: number;
}

// ─── Screen ───────────────────────────────────────────────────────────────────
export default function TodayScreen() {
  const { token } = useAuthStore();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = Colors[isDark ? 'dark' : 'light'];
  const glass  = Glass[isDark ? 'dark' : 'light'];

  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [exercises, setExercises] = useState<ExerciseRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await apiFetch<{ summary: DailySummary | null; exercises: ExerciseRecord[] }>('/api/daily/today', { token });
      setSummary(res.summary);
      setExercises(res.exercises ?? []);
    } catch { /* keep stale */ } finally { setLoading(false); }
  }, [token]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const calIn         = summary?.calories_in  ?? 0;
  const calTarget     = summary?.target_calories ?? 0;
  const totalOut      = summary?.total_out    ?? 0;
  const deficit       = summary?.deficit      ?? 0;
  const tdee          = summary?.tdee         ?? 0;
  const exerciseOut   = summary?.exercise_out ?? 0;
  const protein       = summary?.protein      ?? 0;
  const fat           = summary?.fat          ?? 0;
  const carbs         = summary?.carbs        ?? 0;
  const proteinTarget = summary?.target_protein ?? 0;
  const fatTarget     = calTarget > 0 ? Math.round(calTarget * 0.28 / 9) : 0;
  const carbsTarget   = calTarget > 0
    ? Math.round((calTarget - proteinTarget * 4 - fatTarget * 9) / 4) : 0;

  const progress    = calTarget > 0 ? calIn / calTarget : 0;
  const deficitColor = deficit >= 0 ? colors.ok : colors.warn;
  const fmt = (n: number) => Math.round(n).toLocaleString('zh-CN');

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      {/* Header */}
      <View style={styles.header}>
        <ThemedText themeColor="textSecondary" style={styles.dateText}>{todayLabel()}</ThemedText>
        <ThemedText style={styles.title}>今天</ThemedText>
      </View>

      {loading ? (
        <View style={styles.loader}>
          <ActivityIndicator color={glass.tint} />
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {/* ── Card 1: ring + deficit ─────────────────────────────── */}
          <GlassCard blurIntensity={30} style={styles.card1}>
            <View style={styles.card1Inner}>
              <RingProgress progress={progress} isDark={isDark} />
              <View style={styles.deficitBlock}>
                <ThemedText themeColor="textSecondary" style={styles.deficitLabel}>今日热量缺口</ThemedText>
                <View style={styles.deficitRow}>
                  <ThemedText style={[styles.deficitVal, { color: deficitColor }]}>{fmt(Math.abs(deficit))}</ThemedText>
                  <ThemedText themeColor="textSecondary" style={styles.kcalUnit}>kcal</ThemedText>
                </View>
                <View style={styles.inOutRow}>
                  <View>
                    <ThemedText themeColor="textSecondary" style={styles.inOutLabel}>摄入</ThemedText>
                    <ThemedText style={styles.inOutVal}>{fmt(calIn)}</ThemedText>
                  </View>
                  <View style={[styles.inOutDivider, { backgroundColor: colors.hairline }]} />
                  <View>
                    <ThemedText themeColor="textSecondary" style={styles.inOutLabel}>消耗</ThemedText>
                    <ThemedText style={styles.inOutVal}>{fmt(totalOut)}</ThemedText>
                  </View>
                </View>
              </View>
            </View>
          </GlassCard>

          {/* ── Card 2: nutrients ──────────────────────────────────── */}
          <GlassCard style={styles.card2}>
            <View style={styles.card2Inner}>
              <View style={styles.nutHeader}>
                <ThemedText style={styles.nutTitle}>营养素</ThemedText>
                {tdee > 0 && (
                  <ThemedText themeColor="textSecondary" style={styles.nutSub}>
                    消耗含基础代谢 {fmt(tdee)}
                  </ThemedText>
                )}
              </View>
              <View style={styles.nutList}>
                <NutrientRow label="蛋白" color={NUT_COLOR.protein} current={protein} target={proteinTarget} isDark={isDark} />
                <NutrientRow label="脂肪" color={NUT_COLOR.fat}     current={fat}     target={fatTarget}     isDark={isDark} />
                <NutrientRow label="碳水" color={NUT_COLOR.carbs}   current={carbs}   target={carbsTarget}   isDark={isDark} />
              </View>
            </View>
          </GlassCard>

          {/* ── Card 3: exercise ──────────────────────────────────── */}
          {(exercises.length > 0 || exerciseOut > 0) && (
            <GlassCard style={styles.card3}>
              <View style={styles.exHeader}>
                <ThemedText style={styles.exTitle}>🏃 今日运动</ThemedText>
                {exerciseOut > 0 && (
                  <ThemedText style={styles.exTotal}>消耗 {fmt(exerciseOut)} kcal</ThemedText>
                )}
              </View>
              {exercises.length > 0 && (
                <View style={styles.exList}>
                  {exercises.map((ex) => (
                    <View key={ex.id} style={[styles.exItem, { borderColor: colors.hairline }]}>
                      <View style={styles.exItemLeft}>
                        <View style={[styles.exDot, { backgroundColor: NUT_COLOR.carbs }]} />
                        <ThemedText style={styles.exType}>{ex.type}</ThemedText>
                        {ex.duration_min != null && (
                          <ThemedText themeColor="textSecondary" style={styles.exDur}>{ex.duration_min}min</ThemedText>
                        )}
                      </View>
                      <ThemedText style={styles.exCal}>{fmt(ex.calories_burned)} kcal</ThemedText>
                    </View>
                  ))}
                </View>
              )}
            </GlassCard>
          )}

          {/* ── Hint card ──────────────────────────────────────────── */}
          {calIn > 0 && (
            <View style={[styles.hintCard, {
              backgroundColor: isDark ? 'rgba(255,159,10,0.14)' : 'rgba(255,159,10,0.10)',
              borderColor:     isDark ? 'rgba(255,159,10,0.30)' : 'rgba(255,159,10,0.22)',
            }]}>
              <ThemedText style={styles.hintIcon}>🌿</ThemedText>
              <ThemedText style={styles.hintText}>
                {hint(calIn, calTarget, totalOut, protein, proteinTarget)}
              </ThemedText>
            </View>
          )}

          {/* ── Empty state ────────────────────────────────────────── */}
          {calIn === 0 && (
            <View style={styles.empty}>
              <ThemedText themeColor="textSecondary" style={styles.emptyText}>
                今天还没有记录，去 Chat 说说你吃了什么吧 🍱
              </ThemedText>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1 },
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },

  // Header — matches design: padding 10px 22px 6px
  header: { paddingHorizontal: 22, paddingTop: 10, paddingBottom: 8 },
  dateText: { fontSize: 13, fontWeight: '500' },
  title:    { fontSize: 26, fontWeight: '700', letterSpacing: -0.6, marginTop: 1 },

  // Content — matches design: padding 8px 16px 100px, gap 13px
  content: {
    paddingTop: 8,
    paddingHorizontal: 16,
    paddingBottom: BottomTabInset + Spacing.three,
    gap: 13,
  },

  // Card 1 — border-radius 26px (design exact value)
  card1: { borderRadius: 26 },
  card1Inner: { flexDirection: 'row', alignItems: 'center', gap: 20 },

  // Card 2 — border-radius 22px (design exact value)
  card2: { borderRadius: 22 },
  card2Inner: { paddingHorizontal: 2 },  // GlassCard gives 16; design wants 18 → +2

  // Card 3 — exercise
  card3: { borderRadius: 22 },
  exHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 10,
  },
  exTitle: { fontSize: 15, fontWeight: '600' },
  exTotal: { fontSize: 14, fontWeight: '700', color: NUT_COLOR.carbs },
  exList:  { gap: 8 },
  exItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 8, borderTopWidth: 0.5,
  },
  exItemLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  exDot:  { width: 7, height: 7, borderRadius: 3.5 },
  exType: { fontSize: 14 },
  exDur:  { fontSize: 12 },
  exCal:  { fontSize: 14, fontWeight: '600' },

  // Ring
  ringWrap:   { width: RING_SIZE, height: RING_SIZE, flexShrink: 0 },
  ringCenter: {
    position: 'absolute',
    top: RING_STROKE, left: RING_STROKE, right: RING_STROKE, bottom: RING_STROKE,
    alignItems: 'center', justifyContent: 'center',
  },
  ringPct:   { fontSize: 22, fontWeight: '700', lineHeight: 26 },
  ringLabel: { fontSize: 10, marginTop: 3 },

  // Deficit block
  deficitBlock: { flex: 1, minWidth: 0 },
  deficitLabel: { fontSize: 13, fontWeight: '500' },
  deficitRow:   { flexDirection: 'row', alignItems: 'baseline', gap: 5, marginTop: 2 },
  deficitVal:   { fontSize: 36, fontWeight: '800', letterSpacing: -1, lineHeight: 40 },
  kcalUnit:     { fontSize: 14, fontWeight: '600' },
  inOutRow:     { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 14 },
  inOutLabel:   { fontSize: 11 },
  inOutVal:     { fontSize: 16, fontWeight: '700' },
  inOutDivider: { width: 0.5, height: 28 },

  // Nutrients
  nutHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 14,
  },
  nutTitle: { fontSize: 15, fontWeight: '600' },
  nutSub:   { fontSize: 12 },
  nutList:  { gap: 13 },
  nutRow:   { gap: 5 },
  nutLabelLine: { flexDirection: 'row', alignItems: 'center' },
  nutDot:   { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  nutName:  { fontSize: 13 },
  nutAmt:   { fontSize: 13 },
  nutCur:   { fontSize: 13, fontWeight: '700' },
  nutTrack: { height: 7, borderRadius: 5, overflow: 'hidden' },
  nutFill:  { height: '100%', borderRadius: 5 },

  // Hint card — warn-tinted
  hintCard: {
    borderRadius: 18, borderWidth: 0.5,
    padding: 13, paddingHorizontal: 15,
    flexDirection: 'row', alignItems: 'center', gap: 11,
  },
  hintIcon: { fontSize: 22, flexShrink: 0 },
  hintText: { fontSize: 13.5, lineHeight: 19, flex: 1 },

  // Empty
  empty:     { marginTop: Spacing.four, alignItems: 'center', paddingHorizontal: Spacing.four },
  emptyText: { textAlign: 'center', fontSize: FontSize.base, lineHeight: 22 },
});
