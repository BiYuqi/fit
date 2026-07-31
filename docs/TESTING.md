# TESTING — 前端组件测试规范

> 怎么给 UI 组件写测试、怎么跑。后端测试策略见 `TEST_PLAN.md`。

## 技术栈与版本约束

| 包 | 版本 | 为什么这个版本 |
|---|---|---|
| `jest` | **29.x** | Jest 30 与 `jest-expo` 未适配，`clearMocksOnScope` 报错 |
| `jest-expo` | ~56.0.0 | Expo 官方 preset，零配置 mock RN/Expo 全量模块 |
| `@testing-library/react-native` | **12.x** | v13/v14 依赖 RN monorepo 内部的 `test-renderer` 包（npm 公网不存在），只有 v12 能直接用 `react-test-renderer` |
| `@testing-library/jest-native` | 5.x | `toBeOnTheScreen()` 等 RN 专用匹配器 |
| `@types/jest` | 29.x | Jest 全局类型（`describe`、`it`、`expect`） |

**不要随便升这些包**。版本组合是踩坑踩出来的，牵一发动全身。

## 目录结构

```
frontend/
├── jest.config.js              # 一行 preset + aliases + CSS stub
├── tsconfig.json               # 主构建，exclude __tests__
├── tsconfig.test.json          # 测试专用，加 jest 类型
├── src/test/
│   ├── mocks.ts                # 集中管理的 mock 工厂
│   └── empty-module.js         # CSS/image 导入的 stub
└── src/components/**/__tests__/
    ├── exercise-card.test.tsx   # 9 tests，参考模板
    └── record-card.test.tsx     # 13 tests，参考模板
└── src/stores/__tests__/
    └── chat-store.test.ts       # store 逻辑测试参考模板（见下）
```

## Store 逻辑测试（不渲染组件）

组件测试是 mock 掉 store；**store 自身的逻辑**（分页、窗口、同步）反过来——跑真 store，mock 掉 `@/lib/db`（假 SQLite）和 `@/lib/api`（假服务端），直接 `useChatStore.getState().xxx()` 调 action、断言 state。参考 `src/stores/__tests__/chat-store.test.ts`。

两条硬要求：

1. **mock 工厂引用的外部变量名必须以 `mock` 开头**（`mockServer` / `mockLocal`）。`jest.mock()` 会被提升到 import 之前，引用普通变量名直接编译报错，只有 `mock*` 前缀被放行。
2. **模块级状态要按用例隔离**。store 里的并发锁、冷却计时器是模块级变量，跨用例会串味：

```typescript
function freshStore(): typeof import('@/stores/chat-store').useChatStore {
  let store: typeof import('@/stores/chat-store').useChatStore | undefined;
  jest.isolateModules(() => { store = require('@/stores/chat-store').useChatStore; });
  return store!;
}
```

> 用 `jest.isolateModules` + `require`，**不要用 `await import()`** —— jest-expo 跑在 CJS 环境，动态 import 会报 `A dynamic import callback was invoked without --experimental-vm-modules`。

## 架构原则

### 1. 集中 mock，测试文件只声明差异

`src/test/mocks.ts` 定义所有 store 的工厂函数。每个工厂返回完整默认状态 + 可选的 `overrides` 参数。测试文件**只覆写自己关心的字段**，不重写整个 mock。

```typescript
// ✅ 好 — 只覆写差异
mockUseChatStore.mockReturnValue(createMockChatStore({ undo: mockUndo }));

// ❌ 差 — 在测试文件里手写完整 mock 对象
jest.mock('@/stores/chat-store', () => ({
  useChatStore: () => ({ undo: jest.fn(), messages: [], loading: false, ... }),
}));
```

### 2. 三行固定模板，不自己发明 mock 写法

```typescript
const mockUseAuthStore = jest.fn();
const mockUseChatStore = jest.fn();

jest.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector?: (s: unknown) => unknown) =>
    selector ? selector(mockUseAuthStore()) : mockUseAuthStore(),
}));

jest.mock('@/stores/chat-store', () => ({
  useChatStore: (selector?: (s: unknown) => unknown) =>
    selector ? selector(mockUseChatStore()) : mockUseChatStore(),
}));

jest.mock('@/hooks/use-color-scheme', () => ({
  useColorScheme: () => 'light',
}));
```

> 这个模板处理了 zustand 的 selector 模式：`useXxxStore()` 无参会返回完整 state，`useXxxStore(s => s.field)` 有参会走 selector。

### 3. 测试文件顶部必须 import jest-native

```typescript
import '@testing-library/jest-native/extend-expect';
```

**不能**放 `jest.config.js` 的 `setupFiles` 里——`setupFiles` 运行时 `expect` 尚未初始化。也不能放 `globalSetup` 里——那是 Node 环境，没有 `expect` 全局变量。只能每个测试文件自己 import。

## 写测试的标准流程

### Step 1：创建文件

在组件同级建 `__tests__/` 目录，文件命名 `<component>.test.tsx`。

### Step 2：搭骨架

复制以下模板：

