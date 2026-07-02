import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, LinearGradient, Stop, Polyline } from 'react-native-svg';
import { SymbolView } from 'expo-symbols';

import { GlassCard } from '@/components/glass-card';
import { ThemedText } from '@/components/themed-text';
import { apiFetch } from '@/lib/api';
import { useAuthStore } from '@/stores/auth-store';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors, Glass, BottomTabInset, Spacing } from '@/constants/theme';

// ─── Types ────────────────────────────────────────────────────────────────────
interface RangeItem {
  period: string;
  calories_in: number;
  total_out: number;
  deficit: number;
  protein: number;
  fat: number;
  carbs: number;
}

interface FoodRec {
  id: string;
  date: string;
  meal_type: string;
  weight_g: number;
  calories: number;
  raw_input: string | null;
  created_at: string;
  food: { name: string } | null;
}

interface ExRec {
  id: string;
  date: string;
  type: string;
  duration_min: number | null;
  calories_burned: number;
  created_at: string;
}

type Granularity = 'day' | 'week' | 'month';

interface DateGroup {
  dateStr: string;
  foods: FoodRec[];
  exercises: ExRec[];
}

// ─── Display constants ────────────────────────────────────────────────────────
const MEAL_ZH: Record<string, string> = {
  breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐',
};

const MEAL_IOS: Record<string, string> = {
  breakfast: 'cup.and.saucer.fill',
  lunch: 'fork.knife',
  dinner: 'moon.stars.fill',
  snack: 'leaf.fill',
};

const MEAL_EMOJI: Record<string, string> = {
  breakfast: '🥣', lunch: '🍱', dinner: '🍽️', snack: '🍪',
};

const WEEKDAYS_FULL  = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const CHART_H = 92;

// ─── Date helpers ─────────────────────────────────────────────────────────────
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Extract YYYY-MM-DD from an ISO datetime or date string (backend returns full ISO). */
function toDateOnly(s: string): string {
  return s.slice(0, 10);
}

function getDateRange(g: Granularity): { from: string; to: string } {
  const now = new Date();
  switch (g) {
    case 'day': {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      return { from: d.toISOString().slice(0, 10), to: todayStr() };
    }
    case 'week': {
      // Last 7 weeks for a meaningful chart (~7 data points)
      const d = new Date(now);
      d.setDate(d.getDate() - 48);
      return { from: d.toISOString().slice(0, 10), to: todayStr() };
    }
    case 'month': {
      // Last 12 months for a meaningful chart (~12 data points)
      const d = new Date(now);
      d.setMonth(d.getMonth() - 11);
      d.setDate(1);
      return { from: d.toISOString().slice(0, 10), to: todayStr() };
    }
  }
}

