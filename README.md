# AI is ON · MVP0 + MVP1

本地研究 demo：极简 Web UI + 后端 spawn Claude Code runtime + lark-cli 只读飞书。
后台定时拉取飞书日历 / @我消息 → 一次性 Claude 子进程做 triage → 前端实时卡片流。

## 前置依赖

- Node ≥ 20（已用 `v25.2.1` 验证）
- `ffmpeg`（语音输入需要）
- `lark-cli`，并已 `lark-cli auth login --domain calendar` 和 `--domain im` 登录 user 身份
- 飞书应用已开通 `speech_to_text:speech` scope（语音输入需要）
- 本机 Claude.ai 已登录 OAuth（不需要 `ANTHROPIC_API_KEY`）
- Claude Code CLI: `/Users/xinming/MyProject/claude-code-research/package/cli.js`

## 启动

```bash
# 第一次：安装所有依赖
npm run install:all

# 拷贝环境变量
cp apps/server/.env.example apps/server/.env

# 同时起前后端
npm run dev
```

- 后端: http://127.0.0.1:8787
- 前端: http://127.0.0.1:5173

## MVP0 验收：手动问 Claude

输入：

> 查一下我今天的日程，并判断有什么需要我提前准备

应该看到：
1. 你的消息出现；
2. 「Bash · 正在调用」工具气泡（`lark-cli calendar +agenda ...`）；
3. 工具完成后 AI 给出日程摘要 + 准备建议；
4. 全程页面不刷新。

语音：点麦克风 → 说话 → 再点停止 → 飞书 ASR 识别后填进输入框 → 按 Enter 发送。

## MVP1 验收：后台自动卡片

服务启动后约 5 秒首次扫描，后续按 `IM_COLLECTOR_INTERVAL_MS`（默认 2 分钟）/ `CALENDAR_COLLECTOR_INTERVAL_MS`（默认 5 分钟）轮询。

左侧卡片流应该出现：
- 日历事件 → 带优先级 P0/P1/P2/P3 + "为什么"+"建议"；
- @我消息 → 带回复草稿（如果是问题）；
- 卡片按钮：知道了 / 帮我处理 / 生成回复草稿 / 稍后 / 忽略这类；
- 点「帮我处理」会把 prompt 发到右侧对话流，Claude 接力执行。

想立即触发一次：点卡片区右上角「立即扫描」，或

```bash
curl -X POST http://127.0.0.1:8787/api/collectors/run-once
```

## 关键 API

```
GET  /api/health
GET  /api/runtime/status         POST /api/runtime/restart
GET  /api/messages               POST /api/chat
POST /api/speech/transcribe      （multipart: audio）
GET  /api/cards                  POST /api/cards/:id/action { actionId }
GET  /api/collectors             POST /api/collectors/run-once { name? }
GET  /api/debug/events           GET  /api/debug/triage-results
```

WebSocket `/ws`：`runtime_status` / `message_added` / `message_updated` / `card_created` / `card_updated` / `collector_status` / `error`。

## 目录

```
apps/server                 # Node + Express + ws + better-sqlite3
  src/claude/               # 前台 ClaudeRuntime（长驻 stream-json 子进程）
  src/triage/               # BackgroundClaudeRuntime + TriageQueue（一次性 -p json）
  src/collectors/           # calendar / im collectors + scheduler
  src/cards/                # card 表 + action 派发
  src/speech/               # ffmpeg + 飞书 ASR
  src/routes/               # chat / runtime / speech / cards / collectors / debug
apps/web                    # Vite + React 前端
  src/components/           # StatusBar / CardList / SignalCard / MessageList / Composer
data/                       # SQLite 文件
docs/                       # 设计文档
```

## 安全边界（§13.1）

- `--dangerously-skip-permissions`（无 permission 弹窗），靠三层软约束：
  - `--tools Bash,WebSearch,WebFetch`
  - `--allowedTools "Bash(lark-cli:*)"`（Bash 只能跑 lark-cli 子命令）
  - System prompt 明文禁止写飞书
- triage 子进程更克制：只开 `--tools Bash`，不开 WebSearch/WebFetch
- 不允许 Claude 发飞书消息、发邮件、修改日程、修改文档、删除任何东西

## IM Collector 策略

逐 chat 增量拉取（§13.6 MVP2 路线）：

- 群消息：`lark-cli im +chat-list --as user --exclude-muted --sort-type ByActiveTimeDesc`（最多 5 页 × 100）→ 并发 `chat-messages-list --chat-id --start <last_scan>` 拉每个群的增量
- 单聊：`lark-cli im +messages-search --as user --chat-type p2p --start <last_scan>`（messages-search 没有 unread 维度，靠 last_scan 增量过滤）
- 过滤：剔除我自己发的消息（`sender.id == myOpenId`）、`msg_type=system`、`deleted=true`
- 聚合：单 chat 一轮内新消息 ≥`IM_AGGREGATE_THRESHOLD`（默认 3）→ 合并为 1 条「群 X · 新增 N 条」信号；否则按条入库
- 信号优先级标签：`at_me`、`group_burst_at_me`、`p2p` / `p2p_burst`、`group_burst`、`group_message`
- 硬上限：单轮信号超过 `IM_MAX_SIGNALS_PER_SCAN`（默认 30）按优先级裁剪并打日志
- 我的 `open_id` 由 `lark-cli auth status` 启动时拿一次缓存（[util/identity.ts](apps/server/src/util/identity.ts)）

可调参数全在 [.env.example](apps/server/.env.example) 的 `IM_*` 段。

## 已知限制

- 邮件、文档 collector 没默认启用，文档 §6.6/§6.7 提了如何加
- triage 一次性子进程冷启动 ~1-2s + Claude OAuth 路径下没有 `--bare`，单批耗时 30-90s 属正常；批 size 由 `TRIAGE_BATCH_SIZE` 控
- 飞书 ASR `file_id` 必须**正好 16 个字符**（文档 §4.5 写"≥16 推荐 32"是错的，实测 32 字符会 `1040101 invalid param`）
