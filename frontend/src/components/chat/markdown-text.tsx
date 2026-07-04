import { Fragment } from 'react';
import { StyleSheet, View, type TextStyle } from 'react-native';
import { ThemedText } from '@/components/themed-text';

// 极简 markdown 渲染器（只认三样，故意不引库）：
//   **加粗**  → 突出关键数字 / 餐名小标题
//   行首 - · •  → 项目符号行
//   空行        → 分段
// 其它 markdown（标题#、表格、代码块等）一律当普通文本原样显示，不解析。
// 只用于 AI 文字气泡；后端 answers.ts 的 prompt 约束 AI 只产出这三样。

const BULLET_RE = /^\s*[-·•]\s+(.*)$/;
const BOLD_RE = /\*\*(.+?)\*\*/g;

// 把一行里的 **加粗** 切成交替的普通/加粗片段；加粗渲染为嵌套 <Text>
function renderInline(text: string) {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  BOLD_RE.lastIndex = 0;
  while ((m = BOLD_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(
      <ThemedText key={m.index} style={styles.bold}>
        {m[1]}
      </ThemedText>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.map((n, i) => <Fragment key={i}>{n}</Fragment>);
}

export function MarkdownText({
  content,
  baseStyle,
}: {
  content: string;
  baseStyle?: TextStyle | TextStyle[];
}) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  return (
    <View>
      {lines.map((line, i) => {
        if (line.trim() === '') {
          return <View key={i} style={styles.blank} />;
        }
        const bullet = BULLET_RE.exec(line);
        if (bullet) {
          return (
            <View key={i} style={styles.bulletRow}>
              <ThemedText style={[baseStyle, styles.bulletDot]}>·</ThemedText>
              <ThemedText style={[baseStyle, styles.bulletText]}>
                {renderInline(bullet[1])}
              </ThemedText>
            </View>
          );
        }
        return (
          <ThemedText key={i} style={baseStyle}>
            {renderInline(line)}
          </ThemedText>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bold: {
    fontWeight: '700',
  },
  blank: {
    height: 8,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  bulletDot: {
    marginRight: 6,
  },
  bulletText: {
    flex: 1,
  },
});
