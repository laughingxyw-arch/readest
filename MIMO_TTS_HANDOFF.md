# 本地 Codex 接手：MiMo 段落高亮

本次只提交源码，不构建 APK。提交消息包含 `[skip ci]`，跳过此次 push 的 GitHub Actions 编译；现有手动构建和后续自动构建配置仍保留。之前的 MiMo Release 基于 `49dfbeb`，不含本次高亮改动。

## 已实现

- 默认约 30 秒一个朗读段，建议选 15/30 秒。短段落合并；长段落按完整句子拆分；不跨章节拼接。目标时长为估计值，单个很长的句子可能超出。
- 每段一份 WAV、一组原文起止 CFI。音频开始后高亮整段；实际 `ended` 事件决定下一段，移除按字数分配句子时间的播放推进逻辑。
- 跨原文段落自动续读直接定位下一段 CFI，避免将已播放的合并段落再次朗读。
- 段内选句起读使用从该句开始的音频/缓存，不按猜测时间戳 seek。相同文字通过 CFI 区分。
- 保留暂停/继续、倍速、最多一段预生成、本机音频缓存、跨章续读和章末停止。暂停期间生成完成也能保留正确高亮范围。
- 翻页/页面重绘重新应用整段高亮；不猜测段内哪个字正在读，因此没有自动逐字跨页跟随。
- MiMo 模式隐藏逐句停读与 A–B 句子循环；手动句子/段落导航保留。其他朗读引擎不使用新段落推进逻辑。
- 菜单“从这里开始朗读”保持连续朗读；原有快捷键的选区单次朗读仍只提交选区内容。

## 主要代码

- `apps/readest-app/src/services/tts/mimo.ts`：章节/原文段落标记及分段规则。
- `.../MiMoTTSClient.ts`：播放整份音频，发出段落 CFI，实际结束后返回。
- `.../TTSClient.ts`：`segmentBoundaries` 能力与 `TTSPlaybackSegment` 事件。
- `.../TTSController.ts`：解析 CFI、绘制整段高亮、定位下一段或进入下一章。
- `src/app/reader/hooks/useTTSControl.ts` 和播放器组件：根据能力隐藏不适用的句子模式。
- `src/__tests__/services/mimo-segments.test.ts`、`mimo-controller.test.ts`、`mimo-playback.test.ts`：音频实际结束、完整范围、选区起点、连续推进、缓存和暂停回归测试。

## 本地验证

本次提交前验证：11 个相关测试文件、257 项测试全部通过；TypeScript 类型检查、Biome lint 和 `git diff --check` 通过。未执行前端正式构建或 APK 构建。

按仓库开发文档准备 Node/pnpm、子模块及 vendors。在 `apps/readest-app` 下执行：

```sh
pnpm lint
pnpm test --run --maxWorkers=2 src/__tests__/services/mimo-tts.test.ts src/__tests__/services/mimo-playback.test.ts src/__tests__/services/mimo-controller.test.ts src/__tests__/services/mimo-segments.test.ts src/__tests__/services/tts-controller.test.ts src/__tests__/components/settings/MiMoTTSSettings.test.tsx src/__tests__/components/settings/TTSPanel.test.tsx src/__tests__/components/tts/TTSControl.test.tsx src/__tests__/components/tts/TTSPlayerSheet.test.tsx src/__tests__/hooks/useTTSControl.test.tsx src/__tests__/components/annotator/AnnotatorShortcuts.test.tsx
```

普通测试使用模拟音频，不调用 MiMo。真实接口测试 `mimo-live.test.ts` 只有显式设置 `MIMO_TTS_LIVE_KEY` 才运行，不要将密钥写入源码或提交。接口协议未改变，之前的真实 MiMo 生成测试已成功；本次段落高亮尚未进行 Android 真机验证。

本地制作 APK 后重点检查：首段等待、两个短段合并、长段拆分、从段内重复文字起读、暂停期间生成完成、倍速、重听缓存、同章连续切换、跨章及章末停止、跨页手动翻页后的高亮。没有逐句/逐字时间戳，也没有音频对齐模型；模型本身的漏读或重复仍需独立验证。
