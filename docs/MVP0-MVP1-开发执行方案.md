# AI is ON Demo：MVP0/MVP1 开发执行方案

> 目标读者：接下来负责开发的 Claude Code / 本地 coding agent
> 目标：尽可能复用本机 Claude Code 运行时，快速验证“AI 常驻监听信息流 + 主动处理 + 极简对话入口”的产品模式是否成立。
> 关联文档：`docs/MVP-PRD.md`、`docs/AI-is-ON-系统架构.md`、`docs/产品架构文档.md`

---

## 1. 项目目标

### 1.1 这次要验证什么

本 demo 不追求完整产品，也不追求工程洁癖。它只验证一个核心问题：

> 当 AI 持续读取我的飞书上下文，并把重要信息整理成可交互卡片和对话建议时，我是否真的觉得它“在帮我省心”。

### 1.2 这次不验证什么

- 不验证多用户。
- 不验证复杂企业权限。
- 不验证自动发送消息或邮件。
- 不验证移动端。
- 不重写一个完整 Agent Runtime。
- 不直接大规模改造 Claude Code 源码。

### 1.3 最大程度复用 Claude Code 的原则

本地研究 demo 允许使用 `/Users/xinming/MyProject/claude-code-research/package/cli.js` 作为 Claude Code runtime。

优先复用：

- Claude Code 的 agent loop。
- Claude Code 的 tool calling。
- Claude Code 的 BashTool。
- Claude Code 的 WebSearch/WebFetch。
- Claude Code 的 stream-json 输入输出协议。
- Claude Code 的 session 能力。
- Claude Code 的子 Agent 能力不纳入 MVP0/MVP1，启动时不打开 `Agent` 工具。

避免做：

- 不优先编译 `restored-src`。
- 不优先 import Claude Code 内部 TS 模块。
- 不把还原源码复制进产品代码。
- 不依赖内部未稳定 API。

落地方式：

```text
前端/后端是产品壳子。
Claude Code 是本地 Agent 内核。
lark-cli 是飞书工具层。
SQLite 是 demo 状态层。
```

---

## 2. MVP 分期范围

### 2.1 MVP0：手动交互闭环

目标：用户可以在一个极简页面里语音/文字输入，后端把输入转给 Claude Code Runtime，Claude Code 可以通过 `lark-cli` 查询飞书数据，并把结果流式返回前端。

MVP0 只做“用户主动问，Agent 主动查”。

用户故事：

```text
用户打开本地网页。
用户点击麦克风说：“帮我看看今天有什么要处理的。”
前端录音并上传给后端。
后端将音频转为飞书 ASR 要求的 PCM 后，调用飞书语音识别 API 转成文字。
前端把识别出的文字填入输入框，用户确认后发送给后端。
后端把 prompt 写入 Claude Code runtime。
Claude Code 调用 lark-cli 查询日历或相关信息。
前端展示 Claude Code 的回答、工具调用状态和最终建议。
```

MVP0 必须完成：

- 极简 Web 前端。
- 语音输入：前端录音 + 后端飞书 ASR 识别。
- 文本输入。
- 对话消息流。
- 后端启动 Claude Code 子进程。
- 后端向 Claude Code 写入用户消息。
- 后端读取 Claude Code stream-json 输出。
- Claude Code 可以执行只读 `lark-cli` 命令。
- 一条手动查询飞书日历的链路跑通。

MVP0 不要求：

- 自动轮询。
- 卡片优先级分类。
- SQLite 完整事件表。
- 自动推送。
- 文档/邮件/消息多源采集。

验收标准：

```text
在前端输入：“查一下我今天的日程，并判断有什么需要我提前准备。”
系统应返回：
1. Claude Code 正常响应；
2. 至少一次 lark-cli 调用；
3. 日程摘要；
4. 需要准备事项或“暂无需要准备”；
5. 页面不刷新，消息流持续更新。
```

### 2.2 MVP1：自动信息流闭环

目标：系统后台定时拉取飞书上下文，把新增信号喂给 Claude Code，让它做初步筛选、优先级判断和建议，前端展示成卡片流。

MVP1 做“用户不问，系统也在看”。

用户故事：

```text
用户打开页面后不说话。
后台每隔一段时间拉取飞书日历和 @我消息。
系统发现新的日程或 @我消息。
Claude Code 判断是否重要。
前端出现一张卡片：这件事为什么可能需要处理、建议动作是什么、是否需要回复或准备。
用户可以点“知道了”“稍后处理”“生成回复草稿”“忽略这类”。
```

MVP1 必须完成：

- SQLite 状态存储。
- 后台 collector 定时运行。
- 最少接入两个数据源：
  - 日历：`lark-cli calendar +agenda`
  - @我消息：`lark-cli im +messages-search --is-at-me`
- 原始信号去重。
- 把新增信号整理成 prompt 喂给 Claude Code。
- Claude Code 输出结构化 triage JSON。
- 后端把 triage JSON 转成前端卡片。
- 卡片按钮可以改变卡片状态。

MVP1 可选增强：

- 未读邮件：`lark-cli mail +triage`
- 最近文档：`lark-cli drive +search --edited-since`
- 文档评论：`lark-cli drive +search --commented-since`

验收标准：

```text
修改一个今天或明天的日历事件，或制造一条 @我消息。
在 collector 下一次执行后：
1. `events` 表出现 raw event；
2. `triage_results` 表出现分析结果；
3. 前端卡片流出现对应卡片；
4. 卡片包含优先级、原因、建议动作；
5. 点击卡片按钮后状态能持久化。
```

---

## 3. 推荐技术栈

### 3.1 首选栈

```text
语言：TypeScript
前端：Vite + React
后端：Node.js + Express + ws
状态存储：SQLite
Claude Runtime：node /Users/xinming/MyProject/claude-code-research/package/cli.js
飞书工具：lark-cli
语音输入：飞书语音识别 API（`speech_to_text`），浏览器 Web Speech API 仅作为可选兜底
```

