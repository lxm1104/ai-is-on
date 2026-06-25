# MVP75 — 把 AI 产出从「过程/事实」升级成「直接的结果」

> 用户第 3 次回到同一痛点。成败标准：**结果（直接建议/意见/帮你做）的量和比例显著提高，且不是把「查到 X」换壳。** 脑暴4视角 + 3轮对抗审查 + 实现者复核；全程复用 conclude→writeback→提案卡→tally→面板 链路。

## 1. 基线与两个根因（真库证据）
- 「AI替你做了什么」近7天 ≈ **97%过程**(investigation 110) / **仅3%结果**(artifact 3 + auto_resolved 1)。投查 progressed 58/unknown 29/blocked 21/resolved 2，多是"查到X事实"非"建议你Y"。真实结论实样全是事实陈述、无建议。
- **根因①**：conclude schema **没有"建议/意见"层**，只有 factSummary(事实)+evidence+罕见 artifact(code_fix 硬门 file:line)。
- **根因②**：会话里 AI 给的建议/草稿被显式判成 `no_change` **静默丢弃**（chatConclusionPrompt.ts:20「no_change：结论只是分析、建议、草稿…最常见」；chatConclusionService.ts:177-184 no_change→skip）。

**杠杆点**：conclude 长出一个**低门槛、几乎每次能填**的 `recommendation`（不像 artifact 要 file:line）+ **后端硬门防换壳**；并救回被丢弃的会话建议。

## 2. P0 路线（纯复用、不过 gate、不拓宽触发面）

### P0-1 conclude 增 `recommendation` 结果层 — investigationPrompt.ts
```ts
export type RecoStance = 'do'|'wait'|'escalate'|'drop'|'decide';
export type Recommendation = { stance: RecoStance; advice: string; because: string; nextStep?: string };
// InvestigationConclusion 加 recommendation?: Recommendation
```
- **prompt 纪律**：conclude 除 factSummary 外**尽量**给 recommendation：基于事实给"我建议你做什么/我倾向A因为B"。**不得复述事实**（"根因已明确"是事实，必须紧跟"所以我建议你…"）；because **必须引 evidence**；nextStep 只能**只读/起草**（"我已起草催办话术待你发"），**绝不"我已发/已改/已办"**。说不出有信息含量的建议就**留空**，不硬凑"建议继续跟进"。blocked/unknown **不强制**给建议（诚实出口是 needhelp；仅 stance∈{escalate,drop} 且引证据才给）。
- **parseRecommendation**（仿 parseArtifact）：非法即 undefined，向后兼容。
- **防换壳硬门 `gradeRecommendation(rec, factSummary, evidence)`**（决定成败）：① 否决完成态/代执行动词（已发/已改/已办…）；② **增量信息门**：advice 去前缀后须含 factSummary+evidence 之外新 token ≥ RECO_MIN_NEW_TOKENS；③ because 须与某条 evidence 实质重合（引证据）；④ stance=do/escalate 须含动作动词（词法只作必要否决，非充分），drop/wait 减法建议放行。**纪律**：代码门不承诺判出"有信息含量"，只挡事实复述/泛跟进/完成态谎报；真换壳率靠**人工抽检**。达不到就留空降级回纯事实，绝不套💡壳冒充。

### P1-4 「💡 我的建议」卡 — investigationWriteback.ts + matterResolveProposal.ts
- 决策树插一档（needhelp **之后**、progress **之前**，不抢求助）：互斥序 **resolve > artifact > needhelp > 💡建议 > progress > dangling**。条件 `gradeRecommendation 通过 && evidence≥1 && config.investigationRecoCardEnabled`；不达标回落普通进展卡。
- `raiseMatterRecommendationProposal`（仿 raiseMatterArtifactProposal，**独立小配额** investigationRecoCardMaxLive 不挤安全求助池）：title `💡 我的建议：…`，why `💡{advice}\n📎因为{because}{nextStep?👉一键…}\n排查：{fact}`，P1 置顶，动作 `按建议办/让AI接着推/知道了`。
- audit `investigation_recommended{matterId,stance}` **只在真升💡卡分支写**（防与 artifact 双计）。

### P0-2 结果率北极星 — db.ts
- AI_ACTIVITY_ACTIONS 加 `investigation_recommended`(isResult)。getAiActivityTally 加 `recommendedCount` + `resultRate` = **跨action distinct matterId**(resolved∪artifact∪recommended) / (上述∪纯事实progressed∪unknown∪blocked无rec)。面板顶部「近7天 AI 给了你 N 条直接建议 · 结果率 X%」。
- **防换壳负反馈**：分子只数过硬门的；包装成建议没过 grade → 不升卡 → 不写 audit → 进分母不进分子 → 结果率反被拉低。

