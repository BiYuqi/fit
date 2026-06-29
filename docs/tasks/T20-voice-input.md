# T20 — 语音输入

**状态**：⬜ 待办  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：说话转文字填入输入框。
**依赖**：T16　**关注文档**：DESIGN_SPEC §3，ARCHITECTURE 前端栈

## 做什么
- @react-native-voice/voice(需 Expo Dev Build, config plugin)；录制态 UI(波形+时长+取消/完成)；识别结果填入 Chat 输入框，走文本同一条记录链路；source=voice。

## 验收
- 说一句话→文本进输入框→发送后正常记录。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/DESIGN_SPEC.md。只做任务 T20：接入设备 STT(@react-native-voice/voice, Dev Build)，录制态 UI，识别文本填入 Chat 输入框并以 source=voice 记录。验证一次完整语音记录。