/** ISO 8601 week number. Week starts Monday, first week contains Jan 4. */
function getISOWeek(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const dayNum = d.getDay() || 7; // Sun=7
  d.setDate(d.getDate() + 4 - dayNum); // Thu of same ISO week
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/** Map a date string to the period key matching the backend's aggregation. */
function getPeriodKey(dateStr: string, g: Granularity): string {
  switch (g) {
    case 'day': return dateStr;
    case 'week': return getISOWeek(dateStr);
    case 'month': return dateStr.slice(0, 7); // YYYY-MM
  }
}

/** Get the Monday-Sunday date range of an ISO week like "2026-W27". */
function isoWeekDateRange(period: string): { mon: string; sun: string } {
  const [y, w] = period.split('-W').map(Number);
  // Jan 4 is always in ISO week 1
  const jan4 = new Date(y, 0, 4);
  const jan4Day = jan4.getDay() || 7;
  // Monday of week 1
  const week1Mon = new Date(jan4);
  week1Mon.setDate(jan4.getDate() - (jan4Day - 1));
  // Monday of target week
  const mon = new Date(week1Mon);
  mon.setDate(week1Mon.getDate() + (w - 1) * 7);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { mon: fmt(mon), sun: fmt(sun) };
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  if (h < 6) return `凌晨 ${h}:${m}`;
  if (h < 12) return `上午 ${h}:${m}`;
  if (h < 14) return `中午 ${h}:${m}`;
  if (h < 18) return `下午 ${h}:${m}`;
  return `晚上 ${h}:${m}`;
}

function fmt(n: number): string {
  if (!isFinite(n)) return '0';
  return Math.round(n).toLocaleString('zh-CN');
}

// ─── Granularity switcher ─────────────────────────────────────────────────────
function GranularitySwitcher({
  value,
  onChange,
  isDark,
}: {
  value: Granularity;
  onChange: (g: Granularity) => void;
  isDark: boolean;
}) {
  const colors = Colors[isDark ? 'dark' : 'light'];
  const glass = Glass[isDark ? 'dark' : 'light'];
  const items: { key: Granularity; label: string }[] = [
    { key: 'day', label: '日' },
    { key: 'week', label: '周' },
    { key: 'month', label: '月' },
  ];
  return (
    <View style={[styles.segWrap, { backgroundColor: colors.backgroundElement }]}>
      {items.map(({ key, label }) => {
        const active = value === key;
        return (
          <Pressable
            key={key}
            style={[
              styles.segItem,
              active && {
                backgroundColor: glass.backgroundStrong,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.12,
                shadowRadius: 6,
                elevation: 3,
              },
            ]}
            onPress={() => onChange(key)}
          >
            <ThemedText
              style={[styles.segLabel, active && styles.segLabelActive]}
              themeColor={active ? undefined : 'textSecondary'}
            >
              {label}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

// ─── Trend chart (SVG) ────────────────────────────────────────────────────────
function TrendChart({
  data,
  isDark,
  width,
}: {
  data: number[];
  isDark: boolean;
  width: number;
}) {
  const accent  = Glass[isDark ? 'dark' : 'light'].tint;
  const bgElem  = Colors[isDark ? 'dark' : 'light'].backgroundElement;
  const cardBg  = Glass[isDark ? 'dark' : 'light'].backgroundStrong;

  if (data.length === 0) return null;

  const padX = 8;
  const padY = 14;
  const cw = width - padX * 2;
  const ch = CHART_H - padY * 2;

  const max   = Math.max(...data, 0);
  const min   = Math.min(...data, 0);
  const range = max - min || 1;

  const pts = data.map((val, i) => {
    const x = padX + (data.length === 1 ? cw / 2 : (i / (data.length - 1)) * cw);
    const y = padY + ch - ((val - min) / range) * ch;
    return { x, y };
  });

  const linePoints = pts.map((p) => `${p.x},${p.y}`).join(' ');
  const lastPt     = pts[pts.length - 1];
  const areaPoints = `${linePoints} ${lastPt.x},${padY + ch} ${pts[0].x},${padY + ch}`;

  const zeroY   = padY + ch - ((0 - min) / range) * ch;
  const showZero = min < 0 && max > 0;

  return (
    <Svg width={width} height={CHART_H} viewBox={`0 0 ${width} ${CHART_H}`}>
      <Defs>
        <LinearGradient id="ha" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={accent} stopOpacity="0.28" />
          <Stop offset="1" stopColor={accent} stopOpacity="0" />
        </LinearGradient>
      </Defs>
      {showZero && (
        <Polyline
          points={`${padX},${zeroY} ${width - padX},${zeroY}`}
          stroke={bgElem}
          strokeWidth="0.5"
          strokeDasharray="4,4"
        />
      )}
      <Polyline points={areaPoints} fill="url(#ha)" />
      {data.length > 1 && (
        <Polyline
          points={linePoints}
          fill="none"
          stroke={accent}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      <Circle
        cx={lastPt.x}
        cy={lastPt.y}
        r="4"
        fill={accent}
        stroke={cardBg as string}
        strokeWidth="2"
      />
    </Svg>
  );
}

// ─── Meal / exercise icon ─────────────────────────────────────────────────────
function MealIcon({ mealType, isExercise }: {
  mealType?: string;
  isExercise?: boolean;
}) {
  if (isExercise) {
    if (Platform.OS === 'ios')
      return <SymbolView name="figure.run" size={19} tintColor={Glass.light.tint} />;
    return <Text style={styles.recEmoji}>🏃</Text>;
  }
  const mt = mealType ?? 'snack';
  if (Platform.OS === 'ios') {
    const name = MEAL_IOS[mt] ?? 'leaf.fill';
    return <SymbolView name={name as any} size={19} tintColor="rgba(60,60,67,0.62)" />;
  }
  return <Text style={styles.recEmoji}>{MEAL_EMOJI[mt] ?? '🍪'}</Text>;
}

// ─── Record row ───────────────────────────────────────────────────────────────
function RecordRow({
  item,
  isFirst,
  isDark,
  colors,
}: {
  item: FoodRec | ExRec;
  isFirst: boolean;
  isDark: boolean;
  colors: typeof Colors.light | typeof Colors.dark;
}) {
  const isFood = 'meal_type' in item;
  const mealZh = isFood
    ? (MEAL_ZH[(item as FoodRec).meal_type] ?? (item as FoodRec).meal_type)
    : '运动';
  const itemName = isFood
    ? ((item as FoodRec).food?.name ?? (item as FoodRec).raw_input ?? '未知')
    : `运动 · ${(item as ExRec).type}`;
  const kcal = isFood
    ? (item as FoodRec).calories
    : (item as ExRec).calories_burned;
  const kcalDisplay = isFood ? fmt(kcal) : `−${fmt(kcal)}`;

  return (
    <View
      style={[
        styles.recRow,
        !isFirst && {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.hairline,
        },
      ]}
    >
      <View
        style={[
          styles.recIcon,
          {
            backgroundColor: isFood
              ? colors.backgroundElement
              : isDark
                ? 'rgba(10,132,255,0.14)'
                : 'rgba(10,132,255,0.10)',
          },
        ]}
      >
        <MealIcon
          mealType={isFood ? (item as FoodRec).meal_type : undefined}
          isExercise={!isFood}
        />
      </View>

      <View style={styles.recBody}>
        <ThemedText style={styles.recTitle} numberOfLines={1}>
          {mealZh} · {itemName}
        </ThemedText>
        <ThemedText themeColor="textSecondary" style={styles.recTime}>
          {formatTime((item as any).created_at)}
        </ThemedText>
      </View>

      <ThemedText
        style={[styles.recKcal, !isFood && { color: colors.ok }]}
      >
        {kcalDisplay}
      </ThemedText>
    </View>
  );
}

// ─── Week day row (daily summary inside a week card) ─────────────────────────
const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
const MEAL_DOT: Record<string, string> = {
  breakfast: '早', lunch: '午', dinner: '晚', snack: '加',
};

function WeekDayRow({
  dateStr,
  foods,
  hasExercise,
  isFirst,
  colors,
}: {
  dateStr: string;
  foods: FoodRec[];
  hasExercise: boolean;
  isFirst: boolean;
  colors: typeof Colors.light | typeof Colors.dark;
}) {
  const d = new Date(dateStr + 'T00:00:00');
  const dayLabel = `${WEEKDAYS_FULL[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
  const mealTypes = new Set(foods.map((f) => f.meal_type));
  const mealDots = MEAL_ORDER.filter((m) => mealTypes.has(m)).map((m) => MEAL_DOT[m]);
  const kcal = foods.reduce((s, f) => s + f.calories, 0);

  return (
    <View
      style={[
        styles.weekRow,
        !isFirst && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
      ]}
    >
      <ThemedText style={styles.weekDayLabel} numberOfLines={1}>
        {dayLabel}
      </ThemedText>
      <View style={styles.weekMealDots}>
        {mealDots.map((dot, i) => (
          <ThemedText key={i} style={styles.weekMealDot} themeColor="textSecondary">
            {dot}
          </ThemedText>
        ))}
        {hasExercise && (
          <>
            <View style={{ width: 6 }} />
            {Platform.OS === 'ios' ? (
              <SymbolView name="figure.run" size={14} tintColor={colors.ok} />
            ) : (
              <Text style={{ fontSize: 13 }}>🏃</Text>
            )}
          </>
        )}
      </View>
      <ThemedText style={styles.weekKcal}>{fmt(kcal)}</ThemedText>
    </View>
  );
}

// ─── Month stat row ─────────────────────────────────────────────────────────
function MonthStatRow({
  label,
  value,
  unit,
  color,
}: {
  label: string;
  value: string;
  unit: string;
  color?: string;
}) {
  return (
    <View style={styles.monthStatRow}>
      <ThemedText themeColor="textSecondary" style={styles.monthStatLabel}>
        {label}
      </ThemedText>
      <View style={styles.monthStatRight}>
        <ThemedText style={[styles.monthStatVal, color ? { color } : undefined]}>
          {value}
        </ThemedText>
        <ThemedText themeColor="textTertiary" style={styles.monthStatUnit}>
          {unit}
        </ThemedText>
      </View>
    </View>
  );
}

// ─── Date card (one per period, rendered as FlatList item) ───────────────────
function DateCard({
  dateStr,
  foods,
  exercises,
  rangeItem,
  isDark,
  colors,
  granularity,
  defaultExpanded,
}: {
  dateStr: string;
  foods: FoodRec[];
  exercises: ExRec[];
  rangeItem: RangeItem | undefined;
  isDark: boolean;
  colors: typeof Colors.light | typeof Colors.dark;
  granularity: Granularity;
  defaultExpanded: boolean;
}) {
  const deficit = rangeItem?.deficit ?? 0;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const chevron = expanded ? '▾' : '▸';

  // ── Day mode: collapsible record list ────────────────────────────────────
  if (granularity === 'day') {
    const dateLabel = () => {
      const d = new Date(dateStr + 'T00:00:00');
      return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS_FULL[d.getDay()]}`;
    };
    const totalItems = foods.length + exercises.length;
    const collapsedHint = () =>
      totalItems > 0 ? (
        <ThemedText themeColor="textTertiary" style={styles.dateSummary}>
          {totalItems} 条记录
        </ThemedText>
      ) : null;

    return (
      <GlassCard style={styles.listCard}>
        <Pressable
          style={[styles.dateHeader, { borderBottomColor: expanded ? colors.hairline : 'transparent' }]}
          onPress={() => setExpanded(!expanded)}
        >
          <View style={styles.dateHeaderLeft}>
            <ThemedText style={styles.dateChevron} themeColor="textTertiary">
              {chevron}
            </ThemedText>
            <ThemedText style={styles.dateLabel}>{dateLabel()}</ThemedText>
            {!expanded && totalItems > 0 && (
              <ThemedText themeColor="textTertiary" style={styles.dateSummary}>
                {totalItems} 条记录
              </ThemedText>
            )}
          </View>
          <ThemedText style={[styles.dateDeficit, { color: deficit >= 0 ? colors.ok : colors.warn }]}>
            缺口 {deficit >= 0 ? '−' : '+'}{fmt(Math.abs(deficit))}
          </ThemedText>
        </Pressable>

        {expanded && (
          <>
            {foods.map((f, idx) => (
              <RecordRow key={f.id} item={f} isFirst={idx === 0} isDark={isDark} colors={colors} />
            ))}
            {exercises.map((e, idx) => (
              <RecordRow key={e.id} item={e} isFirst={foods.length === 0 && idx === 0} isDark={isDark} colors={colors} />
            ))}
          </>
        )}
      </GlassCard>
    );
  }

  // ── Week mode: collapsible daily summary rows ────────────────────────────
  if (granularity === 'week') {
    const { mon, sun } = isoWeekDateRange(dateStr);
    const [y, w] = dateStr.split('-W');
    const dateLabel = () => `${y}年第${parseInt(w, 10)}周 ${mon.slice(5)}-${sun.slice(5)}`;

    // Group foods & exercises by day within this week
    const dayMap = new Map<string, { foods: FoodRec[]; hasExercise: boolean }>();
    for (const f of foods) {
      const d = toDateOnly(f.date);
      if (!dayMap.has(d)) dayMap.set(d, { foods: [], hasExercise: false });
      dayMap.get(d)!.foods.push(f);
    }
    for (const e of exercises) {
      const d = toDateOnly(e.date);
      if (!dayMap.has(d)) dayMap.set(d, { foods: [], hasExercise: true });
      else dayMap.get(d)!.hasExercise = true;
    }
    const days = Array.from(dayMap.entries()).sort(([a], [b]) => a.localeCompare(b));
    const activeDays = days.length;
    const collapsedHint = () =>
      activeDays > 0 ? (
        <ThemedText themeColor="textTertiary" style={styles.dateSummary}>
          {activeDays} 天
        </ThemedText>
      ) : null;

    return (
      <GlassCard style={styles.listCard}>
        <Pressable
          style={[styles.dateHeader, { borderBottomColor: expanded ? colors.hairline : 'transparent' }]}
          onPress={() => setExpanded(!expanded)}
        >
          <View style={styles.dateHeaderLeft}>
            <ThemedText style={styles.dateChevron} themeColor="textTertiary">
              {chevron}
            </ThemedText>
            <ThemedText style={styles.dateLabel}>{dateLabel()}</ThemedText>
            {!expanded && collapsedHint()}
          </View>
          <ThemedText style={[styles.dateDeficit, { color: deficit >= 0 ? colors.ok : colors.warn }]}>
            缺口 {deficit >= 0 ? '−' : '+'}{fmt(Math.abs(deficit))}
          </ThemedText>
        </Pressable>

        {expanded && days.map(([d, group], idx) => (
          <WeekDayRow
            key={d}
            dateStr={d}
            foods={group.foods}
            hasExercise={group.hasExercise}
            isFirst={idx === 0}
            colors={colors}
          />
        ))}
      </GlassCard>
    );
  }

  // ── Month mode: collapsible stats panel ──────────────────────────────────
  const [y, m] = dateStr.split('-');
  const dateLabel = () => `${y}年${parseInt(m, 10)}月`;
  const collapsedHint = () =>
    rangeItem ? (
      <ThemedText themeColor="textTertiary" style={styles.dateSummary}>
        摄入 {fmt(rangeItem.calories_in)}
      </ThemedText>
    ) : null;

  return (
    <GlassCard style={styles.listCard}>
      <Pressable
        style={[styles.dateHeader, { borderBottomColor: expanded ? colors.hairline : 'transparent' }]}
        onPress={() => setExpanded(!expanded)}
      >
        <View style={styles.dateHeaderLeft}>
          <ThemedText style={styles.dateChevron} themeColor="textTertiary">
            {chevron}
          </ThemedText>
          <ThemedText style={styles.dateLabel}>{dateLabel()}</ThemedText>
          {!expanded && collapsedHint()}
        </View>
        <ThemedText style={[styles.dateDeficit, { color: deficit >= 0 ? colors.ok : colors.warn }]}>
          缺口 {deficit >= 0 ? '−' : '+'}{fmt(Math.abs(deficit))}
        </ThemedText>
      </Pressable>

      {expanded && rangeItem && (
        <View style={styles.monthStats}>
          <MonthStatRow label="总摄入" value={fmt(rangeItem.calories_in)} unit="kcal" />
          <MonthStatRow label="总消耗" value={fmt(rangeItem.total_out)} unit="kcal" />
          <MonthStatRow
            label="热量缺口"
            value={`${deficit >= 0 ? '−' : '+'}${fmt(Math.abs(deficit))}`}
            unit="kcal"
            color={deficit >= 0 ? colors.ok : colors.warn}
          />
          <View style={[styles.monthDivider, { backgroundColor: colors.hairline }]} />
          <MonthStatRow label="蛋白质" value={fmt(rangeItem.protein)} unit="g" />
          <MonthStatRow label="脂肪" value={fmt(rangeItem.fat)} unit="g" />
          <MonthStatRow label="碳水" value={fmt(rangeItem.carbs)} unit="g" />
        </View>
      )}

      {expanded && !rangeItem && (
        <ThemedText themeColor="textSecondary" style={styles.noData}>
          暂无数据
        </ThemedText>
      )}
    </GlassCard>
  );
}

// ─── Trend card header (FlatList ListHeaderComponent) ─────────────────────────
function TrendHeader({
  titleText,
  totalDays,
  metDays,
  avgDeficit,
  chartData,
  chartLabels,
  chartWidth,
  onChartLayout,
  isDark,
  colors,
  unitText,
  periodUnit,
}: {
  titleText: string;
  totalDays: number;
  metDays: number;
  avgDeficit: number;
  chartData: number[];
  chartLabels: string[];
  chartWidth: number;
  onChartLayout: (w: number) => void;
  isDark: boolean;
  colors: typeof Colors.light | typeof Colors.dark;
  unitText: string;
  periodUnit: string;
}) {
  return (
    <GlassCard style={styles.trendCard}>
      <View style={styles.trendHeader}>
        <ThemedText themeColor="textSecondary" style={styles.trendTitle}>
          {titleText}
        </ThemedText>
        {totalDays > 0 && (
          <ThemedText style={[styles.metBadge, { color: colors.ok }]}>
            达标 {metDays} / {totalDays} {periodUnit}
          </ThemedText>
        )}
      </View>

      {totalDays > 0 ? (
        <>
          <View style={styles.deficitRow}>
            <ThemedText
              style={[styles.deficitVal, { color: avgDeficit >= 0 ? colors.ok : colors.warn }]}
            >
              {avgDeficit >= 0 ? '−' : '+'}{fmt(Math.abs(avgDeficit))}
            </ThemedText>
            <ThemedText themeColor="textSecondary" style={styles.deficitUnit}>
              {unitText}
            </ThemedText>
          </View>

          <View style={styles.chartWrap} onLayout={(e) => onChartLayout(e.nativeEvent.layout.width)}>
            {chartWidth > 0 && <TrendChart data={chartData} isDark={isDark} width={chartWidth} />}
          </View>

          {chartLabels.length > 0 && (
            <View style={styles.chartLabels}>
              {chartLabels.map((l, i) => (
                <ThemedText key={i} themeColor="textTertiary" style={styles.chartLabel}>
                  {l}
                </ThemedText>
              ))}
            </View>
          )}
        </>
      ) : (
        <ThemedText themeColor="textSecondary" style={styles.noData}>
          暂无数据
        </ThemedText>
      )}
    </GlassCard>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────
export default function HistoryScreen({ isActive = true }: { isActive?: boolean }) {
  const { token } = useAuthStore();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = Colors[isDark ? 'dark' : 'light'];
  const glass  = Glass[isDark ? 'dark' : 'light'];

  const [granularity, setGranularity] = useState<Granularity>('week');
  const [rangeData,   setRangeData]   = useState<RangeItem[]>([]);
  const [foodRecords, setFoodRecords] = useState<FoodRec[]>([]);
  const [exRecords,   setExRecords]   = useState<ExRec[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [chartWidth,  setChartWidth]  = useState(300);

  const { from, to } = useMemo(() => getDateRange(granularity), [granularity]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [rangeRes, recRes] = await Promise.all([
        apiFetch<RangeItem[]>(
          `/api/daily/range?from=${from}&to=${to}&granularity=${granularity}`,
          { token },
        ),
        apiFetch<{ records: FoodRec[]; exercises: ExRec[] }>(
          `/api/daily/records?from=${from}&to=${to}`,
          { token },
        ),
      ]);
      setRangeData(rangeRes);
      setFoodRecords(recRes.records ?? []);
      setExRecords(recRes.exercises ?? []);
    } catch {
      /* keep stale data on error */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token, from, to]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  useEffect(() => { if (isActive) { void load(); } }, [isActive, load]);

  // ── Derived stats ───────────────────────────────────────────────────────────
  const avgDeficit = rangeData.length > 0
    ? Math.round(rangeData.reduce((s, r) => s + r.deficit, 0) / rangeData.length)
    : 0;
  const metDays   = rangeData.filter((r) => r.deficit >= 0).length;
  const totalDays = rangeData.length;
  const chartData = rangeData.map((r) => r.deficit);

  // X-axis labels
  const chartLabels = useMemo(() => {
    if (rangeData.length === 0) return [];
    if (granularity === 'week') {
      return rangeData.map((r) => {
        const w = r.period.split('-W')[1];
        return w ? `${parseInt(w, 10)}周` : r.period;
      });
    }
    if (granularity === 'month') {
      return rangeData.map((r) => {
        const m = r.period.split('-')[1];
        return m ? `${parseInt(m, 10)}月` : r.period;
      });
    }
    // day — show M/D labels, spaced out if too many
    const step = rangeData.length > 14 ? 7 : 1;
    return rangeData.map((r, i) => {
      if (i % step !== 0) return '';
      const d = new Date(r.period + 'T00:00:00');
      return `${d.getMonth() + 1}/${d.getDate()}`;
    });
  }, [granularity, rangeData]);

  // ── Group records by period (day/week/month) ────────────────────────────────
  const groupedRecords: DateGroup[] = useMemo(() => {
    const map = new Map<string, { foods: FoodRec[]; exercises: ExRec[] }>();
    for (const f of foodRecords) {
      const k = getPeriodKey(toDateOnly(f.date), granularity);
      if (!map.has(k)) map.set(k, { foods: [], exercises: [] });
      map.get(k)!.foods.push(f);
    }
    for (const e of exRecords) {
      const k = getPeriodKey(toDateOnly(e.date), granularity);
      if (!map.has(k)) map.set(k, { foods: [], exercises: [] });
      map.get(k)!.exercises.push(e);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([dateStr, group]) => ({ dateStr, ...group }));
  }, [foodRecords, exRecords, granularity]);

  // Build a RangeItem lookup map for DateCard
  const rangeItemMap = useMemo(() => {
    const m = new Map<string, RangeItem>();
    for (const r of rangeData) m.set(r.period, r);
    return m;
  }, [rangeData]);

  const titleText =
    granularity === 'day' ? '近7天平均缺口' : granularity === 'week' ? '近7周平均缺口' : '近12月平均缺口';

  const unitText =
    granularity === 'day' ? 'kcal / 天' : granularity === 'week' ? 'kcal / 周' : 'kcal / 月';

  const periodUnit =
    granularity === 'day' ? '天' : granularity === 'week' ? '周' : '月';

  // ── FlatList helpers ────────────────────────────────────────────────────────
  const renderItem = useCallback(
    ({ item, index }: { item: DateGroup; index: number }) => (
      <DateCard
        dateStr={item.dateStr}
        foods={item.foods}
        exercises={item.exercises}
        rangeItem={rangeItemMap.get(item.dateStr)}
        isDark={isDark}
        colors={colors}
        granularity={granularity}
        defaultExpanded={index === 0}
      />
    ),
    [rangeItemMap, isDark, colors, granularity],
  );

  const renderHeader = useCallback(
    () => (
      <TrendHeader
        titleText={titleText}
        totalDays={totalDays}
        metDays={metDays}
        avgDeficit={avgDeficit}
        chartData={chartData}
        chartLabels={chartLabels}
        chartWidth={chartWidth}
        onChartLayout={setChartWidth}
        isDark={isDark}
        colors={colors}
        unitText={unitText}
        periodUnit={periodUnit}
      />
    ),
    [titleText, totalDays, metDays, avgDeficit, chartData, chartLabels, chartWidth, isDark, colors, unitText, periodUnit],
  );

  const renderEmpty = useCallback(
    () => (
      <View style={styles.empty}>
        <ThemedText themeColor="textSecondary" style={styles.emptyText}>
          该时段暂无记录
        </ThemedText>
      </View>
    ),
    [],
  );

  const keyExtractor = useCallback((item: DateGroup) => item.dateStr, []);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      {/* Header */}
      <View style={styles.header}>
        <ThemedText style={styles.title}>历史</ThemedText>
        <GranularitySwitcher value={granularity} onChange={setGranularity} isDark={isDark} />
      </View>

      {loading ? (
        <View style={styles.loader}>
          <ActivityIndicator color={glass.tint} />
        </View>
      ) : (
        <FlatList
          data={groupedRecords}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          ListHeaderComponent={renderHeader}
          ListEmptyComponent={renderEmpty}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          ItemSeparatorComponent={Sep}
          refreshing={refreshing}
          onRefresh={handleRefresh}
          getItemLayout={getItemLayout}
          windowSize={5}
          removeClippedSubviews
        />
      )}
    </SafeAreaView>
  );
}

// ─── FlatList helpers (outside component — stable references) ─────────────────
function Sep() {
  return <View style={{ height: 13 }} />;
}

// Approximate height of one date card: dateHeader (~40) + avg records/day (~5 × 50px) = ~290px
const EST_ITEM_HEIGHT = 290;

function getItemLayout(_data: ArrayLike<DateGroup> | null | undefined, index: number) {
  const offset = (EST_ITEM_HEIGHT + 13 /* separator */) * index;
  return { length: EST_ITEM_HEIGHT, offset, index };
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root:   { flex: 1 },
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // Header — matches Today's pattern
  header: { paddingHorizontal: 22, paddingTop: 10, paddingBottom: 8, overflow: 'visible' },
  title:  { fontSize: 30, fontWeight: '700', letterSpacing: -0.6, lineHeight: 36 },

  // Segmented control
  segWrap: {
    flexDirection: 'row', gap: 4, padding: 3,
    borderRadius: 12, marginTop: 14,
  },
  segItem: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 7, borderRadius: 9,
  },
  segLabel:       { fontSize: 13, fontWeight: '500' },
  segLabelActive: { fontWeight: '600' },

  // FlatList content
  list: {
    paddingTop: 2,
    paddingHorizontal: 16,
    paddingBottom: BottomTabInset + Spacing.three,
  },

  // ── Trend card ─────────────────────────────────────────────────
  trendCard:   { borderRadius: 22, paddingBottom: 12 },
  trendHeader: {
    flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between',
  },
  trendTitle: { fontSize: 13, fontWeight: '500' },
  metBadge:   { fontSize: 13, fontWeight: '600' },
  deficitRow: {
    flexDirection: 'row', alignItems: 'baseline', gap: 5, marginTop: 2,
    overflow: 'visible',
  },
  deficitVal:  { fontSize: 26, fontWeight: '700', lineHeight: 32 },
  deficitUnit: { fontSize: 13 },
  chartWrap:   { marginTop: 8 },
  chartLabels: {
    flexDirection: 'row', justifyContent: 'space-between', marginTop: 2,
  },
  chartLabel: { fontSize: 10.5 },
  noData:     { textAlign: 'center', marginTop: 24, marginBottom: 8 },

  // ── List card ──────────────────────────────────────────────────
  listCard:    { borderRadius: 22 },
  dateHeader:  {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dateHeaderLeft: {
    flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0,
  },
  dateChevron:  { fontSize: 10, width: 12 },
  dateSummary:  { fontSize: 12, flexShrink: 1 },
  dateLabel:    { fontSize: 14, fontWeight: '600' },
  dateDeficit:  { fontSize: 13, fontWeight: '600' },

  // ── Record row ─────────────────────────────────────────────────
  recRow:  {
    flexDirection: 'row', alignItems: 'center', gap: 11,
    paddingVertical: 11,
  },
  recIcon: {
    width: 34, height: 34, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  recEmoji: { fontSize: 19 },
  recBody:  { flex: 1, minWidth: 0 },
  recTitle: { fontSize: 14, fontWeight: '600' },
  recTime:  { fontSize: 12 },
  recKcal:  { fontSize: 14, fontWeight: '600' },

  // ── Week day row ───────────────────────────────────────────────
  weekRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 9,
  },
  weekDayLabel: { fontSize: 13, fontWeight: '500', width: 80 },
  weekMealDots: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 3 },
  weekMealDot:  { fontSize: 11.5, fontWeight: '500' },
  weekKcal:     { fontSize: 13, fontWeight: '600', minWidth: 48, textAlign: 'right' },

  // ── Month stats ───────────────────────────────────────────────
  monthStats:    { marginTop: 4 },
  monthStatRow:  {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 7,
  },
  monthStatLabel: { fontSize: 14 },
  monthStatRight: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  monthStatVal:   { fontSize: 14, fontWeight: '600' },
  monthStatUnit:  { fontSize: 12 },
  monthDivider:   { height: StyleSheet.hairlineWidth, marginVertical: 2 },

  // ── Empty state ────────────────────────────────────────────────
  empty:     { marginTop: 24, alignItems: 'center', paddingHorizontal: 16 },
  emptyText: { textAlign: 'center', fontSize: 15, lineHeight: 22 },
});