### 3.2 为什么先用 Web 而不是 Electron

原 `docs/MVP-PRD.md` 中提到 Electron。当前为了最快验证产品模式，MVP0/MVP1 改为本地 Web：

- 启动快。
- 调试快。
- 前端代码少。
- 浏览器原生支持录音，语音识别交给飞书 ASR，效果和飞书生态更一致。
- 后续可以原样迁移到 Electron。

### 3.3 目录结构建议

如果当前仓库没有工程结构，按下面创建：

```text
ai-is-on/
├── docs/
│   ├── MVP-PRD.md
│   └── MVP0-MVP1-开发执行方案.md
├── apps/
│   ├── web/
│   │   ├── package.json
│   │   ├── index.html
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   ├── main.tsx
│   │   │   ├── styles.css
│   │   │   ├── components/
│   │   │   │   ├── Composer.tsx
│   │   │   │   ├── MessageList.tsx
│   │   │   │   ├── SignalCard.tsx
│   │   │   │   └── StatusBar.tsx
│   │   │   └── lib/
│   │   │       ├── api.ts
│   │   │       └── speech.ts
│   │   └── vite.config.ts
│   └── server/
│       ├── package.json
│       ├── src/
│       │   ├── index.ts
│       │   ├── config.ts
│       │   ├── db.ts
│       │   ├── claude/
│       │   │   ├── ClaudeRuntime.ts
│       │   │   ├── protocol.ts
│       │   │   └── prompts.ts
│       │   ├── collectors/
│       │   │   ├── calendarCollector.ts
│       │   │   ├── imCollector.ts
│       │   │   ├── mailCollector.ts
│       │   │   └── driveCollector.ts
│       │   ├── speech/
│       │   │   ├── transcribe.ts
│       │   │   ├── ffmpeg.ts
│       │   │   └── larkSpeechToText.ts
│       │   ├── triage/
│       │   │   ├── enqueueSignals.ts
│       │   │   ├── parseTriage.ts
│       │   │   └── triagePrompt.ts
│       │   ├── routes/
│       │   │   ├── chat.ts
│       │   │   ├── cards.ts
│       │   │   └── debug.ts
│       │   └── ws.ts
│       └── tsconfig.json
├── data/
│   └── ai-is-on.sqlite
└── package.json
```

---

## 4. 前端交互设计

### 4.1 页面目标

前端只做一个界面：让用户感觉“这个 Agent 在场”。

页面不做复杂导航，不做设置中心，不做多页面。

第一屏包含：

- 顶部状态栏。
- 卡片流。
- 对话流。
- 底部语音/文字输入。

### 4.2 页面布局

桌面宽屏布局：

```text
┌─────────────────────────────────────────────────────────────┐
│ AI is ON                                    ● Claude 在线   │
│ 正在监听：日历 / @我消息                     下次扫描 00:42  │
├───────────────────────────────┬─────────────────────────────┤
│ 卡片流                         │ 对话                         │
│                               │                             │
│ [P0] 14:00 产品评审会          │ 你：今天有什么要处理？       │
│      建议提前准备 PRD          │ AI：我看了一下，下午...      │
│      [准备材料][稍后][忽略]    │                             │
│                               │ Claude 正在调用 lark-cli...  │
│ [P1] 有人 @你                  │                             │
│      xxx 群里问你...           │                             │
│      [生成草稿][知道了]        │                             │
├───────────────────────────────┴─────────────────────────────┤
│ [麦克风]  输入：帮我看今天有什么必须处理...        [发送]   │
└─────────────────────────────────────────────────────────────┘
```

窄屏布局：

```text
┌──────────────────────────────┐
│ AI is ON        ● 在线        │
├──────────────────────────────┤
│ Tabs: [卡片] [对话] [日志]    │
├──────────────────────────────┤
│ 当前 Tab 内容                 │
├──────────────────────────────┤
│ [麦克风] 输入框       [发送]  │
└──────────────────────────────┘
```

MVP0 可以只做单列：

```text
顶部状态栏
消息流
输入区
```

MVP1 再拆出卡片流。

### 4.3 顶部状态栏

展示内容：

- 产品名：`AI is ON`
- Claude Runtime 状态：
  - `启动中`
  - `在线`
  - `忙碌`
  - `等待权限`
  - `离线`
- 数据源状态：
  - `日历`
  - `@我消息`
  - `邮件`
  - `文档`
- 最近扫描时间。
- 下次扫描倒计时。

示例：

```text
AI is ON · Claude 在线 · 正在监听：日历、@我消息 · 47 秒后扫描
```

### 4.4 对话流

对话流展示四种消息：

```ts
type ChatMessage =
  | {
      role: 'user';
      text: string;
      createdAt: string;
    }
  | {
      role: 'assistant';
      text: string;
      createdAt: string;
    }
  | {
      role: 'tool';
      toolName: string;
      summary: string;
      status: 'running' | 'done' | 'failed';
      createdAt: string;
    }
  | {
      role: 'system';
      text: string;
      level: 'info' | 'warn' | 'error';
      createdAt: string;
    };
```

交互要求：

- 用户发送后，输入框立即清空。
- Claude 思考时显示“Claude 正在处理...”。
- 工具调用时显示轻量状态，例如：
  - `正在读取飞书日历`
  - `正在搜索 @我消息`
  - `正在整理结果`
- 不直接把很长的 raw JSON 展示给用户。
- Debug 日志可以放在折叠区域，MVP0 可先不做。

### 4.5 语音输入

MVP0 优先使用飞书语音识别 API，不使用浏览器 Web Speech API 作为主链路。

飞书官方提供两个 ASR 接口：

```text
识别语音文件：
POST /open-apis/speech_to_text/v1/speech/file_recognize

识别流式语音：
POST /open-apis/speech_to_text/v1/speech/stream_recognize
```

