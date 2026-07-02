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

const WEEKDAYS_SHORT = ['一', '二', '三', '四', '五', '六', '日'];
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
      const day = now.getDay();
      const mon = new Date(now);
      mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      return {
        from: mon.toISOString().slice(0, 10),
        to: sun.toISOString().slice(0, 10),
      };
    }
    case 'month': {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return {
        from: first.toISOString().slice(0, 10),
        to: last.toISOString().slice(0, 10),
      };
    }
  }
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

// ─── Date card (one per day, rendered as FlatList item) ───────────────────────
function DateCard({
  dateStr,
  foods,
  exercises,
  dayDeficit,
  isDark,
  colors,
}: {
  dateStr: string;
  foods: FoodRec[];
  exercises: ExRec[];
  dayDeficit: number;
  isDark: boolean;
  colors: typeof Colors.light | typeof Colors.dark;
}) {
  const dateObj = new Date(dateStr + 'T00:00:00');
  const dateLabel = `${dateObj.getMonth() + 1}月${dateObj.getDate()}日 ${WEEKDAYS_FULL[dateObj.getDay()]}`;

  return (
    <GlassCard style={styles.listCard}>
      {/* Date header */}
      <View style={[styles.dateHeader, { borderBottomColor: colors.hairline }]}>
        <ThemedText style={styles.dateLabel}>{dateLabel}</ThemedText>
        <ThemedText
          style={[styles.dateDeficit, { color: dayDeficit >= 0 ? colors.ok : colors.warn }]}
        >
          缺口 {dayDeficit >= 0 ? '−' : '+'}{fmt(Math.abs(dayDeficit))}
        </ThemedText>
      </View>

      {foods.map((f, idx) => (
        <RecordRow
          key={f.id}
          item={f}
          isFirst={idx === 0}
          isDark={isDark}
          colors={colors}
        />
      ))}

      {exercises.map((e, idx) => (
        <RecordRow
          key={e.id}
          item={e}
          isFirst={foods.length === 0 && idx === 0}
          isDark={isDark}
          colors={colors}
        />
      ))}
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
}) {
  return (
    <GlassCard style={styles.trendCard}>
      <View style={styles.trendHeader}>
        <ThemedText themeColor="textSecondary" style={styles.trendTitle}>
          {titleText}
        </ThemedText>
        {totalDays > 0 && (
          <ThemedText style={[styles.metBadge, { color: colors.ok }]}>
            达标 {metDays} / {totalDays} 天
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
              kcal / 天
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
          `/api/daily/range?from=${from}&to=${to}&granularity=day`,
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
        const d = new Date(r.period + 'T00:00:00');
        return WEEKDAYS_SHORT[d.getDay() === 0 ? 6 : d.getDay() - 1];
      });
    }
    const step = granularity === 'month' && rangeData.length > 14 ? 7 : 1;
    return rangeData.map((r, i) => {
      if (i % step !== 0) return '';
      const d = new Date(r.period + 'T00:00:00');
      return `${d.getMonth() + 1}/${d.getDate()}`;
    });
  }, [granularity, rangeData]);

  // ── Group records by date (descending) ─────────────────────────────────────
  const groupedRecords: DateGroup[] = useMemo(() => {
    const map = new Map<string, { foods: FoodRec[]; exercises: ExRec[] }>();
    for (const f of foodRecords) {
      const d = toDateOnly(f.date);
      if (!map.has(d)) map.set(d, { foods: [], exercises: [] });
      map.get(d)!.foods.push(f);
    }
    for (const e of exRecords) {
      const d = toDateOnly(e.date);
      if (!map.has(d)) map.set(d, { foods: [], exercises: [] });
      map.get(d)!.exercises.push(e);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([dateStr, group]) => ({ dateStr, ...group }));
  }, [foodRecords, exRecords]);

  // Build a deficit lookup map so DateCard doesn't scan the array
  const deficitMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rangeData) m.set(r.period, r.deficit);
    return m;
  }, [rangeData]);

  const titleText =
    granularity === 'day' ? '近7天平均缺口' : granularity === 'week' ? '本周平均缺口' : '本月平均缺口';

  // ── FlatList helpers ────────────────────────────────────────────────────────
  const renderItem = useCallback(
    ({ item }: { item: DateGroup }) => (
      <DateCard
        dateStr={item.dateStr}
        foods={item.foods}
        exercises={item.exercises}
        dayDeficit={deficitMap.get(item.dateStr) ?? 0}
        isDark={isDark}
        colors={colors}
      />
    ),
    [deficitMap, isDark, colors],
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
      />
    ),
    [titleText, totalDays, metDays, avgDeficit, chartData, chartLabels, chartWidth, isDark, colors],
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
  dateLabel:   { fontSize: 14, fontWeight: '600' },
  dateDeficit: { fontSize: 13, fontWeight: '600' },

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

  // ── Empty state ────────────────────────────────────────────────
  empty:     { marginTop: 24, alignItems: 'center', paddingHorizontal: 16 },
  emptyText: { textAlign: 'center', fontSize: 15, lineHeight: 22 },
});
