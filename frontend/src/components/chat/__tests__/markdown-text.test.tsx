import { render, screen } from '@testing-library/react-native';
import '@testing-library/jest-native/extend-expect';

import { MarkdownText } from '../markdown-text';

describe('MarkdownText 极简渲染器', () => {
  it('纯文本原样显示', () => {
    render(<MarkdownText content="今天摄入 2005 kcal" />);
    expect(screen.getByText('今天摄入 2005 kcal')).toBeTruthy();
  });

  it('**加粗** 拆成独立片段，加粗部分单独可见', () => {
    render(<MarkdownText content="实际缺口 **595** 还在减" />);
    // 加粗片段作为独立 Text 节点存在；星号被消费掉
    expect(screen.getByText('595')).toBeTruthy();
    expect(screen.getByText('实际缺口', { exact: false })).toBeTruthy();
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  it('行首 - / · 渲染为项目符号行（去掉标记，保留内容）', () => {
    render(<MarkdownText content={'- 水煮青菜 150g\n· 兰花豆 30g'} />);
    expect(screen.getByText('水煮青菜 150g')).toBeTruthy();
    expect(screen.getByText('兰花豆 30g')).toBeTruthy();
    // 原始 "- 水煮青菜 150g" 不应作为整体文本出现（标记已被消费）
    expect(screen.queryByText('- 水煮青菜 150g')).toBeNull();
  });

  it('多行 + 空行分段：每行各自成节点', () => {
    render(<MarkdownText content={'早餐 · 约 520\n\n午餐 · 约 780'} />);
    expect(screen.getByText('早餐 · 约 520')).toBeTruthy();
    expect(screen.getByText('午餐 · 约 780')).toBeTruthy();
  });

  it('不认识的 markdown（# 表格 代码块）当普通文本原样显示', () => {
    render(<MarkdownText content="## 标题 | a | b |" />);
    expect(screen.getByText('## 标题 | a | b |')).toBeTruthy();
  });
});