MVP0 使用 `file_recognize`，因为实现简单、稳定，适合一次录音后识别。

MVP1 如需边说边出字，再引入 `stream_recognize`。

接口要求：

- 权限：`speech_to_text:speech`（应用级 scope，通常需要租户管理员在开发者后台审批开通；个人账号没有这个权限的话整条 ASR 链路都跑不通，先去后台申请再写代码）
- Token：官方文档要求 `tenant_access_token`，通过 `lark-cli api --as bot` 调用
- 音频格式：目前仅支持 `pcm`
- 引擎：目前仅支持 `16k_auto` 中英混合
- 文件识别适合 60 秒以内音频
- 免费版不支持调用
- 文件识别限流：单租户 20 QPS
- 流式识别限流：全局租户 20 路，一个 `stream_id` 是一路会话

交互状态：

```text
默认：麦克风按钮
点击后：录音中，按钮高亮，输入框显示“正在录音...”
再次点击：停止录音，显示“正在识别...”
识别成功：识别文本填入输入框，用户可编辑
识别失败：显示“飞书语音识别不可用，请用文字输入”
```

行为规则：

- 语音识别结果先进入输入框，不自动发送。
- 用户可以编辑识别结果。
- 用户按 Enter 或点发送才提交。
- 单次录音 MVP0 限制为 60 秒以内。
- 如果浏览器不支持录音，隐藏麦克风按钮或显示不可用。
- 支持快捷键：
  - `Enter` 发送
  - `Shift + Enter` 换行
  - `Cmd/Ctrl + K` 聚焦输入框
  - `Cmd/Ctrl + /` 切换语音输入（macOS Chrome 的 `Cmd + M` 会被浏览器吞掉用于最小化窗口）

前端 recorder helper：

```ts
export type VoiceInputState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'unsupported'
  | 'error';

export function createVoiceRecorder(options: {
  onAudioReady(blob: Blob): void;
  onStateChange(state: VoiceInputState): void;
  onError(error: string): void;
}) {
  // 使用 MediaRecorder 采集浏览器音频
  // 推荐录制 audio/webm 或 audio/mp4，交给后端转 PCM
}
```

后端识别接口：

```text
POST /api/speech/transcribe
Content-Type: multipart/form-data
字段：audio=<Blob>
返回：{ "text": "识别后的文本" }
```

后端处理流程：

```text
浏览器音频 Blob
  → 写入临时文件
  → ffmpeg 转码为 16kHz / mono / s16le PCM
  → base64 编码
  → 把 base64 + 元数据写到一个临时 JSON 文件
  → lark-cli api POST ... --data @<json 文件> --as bot
  → 返回 recognition_text
  → 删除临时文件
```

推荐 ffmpeg 转码命令：

```bash
ffmpeg -y -i input.webm -ac 1 -ar 16000 -f s16le output.pcm
```

**不要**把 base64 PCM 直接写进 `--data '...'` 内联字符串。60 秒 16kHz / mono / s16le PCM ≈ 1.92MB，base64 后 ≈ 2.56MB；macOS 的 `ARG_MAX` 只有 ~1MB，命令会直接 `E2BIG`。必须走 `--data @file`（文件路径）或 `--data -`（stdin）。

飞书 ASR 调用示例（推荐 `--data @file`）：

```bash
# 1) 生成请求 JSON，用 jq 避免手拼 base64 转义
jq -n \
  --arg speech "$(base64 -i output.pcm)" \
  --arg file_id "$FILE_ID" \
  '{
    speech:  { speech: $speech },
    config: { file_id: $file_id, format: "pcm", engine_type: "16k_auto" }
  }' > /tmp/speech-request.json

# 2) 发请求
lark-cli api POST /open-apis/speech_to_text/v1/speech/file_recognize \
  --as bot \
  --data @/tmp/speech-request.json

# 3) 用完删
rm -f /tmp/speech-request.json
```

也可以走 stdin：`cat /tmp/speech-request.json | lark-cli api POST ... --data -`。

`file_id` 规则：

- 仅包含字母、数字、下划线。
- 长度不少于 16；推荐用 16 字节随机值的 hex 表示，即 32 个字符（例如 `crypto.randomBytes(16).toString('hex')`）。
- 每次识别生成一个新的随机值。

### 4.6 输入框

输入框 placeholder：

```text
问我任何事，或者说“帮我看今天有什么必须处理”
```

MVP0 推荐内置快捷 prompt：

- `今天有什么必须处理？`
- `查一下我今天的日程`
- `有没有人 @我？`
- `帮我总结最近新增的信号`

快捷 prompt 以小按钮显示在输入框上方或空状态中。

### 4.7 卡片流

MVP1 引入卡片流。

卡片数据结构：

```ts
type SignalCard = {
  id: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  source: 'calendar' | 'im' | 'mail' | 'drive' | 'manual';
  title: string;
  summary: string;
  reason: string;
  suggestedAction?: string;
  draftReply?: string;
  status: 'new' | 'acknowledged' | 'snoozed' | 'dismissed' | 'done';
  actions: CardAction[];
  rawEventId?: string;
  createdAt: string;
};

type CardAction = {
  id: string;
  label: string;
  kind:
    | 'ack'
    | 'snooze'
    | 'dismiss'
    | 'ask_agent'
    | 'draft_reply'
    | 'open_source'
    | 'mark_done';
  prompt?: string;
};
```

优先级显示：

- P0：红色/强调，必须现在看。
- P1：橙色，今天处理。
- P2：普通，稍后/日报。
- P3：低调，默认可折叠。

卡片标准内容：

```text
[P1 · 日历]
14:00 产品评审会可能需要准备

原因：
这是今天下午的评审会，标题包含“评审”，并且你是参会人。

建议：
提前看一下 PRD 和上次相关讨论。

[帮我准备] [稍后提醒] [知道了] [忽略这类]
```

