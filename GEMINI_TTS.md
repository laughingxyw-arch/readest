# Readest Gemini TTS 定制版

本分支基于 Readest `4c3ccfe85d4afd81e674b67d6a0627d83ba0744d`，增加自己的 Gemini API Key 和 Gemini 语音朗读设置。API Key 不包含在源码中。

## 使用

1. 打开 Readest 设置 → 朗读 → Gemini TTS。
2. 填写自己的 API Key，打开“启用 Gemini 语音朗读”。
3. 选择 `gemini-3.8-flash-tts` 和 `Algenib`，保存。
4. 关闭并重新打开书籍，再启动朗读。在原有声音菜单也可以切换 Gemini 和 Edge 声音。

默认按约 8 分钟的文本组成一个请求，可选 2、4、6、8、9 分钟。这是文本长度估算，不是保证实际音频恰好达到该时长。单个章节结束可能产生不足一段的请求；本版不跨章节合并。

首次朗读等待整段生成，再开始播放。普通段落会复用整段录音；邻近段落预加载也会复用同一个生成任务。在到达下一批文本时生成下一段，可能需要等待。没有加入“首次短段”的额外请求。

本机默认预算为每日 10 次，并限制到每分钟至多 3 次生成请求。Google 的实际限制以 AI Studio 为准；计数只覆盖本页面使用的 Key 和模型，无法统计其他应用或多页面的请求。失败请求也保守计入本机预算，不自动重试。预算按太平洋时间午夜重置，等待一分钟不会恢复每日预算。

音频在此设备缓存，最多约 500 MB；重听相同文本、模型和声音不重新生成。可在设置中清除缓存。跳转到没缓存的文本、切换声音或切换模型可能增加请求。本版没有整本 Gemini 音频导出功能。

Key 保存在此设备的 localStorage，不加入 Readest 设置同步；这是本地明文存储，不是操作系统加密保险库。请求直接发送给 Google，包含待朗读的书籍文本。源码、下载包和提交均不包含用户的 Key。

Gemini 没有返回逐句时间戳，因此本版按文本长度估计阅读位置，并禁用精确高亮、字幕和时间轴。句子跳转不是精确的音频定位。倍速和暂停继续仍可使用。

## 从修改包运行网页版本

需要 Git、Node.js 24 和 pnpm 11。以下命令在终端中逐行运行。Windows 可用 PowerShell。

```sh
git clone https://github.com/readest/readest.git
cd readest
git checkout 4c3ccfe85d4afd81e674b67d6a0627d83ba0744d
git switch -c feat/gemini-tts
git submodule update --init --recursive
```

将下载包中的 `readest-gemini-tts.patch` 复制到仓库根目录，运行：

```sh
git apply readest-gemini-tts.patch
corepack enable
corepack prepare pnpm@11.1.1 --activate
pnpm install --frozen-lockfile
cd apps/readest-app
pnpm setup-vendors
pnpm build-web
pnpm start-web --hostname 127.0.0.1
```

打开 http://127.0.0.1:3000 。请在设置界面输入 Key，勿将 Key 写入代码或提交到 Git。

## 建立自己的 GitHub fork

在 https://github.com/readest/readest 点击 Fork，完成后将本地分支推送到自己的仓库：

```sh
git add apps/readest-app/src apps/readest-app/public/locales/zh-CN/translation.json GEMINI_TTS.md
git commit -m "Add configurable Gemini long-form TTS"
git remote rename origin upstream
git remote add origin https://github.com/YOUR_USERNAME/readest.git
git push -u origin feat/gemini-tts
```

`YOUR_USERNAME` 替换为自己的 GitHub 用户名。上传需要自己的 GitHub 登录凭据。

## Android APK

此 fork 的 `.github/workflows/gemini-apk.yml` 在 `main` 更新时自动构建，也可以在 GitHub Actions 的 **Build Gemini TTS APK** 页面手动运行。

构建产物 `readest-gemini-tts-arm64` 包含 `Readest-Gemini-TTS-arm64-debug.apk` 和 `SHA256SUMS`，保留 14 天。APK 支持 ARM64 Android 8.0 及以上设备，使用 Android 测试签名，不需要把 Gemini Key 或发行签名密钥提交到仓库。

测试版和官方版的签名不同，不能直接覆盖官方安装包。安装前请先备份书籍、批注和设置；卸载已有版本会删除该应用的本地数据。此构建不会发布或覆盖官方发行版。

## 本次修正

- Gemini 关闭普通段落的推测预加载，避免整章分批准备前发送额外短请求。
- 在生成等待期间暂停后，生成完成仍保持暂停，直到用户继续播放。
- 太平洋时间每日预算重置后，允许重新请求此前因预算被拒绝的文本；同一天仍不会自动重试失败请求。

Gemini API 的实际生成需要用户自己的模型访问权限、Key 和额度；单元测试使用模拟响应，不消耗真实 API 配额。构建成功本身不能证明用户的 Key 或模型额度可用。
