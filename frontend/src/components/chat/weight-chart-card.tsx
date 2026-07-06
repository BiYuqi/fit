import { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop, Polyline, Line, Text as SvgText } from 'react-native-svg';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors, Glass, FontSize, Radius, Spacing } from '@/constants/theme';
import type { WeightChartPayload } from '@/types/chat';

// 体重趋势卡：等距次序折线（横轴等距，不按真实日期比例——稀疏体重数据这样更清楚）。
// 结论文字（content）由后端算好（铁律1），永远显示；图只在够点（chart=true）时叠加。

function fmtKg(kg: number): string {
  return Number(kg.toFixed(2)).toString();
}

// width 由外层 onLayout 量得，让图填满气泡宽度（避免两侧居中留白）
function Chart({ payload, isDark, width }: { payload: WeightChartPayload; isDark: boolean; width: number }) {
  const accent = Glass[isDark ? 'dark' : 'light'].tint;
  const cardBg = Glass[isDark ? 'dark' : 'light'].backgroundStrong as string;
  const muted = isDark ? '#8E8E93' : '#9A9AA0';

  const pts = payload.points;
  const W = width;
  const H = 138;
  const padX = 16; // 只留够首/末标签不顶边，折线尽量铺满
  const padTop = 20;   // 顶部留给数值标签
  const padBottom = 22; // 底部留给横轴标签
  const cw = W - padX * 2;
  const ch = H - padTop - padBottom;

  const kgs = pts.map((p) => p.kg);
  // 目标线只在落入体重数值域时才画，避免目标远低于体重把折线压扁
  const target = payload.target;
  let max = Math.max(...kgs);
  let min = Math.min(...kgs);
  const pad = (max - min) * 0.18 || 0.5;
  max += pad;
  min -= pad;
  const targetInRange = target != null && target <= max && target >= min;
  const range = max - min || 1;

  const xy = pts.map((p, i) => ({
    x: padX + (pts.length === 1 ? cw / 2 : (i / (pts.length - 1)) * cw),
    y: padTop + ch - ((p.kg - min) / range) * ch,
    p,
  }));
  const linePoints = xy.map((d) => `${d.x},${d.y}`).join(' ');
  const last = xy[xy.length - 1];
  const areaPoints = `${linePoints} ${last.x},${padTop + ch} ${xy[0].x},${padTop + ch}`;
  const targetY = targetInRange ? padTop + ch - ((target! - min) / range) * ch : 0;
  const showLabels = pts.length <= 6; // 点太多只标首尾，免拥挤

  return (
    <Svg width={W} height={H}>
      <Defs>
        <LinearGradient id="wc" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={accent} stopOpacity="0.26" />
          <Stop offset="1" stopColor={accent} stopOpacity="0" />
        </LinearGradient>
      </Defs>

      {targetInRange && (
        <>
          <Line x1={padX} y1={targetY} x2={W - padX} y2={targetY} stroke={muted} strokeWidth="1" strokeDasharray="4,4" />
          <SvgText x={W - padX} y={targetY - 4} fontSize="9" fill={muted} textAnchor="end">
            {`目标 ${fmtKg(target!)}`}
          </SvgText>
        </>
      )}

      <Polyline points={areaPoints} fill="url(#wc)" />
      <Polyline points={linePoints} fill="none" stroke={accent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

      {xy.map((d, i) => (
        <Circle
          key={i}
          cx={d.x}
          cy={d.y}
          r={i === xy.length - 1 ? 4 : 3}
          fill={accent}
          stroke={cardBg}
          strokeWidth={i === xy.length - 1 ? 2 : 1}
        />
      ))}

      {xy.map((d, i) => {
        const isEnd = i === 0 || i === xy.length - 1;
        if (!showLabels && !isEnd) return null;
        return (
          <SvgText key={`v${i}`} x={d.x} y={d.y - 8} fontSize="9.5" fill={accent} textAnchor="middle" fontWeight="600">
            {fmtKg(d.p.kg)}
          </SvgText>
        );
      })}

      {xy.map((d, i) => {
        const isEnd = i === 0 || i === xy.length - 1;
        if (!showLabels && !isEnd) return null;
        return (
          <SvgText key={`x${i}`} x={d.x} y={H - 7} fontSize="9" fill={muted} textAnchor="middle">
            {d.p.label}
          </SvgText>
        );
      })}
    </Svg>
  );
}

export function WeightChartCard({ payload, content }: { payload: WeightChartPayload; content?: string | null }) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const glass = Glass[isDark ? 'dark' : 'light'];
  const textColor = Colors[isDark ? 'dark' : 'light'].text;
  const muted = isDark ? '#8E8E93' : '#9A9AA0';
  const [chartW, setChartW] = useState(0);

  const showChart = payload.chart && payload.points.length >= 2;

  return (
    <View style={styles.wrapper}>
      <View style={[styles.bubble, { backgroundColor: isDark ? 'rgba(44,44,48,0.92)' : '#FFFFFF', borderColor: glass.border, ...glass.shadow }]}>
        <Text style={[styles.title, { color: muted }]}>体重趋势</Text>
        {showChart && (
          <View style={styles.chart} onLayout={(e) => setChartW(e.nativeEvent.layout.width)}>
            {chartW > 0 && <Chart payload={payload} isDark={isDark} width={chartW} />}
          </View>
        )}
        {!!content && <Text style={[styles.conclusion, { color: textColor }]}>{content}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginVertical: Spacing.one,
    alignItems: 'flex-start',
  },
  bubble: {
    width: '90%' as any, // 与 meal_card 同宽（固定 90%），线程内数据卡左右齐平
    borderRadius: Radius.lg,
    borderBottomLeftRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  title: {
    fontSize: FontSize.sm,
    fontWeight: '600',
    marginBottom: 4,
  },
  chart: {
    marginVertical: 4,
    alignSelf: 'stretch', // 填满气泡宽度，图由 onLayout 量到的宽度铺满
  },
  conclusion: {
    fontSize: FontSize.base,
    lineHeight: 21,
    fontWeight: '400',
    marginTop: 2,
  },
});