按钮行为：

- `知道了`：更新 status 为 `acknowledged`。
- `稍后提醒`：更新 status 为 `snoozed`，MVP1 可只标记，不必真的提醒。
- `帮我准备`：发送一条 prompt 给 Claude Runtime，包含 card 上下文。
- `生成回复草稿`：发送 prompt 给 Claude Runtime，要求只生成草稿，不发送。
- `忽略这类`：MVP1 先只记录到 `user_rules`，collector/triage 可在下一轮 prompt 中带上规则。

### 4.8 空状态

首次打开页面：

```text
AI is ON
我会帮你看日历和 @你消息。你可以先问：

[今天有什么必须处理？]
[查一下我今天的日程]
[有没有人 @我？]
```

MVP1 卡片为空时：

```text
现在没有需要你立刻处理的事。
我会继续看着日历和 @你消息。
```

---

## 5. Claude Code Runtime 接入

### 5.1 启动方式

后端启动一个 Claude Code 子进程。

命令模板：

```bash
node /Users/xinming/MyProject/claude-code-research/package/cli.js \
  -p \
  --bare \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions \
  --tools Bash,WebSearch,WebFetch \
  --allowedTools "Bash(lark-cli:*)" \
  --append-system-prompt "$SYSTEM_PROMPT"
```

关键点：

- 直接 `--dangerously-skip-permissions`。这是经过用户确认的 demo 选择：每次工具调用要 control_request / control_response 走 stdin 握手太重，且 MVP0/MVP1 的工具白名单只放只读 lark-cli + WebSearch/WebFetch，软约束已足够。
- 不打开 `Agent` 工具（参考 §1.3）。
- `--bare` 关掉 hooks / LSP / plugin sync / auto-memory / `CLAUDE.md` 自动发现；认证选择见 §12.1。
- WebSearch/WebFetch 也在 `--tools` 里允许，便于 Claude 主动补背景信息；但仍然不允许任何写飞书的工具。
- 安全边界从此**完全**由 system prompt + tools 白名单 + 不暴露写操作的 lark-cli 命令一起保障，没有 permission 弹窗兜底（详见 §13.1）。

### 5.2 System Prompt

建议放在 `apps/server/src/claude/prompts.ts`。

```text
你是 AI is ON 的本地研究 demo 内核。

你的职责：
1. 帮用户读取飞书日历、@我消息、邮件和文档相关信息。
2. 判断哪些信息与用户相关。
3. 区分优先级：P0 立刻处理、P1 今天处理、P2 日报汇总、P3 仅记录。
4. 给出明确建议和必要时的回复草稿。
5. 用户主动询问时，直接回答并说明依据。
6. 后台信号输入时，输出结构化 JSON，方便前端生成卡片。

工具边界：
- 你可以使用 Bash 调用 lark-cli 查询信息。
- 你可以使用 WebSearch/WebFetch 补充公开互联网信息。
- 未经用户确认，不要发送飞书消息、邮件、修改日程、修改文档、删除任何东西。
- 遇到写操作需求时，只生成草稿或建议，等待用户确认。

回答风格：
- 简洁。
- 先说结论。
- 对 P0/P1 说明为什么重要。
- 对不确定的信息要标注“不确定”。

后台 triage 输出要求：
当用户消息中包含 <signals> 标签时，只输出 JSON，不要输出 Markdown。
JSON 格式见开发文档中的 TriageResult。
```

### 5.3 输入协议

后端写入 Claude Code stdin 的格式采用 SDK user message。

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "查一下我今天的日程"
  },
  "parent_tool_use_id": null
}
```

每条消息以 `\n` 结尾。

### 5.4 输出处理

Claude Code stream-json 输出中，至少处理这些类型：

- `assistant`：提取 `message.content` 中的 text。
- `user`：包含 `tool_result` 回显，可用于在前端展示工具结果或丢弃。
- `result`：一次 turn 完成。
- `system`：状态消息，必要时展示。
- `stream_event`：可忽略或用于流式展示。

因为启动用了 `--dangerously-skip-permissions`，不会再有 `control_request` 事件，不需要做 control_response 握手。

后端内部统一成：

```ts
type RuntimeEvent =
  | { type: 'assistant_text'; text: string; raw: unknown }
  | { type: 'tool_start'; toolName: string; input: unknown; raw: unknown }
  | { type: 'tool_result'; toolName: string; output: unknown; raw: unknown }
  | { type: 'turn_done'; result?: string; raw: unknown }
  | { type: 'runtime_error'; error: string; raw?: unknown };
```

注意：

- 不要把 stdout 中非 JSON 行当作协议消息。
- stderr 写入日志。
- 子进程退出后，前端状态变为 `离线`，提供“重启 Runtime”按钮。

### 5.5 ClaudeRuntime 类

建议接口：

```ts
export class ClaudeRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  sendUserMessage(text: string, meta?: Record<string, unknown>): Promise<void>;
  on(event: 'runtime_event', handler: (event: RuntimeEvent) => void): void;
  getStatus(): RuntimeStatus;
}

export type RuntimeStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'stopped'
  | 'error';
```

### 5.6 后台 Triage Runtime

MVP1 后台 triage 不复用前台对话 `ClaudeRuntime` 进程，也不维护一个长期驻留的后台 Claude 进程。

推荐实现为每轮 triage 都 spawn 一个一次性 Claude Code 子进程：

```bash
echo '<signals>{"items":[]}</signals>' | node "$CLAUDE_CODE_CLI" \
  -p \
  --bare \
  --output-format json \
  --tools Bash \
  --allowedTools "Bash(lark-cli:*)" \
  --append-system-prompt "$TRIAGE_PROMPT" \
  --dangerously-skip-permissions