```typescript
import { render, screen, fireEvent } from '@testing-library/react-native';
import { jest } from '@jest/globals';
import '@testing-library/jest-native/extend-expect';

import { YourComponent } from '../your-component';
import { createMockAuthStore, createMockChatStore } from '@/test/mocks';
import type { YourPayloadType } from '@/types/chat';

// ─── Module mocks ───────────────────────────────────
const mockUseAuthStore = jest.fn();
const mockUseChatStore = jest.fn();

jest.mock('@/stores/auth-store', () => ({
  useAuthStore: (s?: unknown) => s ? s(mockUseAuthStore()) : mockUseAuthStore(),
}));
jest.mock('@/stores/chat-store', () => ({
  useChatStore: (s?: unknown) => s ? s(mockUseChatStore()) : mockUseChatStore(),
}));
jest.mock('@/hooks/use-color-scheme', () => ({
  useColorScheme: () => 'light',
}));

// ─── Helpers ────────────────────────────────────────
function basePayload(overrides = {}) {
  return { /* 最小完整 props */ ...overrides };
}
function renderCard(payload: YourPayloadType, messageId = 'msg-1') {
  return render(<YourComponent payload={payload} messageId={messageId} />);
}

// ─── Tests ──────────────────────────────────────────
describe('YourComponent', () => {
  beforeEach(() => {
    mockUseAuthStore.mockReturnValue(createMockAuthStore());
    mockUseChatStore.mockReturnValue(createMockChatStore());
  });

  it('renders X, Y, Z', () => { /* ... */ });
  it('handles edge case W', () => { /* ... */ });
  it('fires callback on interaction', () => { /* ... */ });
});
```

### Step 3：决定要测什么

按优先级排序：

1. **正常渲染** — 给了 props 后关键文本出现在屏幕上
2. **条件渲染** — 某个 prop 存在/不存在时，某段 UI 出现/消失
3. **用户交互** — 点击按钮后回调被调用，传参正确
4. **状态转换** — undo 后从可点击变成不可点击
5. **边界值** — 0、null、undefined、空字符串不崩

不是写得越多越好——**一个 it 只测一件事**，名字描述期望行为而非实现。

### Step 4：新增 mock 工厂（如果需要）

如果被测组件依赖了新 store（比如 `useSettingsStore`），去 `src/test/mocks.ts` 加：

```typescript
export function createMockSettingsStore(overrides = {}) {
  return {
    language: 'zh',
    theme: 'system',
    ...overrides,
  };
}
```

然后测试文件里加上对应的 `jest.mock()` 和 `mockUseSettingsStore`。

## 跑测试

```bash
cd frontend

npm test                    # 全量一次
npx jest exercise-card      # 只跑匹配的文件名
npx jest --watch            # 改代码自动重跑
npx jest --coverage         # 带覆盖率报告
```

## 断言怎么写

```typescript
// 存在性
expect(screen.getByText('跑步')).toBeOnTheScreen();
expect(screen.queryByText('不该出现')).not.toBeOnTheScreen();

// 函数调用
expect(mockFn).toHaveBeenCalledTimes(1);
expect(mockFn).toHaveBeenCalledWith(arg1, arg2, arg3);

// 正则匹配（中文文本合并时特别有用）
expect(screen.getByText(/早餐/)).toBeOnTheScreen();
expect(screen.getByText(/150g/)).toBeOnTheScreen();
```

> **中文文本必须用 regex。** 因为 `ThemedText` 会把多个子文本合并成一个 Text 节点。比如 `<Text>早餐 · 150g</Text>`，`getByText('早餐')` 精确匹配会失败，`getByText(/早餐/)` 子串匹配才通过。

## 已知坑

| 坑 | 症状 | 根因 | 解法 |
|---|---|---|---|
| RNTL v14 | `Cannot find module 'test-renderer'` | 依赖 RN monorepo 内部包 | 死钉 v12 |
| Jest 30 | `clearMocksOnScope is not a function` | jest-expo 未适配 | 死钉 29 |
| CSS import | `Unexpected token ':'` 在 `.css` 文件 | Jest 不会解析 CSS | `moduleNameMapper: { '\\.css$': '...stub' }` |
| `toBeOnTheScreen` 报 undefined | `expect(...).toBeOnTheScreen is not a function` | `extend-expect` 没 import | 测试文件顶部加 import |
| 中文 `getByText` 失败 | 明明有文字但 `Unable to find` | Text 节点合并，精确匹配失败 | 用 regex：`getByText(/中文/)` |
| `setupFiles` 里 import jest-native | `expect is not defined` | `expect` 在 setup 阶段还不存在 | 在每个测试文件里 import |
| `jest.mock` 工厂引用外部变量 | `The module factory of jest.mock() is not allowed to reference out-of-scope variables` | 工厂被提升到 import 之前 | 变量名加 `mock` 前缀 |
| 测试里 `await import()` | `dynamic import callback was invoked without --experimental-vm-modules` | jest-expo 跑 CJS | `jest.isolateModules` + `require` |
| 组件用了 Reanimated / 手势 | `Native part of Worklets doesn't seem to be initialized` | `*.native.ts` 入口拿不到原生模块 | `jest.config.js` 已配 `resolver: 'react-native-worklets/jest/resolver'` + gesture-handler 的 `jestSetup.js`，别删 |
| 组件用了 `useSafeAreaInsets` | `No safe area value available` | 测试树里没有 Provider | 用 `<SafeAreaProvider initialMetrics={...}>` 包一层（见 `memory-modal.test.tsx`） |
| 列表按时间排序 | 断言的行序和实际不符，`getAllByX()[0]` 点错行 | fixture 用 `new Date()` 造时间戳，几条挤在同一毫秒 | fixture 写死不同的 `created_at`；点击目标用 `getByLabelText` 而不是下标 |

## 与 CI 的关系

目前 CI 尚未接入。等接入时在 CI pipeline 加一步：

```yaml
- name: Test
  run: |
    cd frontend
    npm ci
    npx jest --coverage --ci
```

`--ci` 会让 Jest 在非 TTY 环境正常运行，不会尝试 fancy 输出。

## 不要写的测试

- **纯样式断言**（`opacity: 0.55`）—— 脆弱，重构就断。测行为不测样式值。
- **快照测试** —— React Native 渲染树不稳定，每次升级都可能变。
- **mock 了被测组件本身的测试** —— 你测的不是你的代码。
- **测试第三方库的行为** —— 测你自己的逻辑，信任库的测试。
