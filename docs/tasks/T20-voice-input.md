# T20 — 语音输入

**状态**：✅ 完成  <!-- ⬜待办 / 🔄进行中 / ✅完成 -->

**目标**：点麦克风开始听，说话时文字实时进输入框，点麦克风停止，编辑后发送。
**依赖**：T16

## 做什么

### 1. 安装 expo-speech-recognition

```bash
cd frontend && npx expo install expo-speech-recognition
```

`app.json` 加 plugin：

```json
{
  "expo": {
    "plugins": [
      [
        "expo-speech-recognition",
        {
          "microphonePermission": "允许 Fit 使用麦克风进行语音输入",
          "speechRecognitionPermission": "允许 Fit 使用语音识别转文字"
        }
      ]
    ]
  }
}
```

### 2. 改 chat-input.tsx

只改 `frontend/src/components/chat/chat-input.tsx`。

**新增 import**：

```typescript
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
```

**新增状态**：

```typescript
const [isListening, setIsListening] = useState(false);
```

**四个事件监听**：

```typescript
useSpeechRecognitionEvent('start', () => setIsListening(true));
useSpeechRecognitionEvent('end', () => setIsListening(false));

useSpeechRecognitionEvent('result', (event) => {
  // Partial result 自带完整上下文，直接覆盖即可
  if (event.results[0]?.transcript) {
    setText(event.results[0].transcript);
  }
});

useSpeechRecognitionEvent('error', (event) => {
  setIsListening(false);
  console.warn('Speech error:', event.error, event.message);
});
```

**麦克风按钮改成 toggle**（替换现有的空 `onPress`）：

```tsx
<TouchableOpacity
  activeOpacity={0.6}
  onPress={async () => {
    if (isListening) {
      ExpoSpeechRecognitionModule.stop();
    } else {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) return;
      ExpoSpeechRecognitionModule.start({
        lang: 'zh-CN',
        interimResults: true,
        continuous: true,
      });
    }
  }}
>
  <SymbolView
    name={isListening ? 'mic.fill' : 'mic'}
    size={21}
    tintColor={isListening ? '#0A84FF' : colors.textSecondary}
  />
</TouchableOpacity>
```

**激活态**：图标 `mic` → `mic.fill`，颜色灰 → `#0A84FF`（系统蓝）。

### 3. 不改的东西

- 不建独立录音 UI（无波形、时长、取消/完成按钮）
- 不存音频文件
- 不发 `source=voice`（消息表没这字段，后续需要再加）
- 不碰 chat-store、消息卡片、发送链路

## 验收

- [ ] 点麦克风 → 首次弹权限 → 允许后按钮变蓝（`mic.fill`）
- [ ] 说话时文字实时出现在输入框
- [ ] 再点麦克风 → 停止，按钮恢复灰色
- [ ] 停止后文字留在输入框，可编辑后发送
- [ ] 发送后正常记录（和打字发送无区别）
- [ ] `npx tsc --noEmit` 零错误