```

Triage 进程比前台对话更克制：只开 `Bash`，不开 `WebSearch/WebFetch`，避免后台 Claude 在分类时跑到外网。`--output-format json` 让一次性进程在 turn 结束后直接以单个 JSON 对象退出，方便后端 `JSON.parse(stdout)` 拿 `result.text` 后走 §8.4 的解析策略。

设计理由：

- 无状态，每轮 triage 独立。
- 避免后台 session 越来越脏。
- 不需要维护 stdin 队列。
- 不需要处理 turn 之间的状态泄漏。
- 失败后下一轮重新 spawn，重启成本接近为零。

代价是每轮会有约 1-2 秒冷启动。MVP1 collector 间隔是 2-5 分钟，这个开销可以接受。

---

## 6. lark-cli 接入

### 6.1 前置检查

开发前先跑：

```bash
lark-cli doctor
lark-cli calendar +agenda --as user --format json
lark-cli im +messages-search --as user --is-at-me --start "$(date -v-1H +%Y-%m-%dT%H:%M:%S%z)"
```

如果 `doctor` 显示未登录 user，先走：

```bash
lark-cli auth login --domain calendar
lark-cli auth login --domain im
```

邮件、文档后续再授权：

```bash
lark-cli auth login --domain mail
lark-cli auth login --scope "docs:document.comment:read"
```

### 6.2 MVP0 允许 Claude 自己调用

MVP0 中，Claude Code 可以直接通过 Bash 调用 `lark-cli`。

用户问日历时，期待 Claude 执行类似：

```bash
lark-cli calendar +agenda --as user --format json
```

用户问 @我消息时，期待 Claude 执行类似：

```bash
lark-cli im +messages-search --as user --is-at-me --start "2026-05-18T00:00:00+08:00" --format json
```

### 6.3 MVP1 Collector 由后端主动调用

MVP1 不完全依赖 Claude 自己想起来查。后端 collector 定时调用 `lark-cli`，把新增信号整理后喂给 Claude。

推荐 collector：

```ts
type Collector = {
  name: string;
  intervalMs: number;
  collect(since: Date): Promise<RawSignal[]>;
};
```

RawSignal：

```ts
type RawSignal = {
  id: string;
  source: 'calendar' | 'im' | 'mail' | 'drive';
  sourceId: string;
  kind: string;
  occurredAt: string;
  title?: string;
  text: string;
  actor?: string;
  url?: string;
  raw: unknown;
};
```

### 6.4 日历 Collector

命令：

```bash
lark-cli calendar +agenda \
  --as user \
  --start "<now - 2h ISO>" \
  --end "<now + 48h ISO>" \
  --format json
```

不要在 bash 里拼 `date(1)`，macOS 和 Linux 参数不一致。collector 应该在 Node 层生成 ISO 8601 字符串后传给 `lark-cli`：

```ts
const HOUR_MS = 60 * 60 * 1000;

export function getCalendarWindow(now = new Date()) {
  return {
    start: new Date(now.getTime() - 2 * HOUR_MS).toISOString(),
    end: new Date(now.getTime() + 48 * HOUR_MS).toISOString(),
  };
}

const { start, end } = getCalendarWindow();
```

处理逻辑：

- 使用 event id + start time 作为 sourceId。
- 对 raw event 做 hash。
- hash 变化表示更新。
- 新增或更新都写入 `events`。

MVP1 不强制识别取消事件，因为 agenda 轮询很难可靠发现删除。可以在后续通过快照 diff 补充。

### 6.5 @我消息 Collector

命令：

```bash
lark-cli im +messages-search \
  --as user \
  --is-at-me \
  --start "<last_scan ISO>" \
  --end "<now ISO>" \
  --page-all \
  --page-limit 3 \
  --format json
```

处理逻辑：

- 使用 message_id 作为 sourceId。
- 文本内容进入 RawSignal.text。
- chat name、sender 如有则保存。
- MVP1 只覆盖群聊里 @ 我消息。私聊消息暂不纳入默认扫描，见“已知限制”。

### 6.6 邮件 Collector（可选）

命令：

```bash
lark-cli mail +triage \
  --as user \
  --filter '{"folder":"INBOX"}' \
  --max 20 \
  --format json
```

字段名以 `lark-cli mail +triage --print-filter-schema` 为准。文件夹值用大写（如 `INBOX`），不要写成 `inbox`。"未读" 维度先不依赖 `--filter`，由后端比对 `collector_state.last_scan_at` 自行筛选。

MVP1 可先只做手动调试，不纳入默认扫描。

### 6.7 文档 Collector（可选）

命令：

```bash
lark-cli drive +search \
  --as user \
  --edited-since 1d \
  --sort edit_time \
  --format json
```

评论：

```bash
lark-cli drive +search \
  --as user \
  --commented-since 1d \
  --only-comment \
  --format json
```

MVP1 可先作为“手动查询工具”，不默认扫描。

---

## 7. SQLite 数据模型

MVP0 可只建 `messages`。MVP1 建完整表。

```sql
CREATE TABLE IF NOT EXISTS runtime_messages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  raw_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  actor TEXT,
  url TEXT,
  raw_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(source, source_id, content_hash)
);

CREATE TABLE IF NOT EXISTS triage_results (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  priority TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  suggested_action TEXT,
  draft_reply TEXT,
  confidence REAL,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  triage_id TEXT,
  priority TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  suggested_action TEXT,
  draft_reply TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(triage_id) REFERENCES triage_results(id)
);

