# MVP77：把结果送到你面前——飞书 bot DM 推送闭环

## 为什么（2026-07-03 实测取证）

用户第 4 次回到同一痛点（/goal）：「AI 帮我办的事不够明确、有问题的地方没参与感、**没感觉到 AI 帮我做了任何事**；目标是能自动做的都自动做，需要我时来找我。」

证据链（真实库取数）：

- **AI 其实一直在做事**：近 9 天办结的 15 件事项里 13 件是 AI 自主办结（观察消费 + 排查高置信办结），只有 2 件用户手动点的。
- **但用户完全不知道**：attention_interactions 最后一条是 06-26 —— 用户 7 天没打开 web UI。近 7 天产出（8 建议 + 4 修复方案 + 1 自动办结）全部无人看见。
- **需要用户的求助也到达不了**：needhelp 卡历史仅 3 张、2 张静默过期；dangling 近 7 天过期 20 张。根因：这两类卡**没有显式 TTL，24h 兜底扫直接蒸发**。
- 结论：「感觉不到 AI 做了事」的第一根因是**投递通道（纯 pull，等用户开网页）**，不是产出能力。

## 通道选型

- bot 以**自己身份**给用户本人发 DM（appId cli_aa8b19e7057a1bb7 的 bot 身份，2026-07-03 实测发送成功）。
- 这**不是**被公司策略永久禁止的「以用户身份代发给他人」（larkImReplyService 那种）：不冒充、只送达本人，是标准通知 bot 模式。
- 命令：`lark-cli im +messages-send --as bot --user-id <ou_self> --markdown ... --idempotency-key ...`。

## 做了什么

1. **`lark/larkNotifyService.ts`（新）**
   - `sendBotDm`：幂等（audit notify_pushed 的 idempotencyKey 第一层 + lark-cli 服务端第二层）、日配额（`notifyInstantDailyMax` 默认 6，日报豁免）、永不 throw（通道故障绝不破坏业务路径，落 notify_failed）。
   - **armed 模式**：只有服务进程启动时 `armNotifyService()` 后才真发。测试/脚本 import 升卡函数天然 no-op——现有 838 个测试零改动且物理上不可能误发。
2. **即时推送钩子**（`matterResolveProposal.ts` 升卡内核 + 自动办结回执）：
   - 推：needhelp🙋 / artifact🔧 / reco💡 / autoresolved✅ / resolve✋（结果或需要你）。
   - 不推：progress / dangling（MVP75 第一性原理：过程不占用户一个像素；dangling 进日报兜底）。
   - 每 (kind, matter, 天) 至多一条。
3. **每日工作汇报**（18:00 后，`startDailyWorkReportJob` 每分钟检查）：
   - 三段式：✅ 已替你办结哪几件（含依据，排除「用户标记」）/ 🔧💡 产出方案与建议 / 🙋 现在需要你的（live 口径 + 具体要什么）。
   - 空日不发；settings + audit 双幂等（崩溃恢复补标）；失败 10 分钟退避重试。
4. **求助不蒸发**：needhelp 7 天 / dangling 3 天显式 TTL，并加入 24h 兜底扫豁免名单（与 artifact/reco 同待遇）。

## 验证

- 单测 `mvp77-notify.test.ts` 6/6：armed 安全、kind 过滤、幂等+配额、通道故障不破坏升卡、TTL 存活/到期、日报组稿+幂等。
- 全量 838/838 通过；tsc 零错误。
- **真实端到端**：今日首份工作汇报已真实送达用户飞书（messageId om_x100b6b4207743c60b36bcac42046c96），内容含真实数据（办结「日程工具返回值冗长」+ 决策信息包 + 3 件欠的承诺）；重跑 `already_sent` 幂等；audit/settings 留底核实。

## 后续方向

- 回复闭环：用户直接在 bot 会话里回一句（如贴 traceID）→ imCollector 采集 → KEYSTONE 回填重查（当前需点链接回面板补）。
- 「自己搞定」放量：open matter 已积压 234 件，需要 backlog 清理 + 自动办结安全放权下一档。
- 推送效果度量：notify_pushed → 用户当天 interaction 的转化率。
