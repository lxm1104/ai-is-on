# MVP81 —— 飞书消息带「直达」深链：一点跳到需要你处理的地方

## 用户原话（2026-07-04）

> 飞书里面发给我处理，需要我处理的结果，应该尽可能的为我提供便利，如果能用链接定位到需要我处理的地方，就直接把链接发给我。

## 取证：链接早就有，只是没发出去

- 各 Collector 采集时就落了源头深链到 `events.url`：IM 消息是 `applink.feishu.cn/client/chat/open?openChatId=…`（thread 是 `client/thread/open?…`），日历/飞书任务/会议纪要/文档是各自的 `app_link/url`。
- 但 MVP77~79 的所有出站飞书消息里，唯一的"链接"是裸的 `config.webOrigin`（默认 localhost 面板首页）；`getMatterOriginHint`（db.ts）在有 chatId 时故意只产 AI 排查用的文字指令（`原对话 chatId=…`），把 `events.url` 吞掉了——那是给排查器看的，不是给用户手指点的。

## 改动

新增 `getMatterOriginUrl(matterId)`（db.ts）：matter → created_from_context_unit → 源头 event → `events.url`。只放行 `http(s)` 且不含 `)`/空白的干净 URL（脏值会把 markdown 链接语法搞坏，宁缺毋滥）。

五类"需要你处理"的消息统一带上可点深链（无 url 时该行不出现，不硬塞空链接）：

| 消息 | 位置 | 链接文案 |
|---|---|---|
| 即时推送（needhelp/artifact/reco/autoresolved/resolve） | larkNotifyService.ts `notifyProposalRaised` | `📍 [直达原始位置](url)` |
| 每日工作汇报「🙋 需要你」段 | larkNotifyService.ts `composeDailyWorkReport` | 逐条 `[直达](url)`（`listProposalItemsByPrefixes` 增返 `matterId`） |
| 🤝 征询 | consultService.ts `maybeConsultOnMatterCreated` | `📍 [直达原会话](url)` |
| 📝 回复草稿 | consultService.ts `draftReplyForMatter` | `📍 [直达原会话去发送](url)`——复制完草稿一点就到该发的地方 |
| 🧹 大扫除清单 | backlogSweeper.ts `composeSweepListMessage` | 逐条 `[直达](url)`——确认清不清之前先一点核实现状 |

## 边界（明确不做）

- web 面板深链到具体卡片不可行：apps/web 是无路由 SPA（tab 状态在 localStorage），`${webOrigin}?cardId=…` 前端不解析。要做需先给前端加路由，另立事项。
- `getMatterOriginHint` 不动：它是 AI 排查用的文字指令（chatId 优先），与本次面向用户的 `getMatterOriginUrl` 各司其职。

## 测试

- mvp77：有 `events.url` → 推送带 `📍 [直达原始位置]`、日报逐条带 `[直达]`；无 url 不出现链接行；脏 url（非 http、含 `)`）一律不产出。
- mvp79：征询与回复草稿都带直达链接。
- mvp78：清单有 url 条目带 `[直达]`、无 url 条目不带。