CREATE TABLE IF NOT EXISTS user_rules (
  id TEXT PRIMARY KEY,
  rule_type TEXT NOT NULL,
  description TEXT NOT NULL,
  source_card_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collector_state (
  collector_name TEXT PRIMARY KEY,
  last_scan_at TEXT,
  last_success_at TEXT,
  last_error TEXT
);
```

`content_hash` 不要直接 hash 完整 raw JSON。很多字段会高频变化，容易制造无意义更新。

日历事件推荐只 hash 下面字段：

```ts
type CalendarContentHashInput = {
  title?: string;
  start?: string;
  end?: string;
  location?: string;
  description?: string;
  attendeesOpenIds: string;
};
```

其中 `attendeesOpenIds` 只包含 attendee 的 `open_id`，排序后用稳定分隔符拼接；不要 hash `rsvp_status`。

---

## 8. Triage 设计

### 8.1 TriageResult JSON

Claude 后台处理 `<signals>` 时必须输出：

```ts
type TriageResult = {
  items: Array<{
    sourceEventId: string;
    relevant: boolean;
    priority: 'P0' | 'P1' | 'P2' | 'P3';
    title: string;
    summary: string;
    reason: string;
    suggestedAction?: string;
    draftReply?: string;
    confidence: number;
    shouldCreateCard: boolean;
    cardActions: Array<{
      id: string;
      label: string;
      kind: 'ack' | 'snooze' | 'dismiss' | 'ask_agent' | 'draft_reply' | 'open_source';
      prompt?: string;
    }>;
  }>;
};
```

### 8.2 优先级定义

```text
P0：需要尽快处理。例：老板/关键合作方 @我、即将开始的关键会议、明显阻塞。
P1：今天应该处理。例：今天的评审/汇报/客户会议、需要回复但不紧急的问题。
P2：可以进入日报。例：普通日程变化、普通文档更新。
P3：只记录或忽略。例：低价值系统更新、重复提醒。
```

### 8.3 后台 Triage Prompt

建议放在 `apps/server/src/triage/triagePrompt.ts`。

```text
你正在为用户处理飞书信息流。下面是系统收集到的一组新增信号。

请判断每条信号：
1. 是否与用户相关；
2. 优先级 P0/P1/P2/P3；
3. 是否需要创建前端卡片；
4. 用户下一步最好做什么；
5. 如果是消息类信号，是否需要回复草稿。

重要规则：
- 宁可少打扰，不要乱打扰。
- P0 必须有明确理由。
- 涉及发送消息、发送邮件、修改日程、修改文档时，只能生成建议或草稿，不要执行。
- 如果信息不足，说明不确定。
- 输出必须是合法 JSON，不要 Markdown，不要解释 JSON 之外的内容。

用户规则：
<user_rules>
{user_rules_json}
</user_rules>

新增信号：
<signals>
{signals_json}
</signals>

输出格式：
{
  "items": [
    {
      "sourceEventId": "...",
      "relevant": true,
      "priority": "P1",
      "title": "...",
      "summary": "...",
      "reason": "...",
      "suggestedAction": "...",
      "draftReply": "...",
      "confidence": 0.8,
      "shouldCreateCard": true,
      "cardActions": [
        {"id":"ack","label":"知道了","kind":"ack"},
        {"id":"ask_agent","label":"帮我处理","kind":"ask_agent","prompt":"..."},
        {"id":"dismiss","label":"忽略这类","kind":"dismiss"}
      ]
    }
  ]
}
```

### 8.4 解析策略

Claude 可能输出非纯 JSON。解析时：

1. 优先整体 `JSON.parse`。
2. 失败则提取第一个 `{` 到最后一个 `}` 再 parse。
3. 仍失败则记录 `runtime_error`，不创建卡片。
4. 不要因为单次失败中断 collector。

---

## 9. 后端 API / WebSocket

### 9.1 HTTP API

```text
GET  /api/health
GET  /api/runtime/status
POST /api/runtime/restart

GET  /api/messages
POST /api/chat
POST /api/speech/transcribe

GET  /api/cards
POST /api/cards/:id/action

POST /api/collectors/run-once
GET  /api/debug/events
GET  /api/debug/triage-results
```

`POST /api/chat`：

```json
{
  "text": "查一下我今天的日程"
}
```

`POST /api/speech/transcribe`：

```text
Content-Type: multipart/form-data
字段：audio
```

响应：

```json
{
  "text": "帮我看今天有什么必须处理"
}
```

`POST /api/cards/:id/action`：

```json
{
  "actionId": "ask_agent"
}
```

### 9.1.1 CORS 与端口

前端默认跑在 `127.0.0.1:5173`，后端默认跑在 `127.0.0.1:8787`，跨 origin。任选其一：

**方案 A：后端开 CORS**

```ts
import cors from 'cors';
app.use(cors({ origin: process.env.WEB_ORIGIN || 'http://127.0.0.1:5173', credentials: true }));
```

WebSocket 升级路径需要单独允许同一个 origin。

**方案 B：Vite proxy**

`apps/web/vite.config.ts`：

```ts
export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws':  { target: 'ws://127.0.0.1:8787',  ws: true },
    },
  },
});
```

MVP0 推荐方案 B（开发期最省事），方案 A 留给后续打包/部署再切。

### 9.2 WebSocket Events

Server -> Client：

```ts
type ServerEvent =
  | { type: 'runtime_status'; status: RuntimeStatus }
  | { type: 'message_added'; message: ChatMessage }
  | { type: 'card_created'; card: SignalCard }
  | { type: 'card_updated'; card: SignalCard }
  | { type: 'collector_status'; collector: string; status: string; nextRunAt?: string }
  | { type: 'error'; message: string };
