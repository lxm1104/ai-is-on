# MVP78：回复闭环 + 积压大扫除——飞书回一句就推进

承接 MVP77（推送闭环）。用户目标不变：「能自动做的都自动做，需要我时来找我」。MVP77 解决了**出**（结果/求助到达飞书），本 MVP 解决**回**（你回一句就推进）与**积压**（234 件 open 事项的批量清理）。

## ① 回复闭环（`lark/botReplyLoop.ts`）

之前：收到「🙋需要你补一手」后必须点链接回 web 面板。现在直接在 bot 会话回复：

- **引用回复**某条推送 → 按被引消息 messageId（audit notify_pushed 留底）精确路由到事项 → 走 MVP69/71 KEYSTONE 回填（origin=card_action 证据、收起求助卡、kickInvestigation 近实时重查）→ 线程 ack「已补进 X，AI 接着查」。
- **命令**：`确认清理` / `保留 2 5` / `忽略` / `恢复 <标题关键词>`（大扫除批次操作）。
- **普通回复**：恰好一张在场求助卡 → 按它路由（ack 披露挂到哪）；否则最近 24h 即时推送兜底；再不行诚实引导（请引用具体推送），绝不乱猜。

稳健性（实测约束驱动）：
- lark-cli 返回的 create_time 只有**分钟精度** → 水位回看 3 分钟重叠扫 + 已处理 message_id 环（200）去重。
- 该会话里有**并行 Claude 会话**发的消息 → 只认 audit 有留底的推送，其余走引导。
- 每条消息处理失败也进环（毒消息绝不卡死循环）；bot/app 消息一律跳过；ack 幂等键。
- chat_id 由 sendBotDm 成功响应自动落 settings（`notify:botChatId`）——通道自举。

## ② 积压大扫除（`matter/backlogSweeper.ts`）

取证（2026-07-03）：open 事项 234 件，47 件 ≥14 天零新证据。抽样发现大量「标题即完成态」（"日志已上传/审批已通过/直播定档6月23日"已过 10 天）——**盲目 auto-drop 是错误工具**（它们不是不再跟进，是已完成/已过期）；逐件升卡确认又是 47 张卡轰炸。

设计：**AI 做 100% 甄别，你只回一句话。**

- 每天一轮（17:00 后）：停滞 ≥14 天且无在场提案的事项（≤40 件）→ 一次 LLM 批量甄别（新 agent `aiisn-backlog-sweep`，全 deny 沙箱、纯文本进 JSON 出）。
- 判定四档：likely_done（标题/摘要已表明有结果）/ event_passed（围绕的时间点已过）/ obsolete（不再相关）/ **still_pending（拿不准一律归此，不进清单）**。铁律：宁可漏清、绝不错清；because 必须引用原文。
- 可清项 → 存 pending 批次（settings，3 天 TTL）→ 飞书清单 DM（编号+依据）。
- **绝不自动清**：你回「确认清理」→ likely_done/event_passed 走 userResolveMatter、obsolete 走 userDropMatter；「保留 2 5」挑着留；「忽略」放弃；误清 7 天内「恢复 <关键词>」找回（audit `backlog_swept` 全程可审）。

## 验证

- 单测 10/10（`mvp78-reply-sweep.test.ts`）：引用路由回填/收卡/ack、兜底与引导、tick 水位与去重、甄别宽容解析与保守降级、批次应用映射/TTL/恢复、chat_id 持久化。全量 848/848、tsc 干净。
- **真实端到端**：真实库跑 `runBacklogSweep` → 扫 40 件 → LLM 甄别出 7 件可清（如「标题写明'审批已通过'」「直播'6月23日'已过」）→ 清单已送达用户飞书（batchId 112a305c）；live dev server 的回复闭环水位已推进（`notify:botReplyWatermark` 出现）——用户回「确认清理」60 秒内即被处理。

## 后续方向

- 回复闭环扩展：普通回复带标题关键词的模糊路由；求助卡 ack 后把 AI 重查结论回推同一线程。
- 大扫除第二档：event_passed 且日期可确定性解析的，攒信任后放权自动办结（带回执+恢复）。
- 推送→回复→重查→结果回推的全链路转化率度量。
