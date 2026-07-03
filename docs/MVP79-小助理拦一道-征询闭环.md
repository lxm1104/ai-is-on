# MVP79：小助理拦一道——有人 IM 请你办事，AI 收集信息来征询你，按你意见办

用户原话（2026-07-03）："他看到我在 IM 里面有人问我的时候，可以主动站出来问问我可以怎么处理，然后他直接帮我处理……先帮我拦一道，帮我收集一些必要的信息，然后根据我之前的一些行为和操作的习惯，帮助我来处理，如果有不太了解的，应该问我，或者确认一下。"

## 同轮修复的前置 bug（用户报障「飞书我回了没反应」）

取证结论：**清理其实执行成功了**（回复后 60 秒内 7 件全部办结，audit 齐全）——断的是回执：
- 根因：`--idempotency-key` 超过飞书 **50 字符硬限**（reply_ack 键 51 字符）→ 整条消息被拒（99992402 field validation failed）→ 失败只写 console → 用户以为没反应。
- 连带雷：即时推送键 62 字符（kind+36 位 matterId+日期），下一张求助卡推送会同样静默失败。
- 修复（commit 9d59f4a）：`makeIdempotencyKey` 超长 sha1 确定性截短 + sendBotDm 入口防御归一 + **回执绝不无声失败**（notify_failed 留底 + 降级普通 DM 兜底）+ 命令处理补审计。

## 用户 skill → 排查能力（「AI 看到 context 用我的技能分析」）

用户反复用「trace 分析」流程分析 Chatbot badcase 群的信息。正确载体是**项目排查档案**（context_spaces.investigation_profile，MVP50 路由注入排查 prompt 全文无截断），不是 task_playbooks（其 key 是 `type:动作` 全局粒度，会污染所有同类事项）。

已把 `analyze-agent-execution` 的五层分析框架（执行环境/意图理解/工具调用/结果合成/端到端）+ `fornax-daily-trace-analysis` 的 bad patterns（prompt 超长/use_skill 占位 hop/同参死循环/幻觉成功/TTFB>10s/历史未压缩）+ redacted 处理纪律，蒸馏进 Chatbot 项目档案（space 2edac6ea，1542→2455 字符，audit project_profile_set）。从此每次 Chatbot badcase 自主排查都按用户的成熟方法走：拿 trace（既有日志ID→traceID 配方）→ 五层定位 → 结论必须落到 层级+证据+改法。

## 征询闭环（consultService.ts，commit e67f7de）

- **触发**（matterReducer 单一创建汇聚点挂钩，永不 throw）：新建 matter 命中「具名他人是 requester + 我是 executor」= 有人当面请我办事（needHelpClassifier owned_by_other 的镜像判定）。
- **三闸降噪**：角色门（1~2 个具名 requester，≥3 视为群发不打扰）/ 终身一次每 matter（幂等键不带日期）/ 日配额 consultDailyMax=3。
- **收集信息**：getMatterOriginHint（来源会话+原话）+ currentSummary → 🤝 征询 DM 带编号选项。
- **四种答复**（botReplyLoop 三通道路由：裸 1/2/3 → 最近未答复征询；引用征询消息；自由文本兜底）：
  - `1 起草回复`：aiisn-push 全 deny 沙箱起草话术 → 📝 草稿 DM（**你确认后自己发，绝不代发**——公司红线由沙箱物理保证）
  - `2 先查清楚`：指示落 card_action 证据 + kickInvestigation（KEYSTONE 近实时重查）
  - `3 不用管`：userDropMatter，7 天内「恢复 <关键词>」找回
  - 自由文本：作为你的处理指示回填，AI 照办
- **习惯学习原料**：每次选择落 `consult_choice` 审计（谁请办的什么事 → 你怎么处理）。下一步按历史选择给选项排序/预选。

## 验证

- 单测 6/6（mvp79-consult.test.ts）+ bug 修复 3 个（并入 mvp78 测试）；全量 857/857；tsc 干净。
- 迟到的清理回执已手动补发到用户飞书；修复后回执链路（含降级兜底）有测试覆盖。
- 征询的真实触发依赖 reducer 从 IM 提取的 requester/executor 角色质量——观察真实命中率是下一步的事。

## 已知边界 / 下一步

- 习惯学习 v1 只记录不排序；攒够 consult_choice 后按（请求人/事项类型→历史选择）排序或预选。
- 征询触发窄门可能偏保守（角色提取漏的场景不触发）——宁静勿噪，观察一周真实数据再调。
- 回复草稿是「给你复制」不是「替你发」——IM 代发是公司红线，永不放开。