```

Client -> Server：

MVP0 可以不用 WebSocket client messages，直接 HTTP POST。

---

## 10. 开发任务拆分

### 10.1 MVP0 任务清单

后端：

- [ ] 创建 `apps/server` TypeScript 工程。
- [ ] 实现 Express 服务。
- [ ] 实现 WebSocket 广播。
- [ ] 实现 `ClaudeRuntime` 子进程管理。
- [ ] 实现 stream-json 行解析。
- [ ] 实现 `POST /api/chat`。
- [ ] 实现 `POST /api/speech/transcribe`。
- [ ] 实现 ffmpeg 音频转 PCM。
- [ ] 实现飞书 ASR `file_recognize` 裸调。
- [ ] 实现 `GET /api/runtime/status`。
- [ ] 保存 runtime messages 到 SQLite 或内存，MVP0 可先内存。
- [ ] 配置 Claude 启动命令。
- [ ] 验证 Claude 可以调用 `lark-cli calendar +agenda`。

前端：

- [ ] 创建 `apps/web` Vite React 工程。
- [ ] 实现单页布局。
- [ ] 实现状态栏。
- [ ] 实现消息流。
- [ ] 实现输入框。
- [ ] 实现 MediaRecorder 录音。
- [ ] 录音完成后上传 `/api/speech/transcribe`。
- [ ] 识别结果填入输入框。
- [ ] 实现发送消息。
- [ ] 实现 WebSocket 接收后端消息。
- [ ] 实现基本 loading/tool 状态展示。

验收：

- [ ] 浏览器打开页面。
- [ ] 文字输入可用。
- [ ] 语音输入可用：录音 → 飞书 ASR → 文本填入输入框。
- [ ] Claude Runtime 自动启动。
- [ ] 问“今天有什么日程”可得到结果。

### 10.2 MVP1 任务清单

后端：

- [ ] SQLite 落库。
- [ ] 实现 `events`、`cards`、`triage_results`、`collector_state`。
- [ ] 实现 calendar collector。
- [ ] 实现 im @me collector。
- [ ] 实现 collector scheduler。
- [ ] 实现 signal 去重。
- [ ] 实现 triage prompt 构造。
- [ ] 实现 `BackgroundClaudeRuntime`：每轮 triage 一次性 spawn 子进程，不与前台 `ClaudeRuntime` 共享（见 §5.6）。
- [ ] 实现 `TriageQueue`：concurrency = 1 串行消费 collector 入队的 signals，避免并发 spawn 多个后台 Claude 进程。
- [ ] 实现 triage JSON 解析。
- [ ] 实现 card 创建和广播。
- [ ] 实现 `GET /api/cards`。
- [ ] 实现 `POST /api/cards/:id/action`。
- [ ] 实现卡片动作：
  - `ack`
  - `snooze`
  - `dismiss`
  - `ask_agent`
  - `draft_reply`

前端：

- [ ] 增加卡片流区域。
- [ ] 实现 `SignalCard`。
- [ ] 实现优先级视觉样式。
- [ ] 实现卡片按钮。
- [ ] 实现空状态。
- [ ] 实现 collector 状态显示。
- [ ] 实现卡片和对话联动：点“帮我处理”后，对话流出现用户意图和 Claude 响应。

验收：

- [ ] 后台定时扫描日历和 @我消息。
- [ ] 新信号写入 SQLite。
- [ ] Claude 生成 triage。
- [ ] 前端出现卡片。
- [ ] 卡片按钮可用。

---

## 11. 启动命令建议

根目录 `package.json`：

```json
{
  "scripts": {
    "dev": "concurrently \"npm:dev:server\" \"npm:dev:web\"",
    "dev:server": "npm --prefix apps/server run dev",
    "dev:web": "npm --prefix apps/web run dev"
  },
  "devDependencies": {
    "concurrently": "^9.0.0"
  }
}
```

Server：

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts"
  }
}
```

Web：

```json
{
  "scripts": {
    "dev": "vite --host 127.0.0.1 --port 5173"
  }
}
```

---

## 12. 配置项

使用 `.env`：

```bash
PORT=8787
WEB_ORIGIN=http://127.0.0.1:5173

# 相对仓库根目录；config.ts 里用 path.resolve(REPO_ROOT, SQLITE_PATH) 解析成绝对路径
SQLITE_PATH=data/ai-is-on.sqlite

CLAUDE_CODE_CLI=/Users/xinming/MyProject/claude-code-research/package/cli.js
CLAUDE_TOOLS=Bash,WebSearch,WebFetch
CLAUDE_ALLOWED_TOOLS=Bash(lark-cli:*)
# 默认走 ANTHROPIC_API_KEY + --bare（见 §12.1）。改 OAuth 时设为 false。
CLAUDE_USE_BARE=true

COLLECTOR_ENABLED=true
CALENDAR_COLLECTOR_INTERVAL_MS=300000
IM_COLLECTOR_INTERVAL_MS=120000
# Triage 串行队列并发数，1 即可（每轮 spawn 一次性 Claude 进程）
TRIAGE_QUEUE_CONCURRENCY=1

SPEECH_ASR_PROVIDER=feishu
SPEECH_MAX_SECONDS=60
FFMPEG_BIN=ffmpeg
```

注意：

- 不要把 token 写入 `.env`。
- `lark-cli` 使用本机已有配置和 OAuth。
- Claude 认证优先使用 `ANTHROPIC_API_KEY`（配合 `CLAUDE_USE_BARE=true`）。
- 不再有 `CLAUDE_PERMISSION_MODE`：启动一律 `--dangerously-skip-permissions`，靠工具白名单 + system prompt 软约束（见 §5.1、§13.1）。
- `SQLITE_PATH` 写相对路径，在 `apps/server/src/config.ts` 用 `path.resolve(__dirname, '../../..', process.env.SQLITE_PATH)` 解析，避免不同 cwd 启动时路径漂移。

### 12.1 Claude 认证选择

推荐路径：

```text
ANTHROPIC_API_KEY → 保持 `--bare`
```

这是最稳的 daemon 子进程模式。`--bare` 会跳过 hooks、LSP、plugin sync、auto-memory 和 `CLAUDE.md` 自动发现，避免后台进程启动慢或把 demo 过程写进本机 Claude memory。

如果必须使用 Claude.ai OAuth：

```text
Claude.ai OAuth → 去掉 `--bare`
```