### P0-3 面板 reframe — AiActivityPanel.tsx（纯前端）
- isResult 从"看 verdict 贴标签"改成"看有无**有效 recommendation/artifact**"(后端落 hasRecommendation 布尔)。每行第一行 `💡 我建议你Y`，第二行小字 `因为Z`，factSummary+排查步骤收进 trace 折叠。无建议项明确标「仅查证·暂无建议」，不伪装结果。

### P0-X 救回会话建议 — chatConclusionPrompt.ts + chatConclusionService.ts
- verdict 枚举加 `'advice'`：AI 给了**实质建议/意见/方案**(即便没改状态)→ verdict='advice'，升💡卡 + 写 chat_conclusion_written_back；泛泛"建议继续跟进"仍 no_change。**advice 卡豁免 dismiss 守卫**(否则高频 matter 新建议被既有降噪吞)，保留"在场办结提案"守卫。

## 3. P1-5 自动开会话（默认 off 灰度）— **只落消息、不起 turn**
审查实证 `sendTopicMessage` 会 spawn turn(抢 gate + 跑 aiisn-chat 有 bash 代发风险)。故 `maybeQueueAutoConversation`：用 createChatTopic(sourceKind='ai_push') + **只插一条 assistant 消息**(insertRuntimeMessage，不 spawn turn、不过 gate、不碰 bash)，用户回复才由既有 TopicSession 起 turn(用户在环)。硬闸(DB持久化)：grade过且 stance∈{do,escalate,decide}；priority∈{P0,P1}或badcase；同matter幂等(source_ref_id)；全局日配额≤investigationAutoTopicDailyMax(默认2)；**默认 investigationAutoTopicEnabled=false**。先做 P1-4 卡上手动「让AI接着推」按钮(用户点→既有 sendTopicMessage 起 turn)。

## 4. 硬约束（红线）
①禁代发：recommendation/nextStep 限只读·起草，gradeRecommendation 否决完成态动词；P1-5 不起turn根除碰bash。②对外/不可逆 confirm：💡卡是提案，不自动改 status。③投查只读。④单并发gate：P0/P1-4 不触发新turn；P1-5 只落消息不抢gate。⑤反噪声/换壳：grade三联防线+结果率负反馈+独立配额+日配额+**人工抽检哨兵**；做不到真建议就降级回纯事实，绝不套💡壳。

## 5. 验收
| 指标 | 基线 | 目标 |
|---|---|---|
| **结果率(北极星)** | ~3% | **≥40%** |
| 有效建议数 | 0 | ≥30/7d |
| 会话建议救回 | 0 | >0 |
| 换壳率(反向哨兵) | — | 趋0(填rec未过grade占比 + 人工抽检真样) |

## 6. 单测清单
gradeRecommendation(事实复述→false/泛跟进→false/完成态谎报→false/because不引证据→false/do无动作→false/drop无动作但引证据→true/达标→true)；parseRecommendation向后兼容；writeback决策树(rec达标升💡卡+audit;needhelp优先于💡;artifact与💡同满足只进artifact不重复写audit);tally跨action distinct只算一次;chatConclusion advice升卡+dismiss豁免;P1-5日配额跨重启+幂等+不调spawn。

## 7. 复用点 / 落点
复用 isValidArtifact/parseArtifact/raiseMatterArtifactProposal(独立配额)/raiseMatterProgressProposal(回落)/决策树else-if/getAiActivityTally distinct范式/actionMeta/applyChatConclusion/createChatTopic。唯一可能新造：insertAiMessageOnly(若 insertRuntimeMessage 可直插 assistant 消息则零新造)。落点：investigationPrompt.ts / investigationWriteback.ts / matterResolveProposal.ts / chatConclusionPrompt+Service.ts / db.ts / AiActivityPanel.tsx / chatTopics.ts / config.ts。

## 8. 实现者复核
设计与独立分析一致(根因①+auto-chat经insertRuntimeMessage不起turn)，并补了根因②(会话建议被丢)。gradeRecommendation 的"增量信息+引证据+否决完成态"三联门是防换壳关键。落地序：P0-1(schema+硬门)→P1-4(💡卡)→P0-2(结果率)→P0-3(面板)→P0-X(救会话建议)→P1-5(默认off)。**致命失败模式**：把事实换壳叫建议——达不到就不计入、不升卡、不开会话，宁可结果率显示低也不刷高。