OAuth 路径下需要接受 hooks、auto-memory、plugin sync 和 `CLAUDE.md` 自动发现等副作用。特别是 auto-memory 可能写入 `~/.claude/projects/.../memory`，不建议作为 MVP1 默认路径。

---

## 13. 开发注意事项

### 13.1 安全边界

MVP0/MVP1 只允许自动读，不允许自动写。

启动用了 `--dangerously-skip-permissions`，所以这条边界**没有**permission 弹窗兜底，完全靠三层软约束保证：

1. `--tools Bash,WebSearch,WebFetch`：不打开 Edit/Write/Agent/NotebookEdit 等会改本地或代调用子 Agent 的工具。
2. `--allowedTools "Bash(lark-cli:*)"`：Bash 只放行 `lark-cli` 前缀命令，不让 Claude 跑任意 shell。
3. System prompt 明文禁止写飞书（见 §5.2，最后两条工具边界）。

允许：

- 查询日历。
- 查询 @我消息。
- 查询未读邮件。
- 查询最近文档。
- 生成回复草稿。
- 生成处理建议。

不允许未经确认：

- 发送飞书消息。
- 发送邮件。
- 修改日历。
- 修改文档。
- 删除任何东西。
- 批量标记已读。

如果以后要做"用户点确认 → Claude 发消息"这种链路，**不要**放开 lark-cli 写命令的 allowedTools，而是由后端代收 `draftReply`、用户确认后由后端直接调用 `lark-cli im +messages-send` 完成，Claude 进程依然只读。

### 13.2 lark-cli 错误处理

常见错误：

- 未登录 user。
- 缺少 scope。
- bot/user 身份不对。
- API 限流。
- 网络错误。

后端应该：

- 捕获 stderr。
- 把错误写入 collector_state。
- 前端状态栏显示“数据源需要授权”。
- 不让 collector 崩掉整个进程。

### 13.3 飞书 ASR 错误处理

常见错误：

- 应用没有开通 `speech_to_text:speech` 权限。
- 当前租户是免费版，不支持调用。
- 音频不是 PCM。
- 音频超过 60 秒。
- `file_id` 长度不足 16 或包含非法字符（推荐 32 字符随机 hex）。
- `--data` 内联 base64 PCM 超过 `ARG_MAX` 直接 `E2BIG`（必须走 `--data @file`，见 §4.5）。
- 没安装 `ffmpeg`。

后端应该：

- 转码前检查音频大小和时长，MVP0 至少限制录音时长。
- ffmpeg 不存在时，在前端显示“本机缺少 ffmpeg，暂不能语音输入”。
- 飞书 API 返回非 0 code 时，把 msg 透出为用户可理解错误。
- 不要因为 ASR 失败影响文字输入和 Claude Runtime。

### 13.4 Claude Runtime 错误处理

需要处理：

- 子进程启动失败。
- 子进程退出。
- stdout 非 JSON。
- 单次请求超时（前台 30s、后台 triage 60s 是合理起点）。
- 后台 triage 一次性子进程异常退出：记错，丢弃这一轮 signals，下一轮重 spawn。

MVP0 可提供一个“重启 Claude”按钮。

### 13.5 先跑通，不要过早抽象

MVP0/MVP1 优先级：

1. 链路跑通。
2. 用户体验可感知。
3. 日志可调试。
4. 再考虑抽象漂亮。

### 13.6 已知限制

MVP1 只覆盖群聊 @ 我消息：

```bash
lark-cli im +messages-search --as user --is-at-me
```

私聊消息暂不覆盖。`lark-cli im +messages-search` 没有稳定的 unread 维度，直接扫 `--chat-type p2p` 又需要额外过滤条件，否则范围过大。

MVP2 再补私聊增量方案：

1. 使用 `lark-cli im +chat-list` 获取活跃会话。
2. 对每个会话调用 `lark-cli im +chat-messages-list`。
3. 基于本地 `collector_state` 做增量拉取和去重。

---

## 14. 推荐开发顺序

### Day 1：MVP0 后端

1. 搭 `apps/server`。
2. 实现 ClaudeRuntime spawn。
3. 打通 `POST /api/chat`。
4. 命令行或 curl 验证可以收到 Claude 输出。

### Day 2：MVP0 前端

1. 搭 `apps/web`。
2. 做单页 UI。
3. 打通文字输入。
4. 加语音输入。
5. 展示 runtime 状态。

### Day 3：MVP0 验收和修补

1. 确保 lark-cli 查询日历可用。
2. 修复 Claude output parsing。
3. 增加工具调用状态展示。
4. 写 README 启动说明。

### Day 4：MVP1 存储和 Collector

1. 加 SQLite。
2. 实现 calendar collector。
3. 实现 im collector。
4. 实现去重。
5. 做 `/api/debug/events`。

### Day 5：MVP1 Triage 和卡片

1. 实现 triage prompt。
2. 实现 `BackgroundClaudeRuntime` + `TriageQueue`（concurrency=1），把 signals 入队给一次性 Claude 子进程（不复用前台 ClaudeRuntime，见 §5.6）。
3. 解析 TriageResult。
4. 创建 cards。
5. 前端展示 cards。

### Day 6：卡片动作和体验打磨

1. 实现卡片按钮。
2. `ask_agent` 联动对话。
3. `dismiss` 记录 user_rules。
4. 空状态和错误态。

---

## 15. 最小可交付标准

MVP0 完成时，应能录制一个 30 秒 demo：

```text
打开页面 → 语音输入“今天有什么日程” → Claude 调 lark-cli → 页面显示答案
```

MVP1 完成时，应能录制一个 60 秒 demo：

```text
打开页面 → 后台扫描 → 出现一张日历或 @我消息卡片 → 点“帮我处理” → Claude 生成建议或草稿
```

只要这两个 demo 能成立，就可以开始判断产品模式是否 work。
