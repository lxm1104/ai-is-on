# MVP69 — 「AI 替你做了什么」→ 人机协作中枢 技术方案

> 状态：设计定稿（已吸收三轮对抗审查的修订）
> 落点：apps/server（投查/卡片/db）+ apps/web（AiActivityPanel/SignalCard）
> 前置：MVP66（无新证据不重查 + 新证据解封）、MVP67（dangling 承诺）、MVP68（AiActivityPanel 自主动作流）

---

## 1. 背景与目标

### 1.1 现状（已读源码核实）

「AI 替你做了什么」面板（`apps/web/src/components/AiActivityPanel.tsx` + `GET /api/ai-activity` → `db.ts:listAiActivity`）当前是**单向只读**：从 `audit_logs` 取 AI 自主动作（`matter_auto_resolved` / `investigation_written_back` / `chat_conclusion_written_back`），join 事项标题，排除 conf=0 哨兵。

自主引擎（`apps/server/src/investigation/`）的结论分流（`investigationWriteback.ts:158-176`，一条 `else if` 链）：

- `resolved` 高置信 → 自动办结回执 / 办结提案卡；
- `progressed`/`blocked` 且 `confidence≥0.6` → 进展回执卡（`raiseMatterProgressProposal`）；
- `unknown` 且 `confidence>0` → 仅 owner=自己且够旧时升 dangling 卡（`maybeRaiseDanglingCommitment`），否则**静默丢弃**。

**核心缺口**：`blocked`/`unknown` 就是"AI 没解决"，`factSummary` 常已说明卡点（缺 traceID / 状态在他人名下 / 承诺查无跟进 / 需决策 / 需对外发消息但公司禁 AI 代发），但这些卡点**埋在自由文本里、未结构化交给用户**。用户即便想补位也没有承接入口。

### 1.2 目标

1. **更透明**：用户能准确知道 AI 做了什么、此刻在查什么、为什么暂停某件事 —— 进行中实时态 + 已做（置信/verdict/可展开 trace）+ 需要你。
2. **真闭环**：AI 卡住时结构化告诉用户"卡在 X、需要你 Y"；用户补一手 → 落成挂该 matter 的外部证据 → **下一 tick 自动解封重查**，AI 带新证据接着干。

### 1.3 硬约束（不可违反）

- ① 对外发送（飞书 IM）公司策略禁止 AI 代发 —— 只能 `draft_reply` 起草、用户自己发；
- ② 一切对外/不可逆动作 confirm 门控；
- ③ 单并发 opencode LLM gate 是稀缺资源 —— 不增无谓 LLM 调用、不制造卡片噪声；
- ④ 投查工具硬只读。

### 1.4 设计原则

**复用 > 新造**。环上唯一新增的 LLM 表达是 conclusion 多一个**可选** `needFromUser` 字段（搭在现有 `conclude` 同一次出参，**不增调用次数**）；其余全是接线 + 投影 + 一个新 proposal 前缀。回填**复用 `mark_done` 的 kind 与管道**（不新造 `CardActionKind`），只在分支内按 needhelp 前缀走 `effect:'no_change'` 支路。

---

## 2. 端到端协作闭环

```
        ┌──────────── 自主引擎 investigation loop ────────────┐
        │ runInvestigation → conclude{verdict, confidence,    │
        │            factSummary, evidence,                   │
        │      ★ needFromUser{kind, ask, options?}}           │
        └────────────────────────┬────────────────────────────┘
                                 │ applyInvestigationResult（verdict 分流，重排为先 needhelp）
   ┌─────────────────────────────┼──────────────────────────────────┐
 resolved/progressed       blocked/unknown + 合法 needFromUser     unknown 无 needFromUser
 → 办结/进展/回执卡          → ★ needhelp 求助卡                    → dangling(MVP67) / 静默
   │                            │ proposal:matter-needhelp:{id}       │
   ▼                            ▼                                     ▼
 ┌────────────── AiActivityPanel 三区 ──────────────────────────────────┐
 │ 🙋 需要你帮忙(needhelp) │ ⏳ 进行中(inFlight+冷却态) │ ✅ 已替你做(audit+trace) │
 └────────┬──────────────────────────────────────────────────────────────┘
          │ 用户 inline 补一手（贴 traceID / 拍板 opt / 一句话 / 我发了）
          ▼
   mark_done(needhelp 支路)  →  ① 先 updateAttentionItemStatus(acted)
                              →  ② upsertContextUnit{origin:'card_action'}（★ 不被回声门排除）
                              →  ③ attachMatterContextLink{effect:'no_change', relation:'evidence'}
                              →  ④ kickInvestigation()（叶子信号，绕过循环依赖）
          ▼
   hasNewExternalEvidenceSince=true（since=派发起始时刻，覆盖 in-flight 期回填）
   ＋ 卡已 acted → hasLiveMatterProposal=false（skip 门放行）
   ＋ isStuckDeadEnd 新增新证据逃生门（55% unknown 主力场景才解得开）
          ▼
   下一 tick 自动重查 → AI 带你补的证据再 conclude
```

环上**唯一新增 LLM 表达** = `needFromUser` 可选字段（不增调用次数）。其余是接线。

---

## 3. 分阶段路线

> 三轮对抗审查共识：P0 自称的闭环原本有**三个致命断点**（止损门无逃生口、调错 kick 信号、`since` 语义吞回填），加 **两个防噪缺口**（`hasLiveMatterProposal` 不认 needhelp、互斥优先级是 `else if` 链）。下文已把这些**全部上提到 P0**，因为缺任一条闭环就是死的或会刷屏。

### P0 — 最小可用闭环（"AI 卡住 → 结构化求助 → 你补一手 → 自动接着查"）

P0 是一个不可分割的整体，下列各项缺一不成环。顺序即依赖顺序。

---

#### P0-0｜回流 origin 铁律（地基约定，零代码量但漏了全白做）

- **要解决**：保证"用户补的证据一定能解封重查"。
- **关键点**：回填落的 `context_unit` 的 `origin.kind` 必须是 `'card_action'`，绝不能带 `agent_run` / `investigation:%`，否则被 `db.ts:hasNewExternalEvidenceSince` 的回声门（`NOT (cu.origin_kind='agent_run' AND cu.origin_ref_id LIKE 'investigation:%')`）过滤，永不解封。
- **复用**：`mark_done`（`cardsService.ts:435-445`）已是正范本，照抄 origin 约定。
- **核实**：`upsertContextUnit` 的 INSERT/UPDATE 两分支都 `updated_at=now`、`origin_kind=input.origin.kind`（`contextStore.ts`）；`card_action` ∈ `ContextOriginKind`，不被排除。铁律成立。
- **为什么第一**：隐形契约，写在最前避免后面 debug"为什么补了不重查"。

---

#### P0-1｜conclusion schema 扩 `needFromUser`（让 AI 会说"缺什么"）

- **file**：`investigation/investigationPrompt.ts`
  - `InvestigationConclusion` type（:50-55）加可选字段 `needFromUser?: NeedFromUser`。
  - conclude JSON 模板（:30-38）加该段 + 引导语（见下"措辞"）。
  - `parseInvestigationStep`（:213-225）解析时**结构化校验 + 容错**：非法/缺失 → `needFromUser=undefined`，严格向后兼容降级回今天的路径。
- **复用**：现有 conclude JSON 协议 + `clamp01` 同款防御式解析。旧结论无该字段 → undefined → 回落今天分流（回归风险低，已核实 `parseInvestigationStep` 全程防御式降级）。
- **不增 LLM 调用**：字段搭在同一次 `conclude` 出参上。
- **prompt 措辞**（吸收审查1-P1-1：`confidence` 度量的是"对 verdict 的把握"，不是"对缺什么的把握"，不能只靠它当门）——把填写门槛措辞强化为**可枚举的具体物**：
  > verdict 为 blocked/unknown 且你**明确知道缺哪一件具体的事**时，填 needFromUser：
  > - `need_credential`：必须能命名缺的是哪个 traceID/日志字段（很多在对方消息里，先自查，找不到才求助）；
  > - `need_info`：必须能命名缺的是哪个关键事实（哪个版本/环境/对方是谁）；
  > - `need_decision`：信息已齐需你拍板，**options 至少 2 项**；
  > - `need_outbound`：需你去发哪条飞书消息（公司禁 AI 代发）；
  > - `owned_by_other`：必须能 name 出"状态在谁名下"（你 list_my_tasks 看不到）；
  > - `tool_gap`：某系统你够不到只读入口。
  > **不确定缺什么、说不出具体物，就别填**（宁可少求助，绝不把"我也不知道为啥没查到"包装成求助卡）。
- **为什么这个顺序**：它是 P0-2 求助卡的弹药。

---

#### P0-2｜verdict 分流重排 + 新 needhelp 求助卡

> 吸收审查3-P1-E + 审查1-P1-2：**现有 `else if` 链（writeback:158-176）必须显式重排**，否则 `blocked` 会先撞进 :163 progress 分支、needhelp 起不来，或两卡并存。

- **互斥优先级（新分流顺序）**：`resolve(办结) > needhelp(求助) > progress(进展回执) > dangling(查无跟进)`。
- **file**：`matter/matterResolveProposal.ts` —— 加 `raiseMatterNeedHelpProposal(matter, { needFromUser, factSummary, evidence })`，复用参数化内核 `raiseMatterProposal`（照搬 dangling 写法 :105-120），新前缀常量：
  ```ts
  export const MATTER_NEEDHELP_PROPOSAL_PREFIX = 'proposal:matter-needhelp:';
  ```
  内核内 `if (matter.status==='resolved'||'dropped') return false`（:35）天然防僵尸卡。**顶替**（照搬 resolve 顶 progress 的 :62 写法）：升 needhelp 时 `markAttentionItemsSupersededByHash(PROGRESS前缀)` + `markAttentionItemsSupersededByHash(DANGLING前缀)`。
- **file**：`matter/matterResolveProposal.ts` —— dangling helper 互查（:110-111）**加一行** `if (hasLiveProposal(MATTER_NEEDHELP_PROPOSAL_PREFIX, matter.id)) return false;`（吸收审查1-P1-2，明确"needhelp 顶 dangling"方向，避免双卡）。
- **file**：`investigation/investigationWriteback.ts:158-176` —— `else if` 链改造：
  ```
  ① resolved 高置信 → 自动办结/办结提案（不动，最高优）
  ② blocked/unknown 且 isValidNeedFromUser(c.needFromUser) 且 confidence≥0.5 → raiseMatterNeedHelpProposal（新增，插在 progress 之前）
  ③ progressed/blocked 且 confidence≥0.6 → progress 回执（保留，兜底）
  ④ unknown 且 confidence>0 → dangling（保留，兜底）
  ```
- **file**：`attention/attentionProjection.ts:90` —— 加 `proposal:matter-needhelp:` 前缀分支，按 `needFromUser.kind` 决定动作组（见 §4.4 动作表，照搬 dangling :121-127 范式）。
- **求助门槛**（防噪，见 §5）：仅当 `needFromUser` **合法**（kind 在枚举内 + ask 非空 + kind 专属结构校验，如 need_decision 需 `options.length≥2`）**且** `confidence≥0.5` 才升。校验函数 `isValidNeedFromUser` 放在 helper/projection 前置，不合法 → 回落 progress/dangling/静默。
- **complication：needFromUser 需被读到**。`getRecentInvestigationVerdicts` / writeback 当前从 `result.conclusion` 直接拿（同进程内对象），无需落库即可在分流时读 —— 但**升卡时要把 `needFromUser` 带进卡片 payload**（`why` 文案 + 投影动作要用 kind/options）。落点：`raiseMatterNeedHelpProposal` 的 `why` 由 `needFromUser.ask` + factSummary + ≤3 证据拼成；kind/options 存进 `llmItem.actionOptions`（need_decision 复用 `actionOptions`→`opt:*` 投影，attentionProjection:150）或一个轻量 payload 字段。
- **复用**：`raiseMatterProposal` 内核 / `defaultAttentionActions` 前缀分发 / `markAttentionItemsSupersededByHash` 顶替 / dangling 全套防噪范式。
- **为什么这个顺序**：它是用户第一眼看到的求助出口。

---

#### P0-3｜`hasLiveMatterProposal` 认 needhelp 前缀（防重查浪费 gate + 防回填后被自己挡一轮）

> 吸收审查1-P0-1 + 审查2-P1-C：`hasLiveMatterProposal`（db.ts:2967）写死只查 `resolve|progress`，**不认 needhelp**。dispatcher skip 门（dispatcher:217）用它判"结论已交用户、不必重查"。不补 → needhelp 卡 live 期间该 matter 仍可能被重查、白耗一次单并发 gate。

- **file**：`db.ts:hasLiveMatterProposal`（:2967）SQL 加 `OR input_hash LIKE 'proposal:matter-needhelp:%'`。一行。
- **配对（必须同时做）**：`submit_evidence`/回填分支**在落证据之前**先 `updateAttentionItemStatus(attn.id, 'acted')` —— 卡置 acted 后 `hasLiveMatterProposal` 立即返回 false → skip 门放行重查。否则引入"回填后被自己挡一轮"的新 bug。
- **为什么这个顺序**：它和 P0-2 的卡、P0-4 的回填配套；缺它 needhelp 卡要么浪费 gate（不认卡），要么补了不重查（认卡但回填没置 acted）。

---

#### P0-4｜`isStuckDeadEnd` 止损门加新证据逃生门（最致命的断点）

> 吸收审查3-P0-A：**整个 P0 闭环最致命的漏洞，原设计完全没提**。skip 谓词（dispatcher:216-219）是 `hasLiveMatterProposal(id) || isStuckDeadEnd(...) || shouldSkipNoNewEvidence(...)`。其中 `isStuckDeadEnd`（:103-110）只看最近 2 次 verdict 是否都属 `{unknown, blocked}`，**完全不查新证据**。needhelp 卡高发来源恰是 blocked/unknown（55% unknown），这些 matter 最近 2 次大概率正是死胡同 verdict。用户补位后 `isCoolingDown` 虽被绕过（:192 有逃生门），但 `isStuckDeadEnd` 仍 true → 候选被 filter 掉（:144 `!shouldSkip`）→ **AI 不会接着查**，闭环在主力场景下不转。

- **file**：`investigation/investigationDispatcher.ts:216-219` skip 谓词，给 `isStuckDeadEnd` 加与 `isCoolingDown`（:192）同款的新证据逃生门：
  ```ts
  (id) =>
    hasLiveMatterProposal(id) ||
    (isStuckDeadEnd(getRecentInvestigationVerdicts(id, 3)) &&
      !hasNewExternalEvidenceSince(id, getLastInvestigatedAt(id) ?? '')) ||
    shouldSkipNoNewEvidence(getLastInvestigatedAt(id), (since) => hasNewExternalEvidenceSince(id, since))
  ```
  即"死胡同退避，但用户补了新证据就解封"—— MVP66 在 cooldown 侧已做、却漏在 stop-loss 侧的对称修补。
- **为什么这个顺序**：不补这条，P0 自称的"用户补了 AI 自动接着查"在 55% unknown 主力场景下是死的。

---

#### P0-5｜`since` 语义修正：覆盖 in-flight 期间到达的回填（规格缺口）

> 吸收审查2-P0-B：排查耗时几十秒~几分钟。用户在排查执行窗口内（T1 派发 < T1.5 回填 < T1.9 结束）补一手，`requestInvestigationSoon` 因 `inFlight===true` 吞掉 kick（dispatcher:276）。排查 T1.9 结束写 `investigation_written_back`，`getLastInvestigatedAt` 推进到 T1.9。下一 tick `shouldSkipNoNewEvidence(since=T1.9)` → 回填 unit 的 `updated_at/created_at=T1.5 < T1.9` → **false → skip**，用户这一手被"排查结束时刻"当 since 吃掉，永不重查。

- **根因**：`hasNewExternalEvidenceSince` 的 `since` 用的是**排查结束时刻**（`investigation_written_back.created_at`），而非**派发起始时刻**。
- **核实**：dispatcher 在派发时已记 `lastInvestigatedAt.set(candidate.id, now)`（:224，now=派发起始 T1）于内存 Map；但 skip 门用的 `getLastInvestigatedAt(id)`（db.ts，派生自 `investigation_written_back.created_at`=T1.9）才是 since 源头。
- **file**：`investigation/investigationWriteback.ts:119-123` —— `investigation_written_back` 的 audit `payload` 增写 `startedAt`（由 dispatcher 把派发起始时刻透传给 `applyInvestigationResult`）；`db.getLastInvestigatedAt` 改取 `json_extract(payload,'$.startedAt')`（缺失时回落 `created_at`，向后兼容旧记录）。这样 in-flight 期内 T1<T1.5<T1.9 满足 `T1.5 > startedAt(=T1)`，下轮被识别为新证据。
- **复用**：dispatcher:224 已有派发起始时刻，只需透传。
- **为什么这个顺序**：闭环正确性的根因修复 —— 不修，长耗时排查期内的回填稳定丢失。

---

#### P0-6｜用户 inline 回填 → 落 matter 外部证据 → 自动解封（闭合"人→AI"半环）

- **file**：`cards/cardsService.ts` —— **不新造 `CardActionKind`**（吸收审查3-P0-C：`CardActionKind` 是封闭联合 protocol.ts:48-59，`mapKindToStatus` 有 `default:prev`，新造要穿透 4 处且漏改 `mapKindToStatus` 会让卡片不置 acted）。改为**复用 `mark_done` kind**，在 `mark_done` 分支（:415-486）内按 needhelp 前缀走支路：
  ```ts
  if (action.kind === 'mark_done') {
    const isNeedHelp = attn.inputHash.startsWith(MATTER_NEEDHELP_PROPOSAL_PREFIX);
    const note = opts?.note?.trim().slice(0, 2000) || undefined;
    const fullMatterId = attn.matterId ? matchMatterId(attn.matterId) : null;

    if (isNeedHelp) {
      // needhelp 支路：只补证据、不办结、不学规则
      // ① 先置 acted（解 P0-3 skip 门，必须在落证据之前）
      const updated = updateAttentionItemStatus(attn.id, 'acted', now);
      if (!updated) return { ok: false, error: 'update failed' };
      // ② 落 card_action 证据 unit（origin 铁律 P0-0）
      if (note && fullMatterId) {
        const { unit } = upsertContextUnit({
          kind: 'note',
          origin: { kind: 'card_action', refId: attn.id },          // ★ P0-0
          title: `补充：${attn.title.slice(0, 60)}`,
          content: note,
          scope: 'work',
          actionability: 'record',
          confidence: 1,
          mergeHint: `needhelp-backfill:${attn.id}:${Date.now()}`,    // ★ P0-7 多轮不覆盖
          silent: true,
        });
        attachMatterContextLink({
          matterId: fullMatterId, contextUnitId: unit.id,
          relation: 'evidence', effect: 'no_change',                 // ★ 只补证据不 resolve
          confidence: 1, reason: '用户应答求助卡补充的信息', now,
        });
      }
      // ③ 近实时解封（叶子信号，绕过循环依赖，见 P0-8）
      kickInvestigation();
      recordAttentionInteraction(attn, 'mark_done', now);
      const card = projectAttentionItemToCard(updated);
      broadcast({ type: 'card_updated', card });
      return { ok: true, card };
    }
    // ... 原 mark_done（resolve）路径不变
  }
  ```
- **核实**：`attachMatterContextLink` 是纯 link 写入，`effect:'no_change'` 不触发 status 变更（status 只经 `recordMatterTransition`/`userResolveMatter`），"只补证据不 resolve"成立。`silent:true` 跳 `invokeHook`（避免 reducer echo），唯一消费者就是投查 loop 重查 —— 故 P0-4/P0-5 必须先修好。
- **复用**：`mark_done` 全套管道 + inline textarea + `hasNewExternalEvidenceSince` 解封。

---

#### P0-7｜回填 mergeHint 带轮次（多轮补位不互相覆盖）

> 吸收审查2-P0-A + 审查3-P1-D：设计原给固定 `mergeHint: needhelp-backfill:${attn.id}` → 同卡第二次补会 upsert 命中同一 unit 走 UPDATE，`content` 整体覆盖（contextStore:200），第一手证据丢失；且闭环对"UPDATE 刷 `updated_at`"产生隐性依赖（`mcl.created_at` 在 ON CONFLICT 时是哑的）。

- **修法**：mergeHint 带轮次/时间戳 `needhelp-backfill:${attn.id}:${Date.now()}`（见 P0-6 代码）—— 每次回填都是**新 unit + 新 mcl 行**，两条腿（`cu.updated_at`、`mcl.created_at`）都新鲜，彻底摆脱对 UPDATE 刷 updated_at 的隐性依赖，多轮证据全部保留。

---

#### P0-8｜回填用 `kickInvestigation`（叶子信号），不直调 `requestInvestigationSoon`

> 吸收审查3-P0-B：`requestInvestigationSoon` 在 `investigationDispatcher.ts:274`，`investigationKick.ts` 导出的是 `kickInvestigation()`（零 import 的叶子模块，注释明写"解耦 matterReducer ↔ dispatcher 避免循环依赖"）。若从 cardsService 直 import `requestInvestigationSoon` → 引入 `cardsService → dispatcher → writeback → matterResolveProposal/attentionStore` 循环 import 风险。

- **修法**：cardsService 调 `kickInvestigation()`（叶子，安全），由 dispatcher 端既有的 `onInvestigationKick(() => requestInvestigationSoon())`（:294）转发。复用现成解耦通道，不新连 import 边。

---

#### P0-9｜防噪收尾（门槛 + 去重 + 冷却 + dismiss 豁免 + 防焦虑闸前移）

见 §5。与 P0-2/6 同批做，否则 unknown 基数 55% 下无门=刷屏灾难。**特别地（吸收审查1-P1-3 + 审查3-P1-F）：防焦虑闸从原 P1 上提到 P0**——P0 上线即灰度：先只对 `need_credential` 一类开 needhelp 升卡（最高 ROI、最具体），其余 kind 先只在面板"需要你"区被动可查、不主动升 attention 卡；同一时刻只浮 N=2 张最高优。用真实填充率数据再放宽。

---

> **P0 闭环判据**：构造一件 blocked+合法 needFromUser 的 matter → 出 needhelp 卡 → 用户 inline 补一句（含 in-flight 期补的情况）→ 卡置 acted + 落 card_action unit（带轮次 mergeHint）→ 下一 tick 自动重查（skip 门三关全放行：hasLiveMatterProposal=false、isStuckDeadEnd 被新证据解封、shouldSkipNoNewEvidence=false）→ AI 带新证据再 conclude。端到端跑通 = P0 达成。

---

### P1 — 把环装进"家" + 补齐"在做什么"透明度

#### P1-1｜AiActivityPanel 升级为三区协作中心

- **要解决**：给求助卡单一入口，而非散在卡列表。
- **三区**：① 🙋 需要你帮忙（needhelp 卡，置顶）｜② ⏳ 进行中（inFlight 排查 + "因无新进展暂停、有新消息会自动接着查"的冷却态）｜③ ✅ 已替你做（MVP68 audit 流，复用）。
- **归属铁律**（动手前先拍）：求助卡的"家"= 面板"需要你帮忙"区。**待处理卡列表里不重复出现 needhelp 卡**（同卡两处 = 噪声+焦虑）。实现：CardList 过滤 `proposal:matter-needhelp:` 前缀。
- **file（后端）**：`db.ts:listAiActivity` 旁加轻接口 `GET /api/ai-activity/now` → `{ inFlight?: {matterId,title,startedAt}, needHelp: [...needhelp 卡投影] }`。inFlight 来自 dispatcher 把 `inFlight`（:167 现 boolean）升成模块态 `{matterId,title,startedAt}`，经既有 `broadcast`（ws.ts）发 `investigation_started/finished`（与 `matter_updated` 同款），`finished` 广播放进同一 `finally`（:268）防泄漏。
- **file（前端）**：`AiActivityPanel.tsx` 加两区渲染。
- **inFlight 易失态兜底**（吸收审查1-P2-2 + 审查2-P2-D）：inFlight 是进程内单值，崩溃/重启会留陈旧"进行中"。`/api/ai-activity/now` 返回时校验 `startedAt` 在合理窗口内（如 >10min 视为陈旧不显示），前端也加超时兜底。**不要把易失态当持久真相广播**。并发模型是全局至多 1 件 → 该区天然只 0/1 条，不会假象多件并行。
- **复用**：`listAiActivity` / attention_items(needhelp 前缀查) / `broadcast` ws 基建 / dispatcher 既有 `inFlight`+`finally`。

#### P1-2｜置信 + verdict 徽标 + trace 可展开（透明信任核心）

- **置信/verdict**：`AiActivity` 类型已含 `confidence`/`verdict`（`listAiActivity` 已 select、`api.ts` 已含），`AiActivityPanel` 当前丢弃 → 加置信 chip + verdict 色条。**纯前端零风险**。
- **trace**：trace 全保真落在 `task_traces`（`captureInvestigationTrace`→`insertTaskTrace`，按 matterId）。
  - **file**：`db.ts` 加 `getTraceByMatterId(matterId, 'investigation')`；`/api/ai-activity` 按 matterId 带回最近 trace 的 steps；面板行内"▸ 查了 N 步"折叠区列 `友好工具名→summary`。
  - **不是零后端**（吸收审查3-P2-G 纠正）：需新增 `getTraceByMatterId` + 接口改造 + 术语映射。
- **风险（守证据优先铁律）**：trace summary 含内部工具名/CLI 原文（`run_command` 命令、内部路径）→ 必须 `clip` + 术语映射（`im_search→飞书消息`、`run_command→本地查代码`），只做术语层、不改事实，别泄漏原文。
- **复用**：`task_traces` + `investigationToSteps`（playbookCapture.ts）+ 已落库 confidence/verdict。

#### P1-3｜按 needFromUser.kind 铺开求助卡形态

在 P0 主闭环（need_credential 灰度）之上，按 kind 放宽：

- `need_decision`：接 MVP64 决策信息包，`options[]` → 渲染 `opt:*` 拍板按钮（复用 `actionOptions`→`opt:*` 投影 attentionProjection:150）；点选落 evidence unit（走 mark_done needhelp 支路，note=选项文本）。
- `owned_by_other`：轻量人选解析（复用 `entityResolver`/`resolveAliased`）改 `matter.ownerEntityId` + 落"已转交 X" unit；转交后该 matter 自然退出 dangling（owner≠自己），逻辑自洽。
- `need_outbound`：复用既有 `draft_reply`（AI 起草、用户自己发，**绝不代发**）+ "我发了" inline 回填结果。

---

### P2 — 实测验证求助卡被消费、转化率不低后再扩

- **P2-1｜need_credential 专项（最高 ROI）**：实测主力卡点是"要 traceID 才能 run_command 追"。prompt 强化"先自查 traceID（很多在对方消息里），找不到才求助"；求助卡 inline 框"贴 traceID 这里"。一条 traceID 让 AI 从"查不清"跳到"定位 file:line+commit"。
- **P2-2｜活动流行内纠错/撤销**：`matter_auto_resolved` 行接 `matter_reopen`（打通 audit↔动作通道；难点：行→matterId→动作 API 映射）。
- **P2-3｜AI 主动放下也透明**：`isStuckDeadEnd`/`shouldSkipNoNewEvidence` 退避时**绝不升卡**，只在面板"进行中"区被动可查"已暂停排查：连续查不清，等有新信息再继续"（守噪声红线）。
- **P2-4｜求助与 dangling 合流**：长期不处理的 needhelp 卡到 MVP67 阈值时不重复求助，并入 dangling 语义（统一"待你处理"出口）。

---

## 4. 核心数据与接口设计

### 4.1 conclusion schema 扩展（唯一协议改动）

```ts
// investigation/investigationPrompt.ts
type NeedKind =
  | 'need_credential'  // 缺 traceID/日志ID 才能 run_command 追
  | 'need_info'        // 缺一个可命名的关键事实（哪个版本/环境/对方是谁）
  | 'need_decision'    // 信息已齐，需你拍板（options≥2）
  | 'need_outbound'    // 需对外发飞书消息推进（公司禁 AI 代发）
  | 'owned_by_other'   // 状态在他人名下，list_my_tasks 看不到（须 name 出是谁）
  | 'tool_gap';        // 某系统 AI 够不到只读入口

type NeedFromUser = {
  kind: NeedKind;
  ask: string;                 // 给用户看的一句话："要继续追，我需要那条 traceID"
  options?: string[];          // 仅 need_decision：拍板选项 → 渲染 opt:* 按钮（长度≥2 才合法）
};

type InvestigationConclusion = {
  verdict: 'resolved' | 'progressed' | 'blocked' | 'unknown';
  confidence: number;
  factSummary: string;
  evidence: string[];
  needFromUser?: NeedFromUser;  // ★ 新增，仅 blocked/unknown 读
};
```

**合法性校验（升卡前置，非依赖 conf 单维度）**：

```ts
function isValidNeedFromUser(n: NeedFromUser | undefined): boolean {
  if (!n) return false;
  if (!NEED_KINDS.has(n.kind)) return false;
  if (!n.ask?.trim()) return false;
  if (n.kind === 'need_decision' && !(n.options && n.options.length >= 2)) return false;
  return true;
}
```

### 4.2 求助卡（proposal:matter-needhelp:{matterId}）

| 字段 | 来源 |
|---|---|
| `inputHash` | `proposal:matter-needhelp:{matterId}`（幂等键，同 matter 同时一张） |
| `title` | `🙋 需要你：{matter.title}` |
| `why` | `needFromUser.ask` + `\n排查：{factSummary}` + 证据 ≤3 条 |
| `priority` | 默认 P2（不与催办抢）；防焦虑闸：P0 阶段仅 matter.priority=P0/P1 的 need_credential 进待处理区主动浮 |
| `actionOptions` | need_decision 时存 `options` → 投影 `opt:*` |
| `suggestedAction` | 按 kind：`贴给我接着查` / `点选拍板` / `我来发 / 我发了` |

### 4.3 verdict 分流新顺序（writeback:158-176 重排）

```
resolve(办结，conf 高)
  > needhelp(blocked/unknown 且 isValidNeedFromUser 且 conf≥0.5)   ★ 新增，插在 progress 前
  > progress(progressed/blocked 且 conf≥0.6)                       兜底
  > dangling(unknown 且 conf>0，owner=自己且够旧)                   兜底
```

互斥（顶替方向已定，代码层兜住）：
- 升 needhelp 时 `markAttentionItemsSupersededByHash(PROGRESS前缀 + DANGLING前缀)`；
- dangling helper 互查加 `if (hasLiveProposal(NEEDHELP前缀)) return false`；
- needhelp helper 走 `raiseMatterProposal` 内核（matter resolved/dropped 即拒），**显式不进 resolved-sweep 豁免名单**（吸收审查1-P0-2：needhelp 不是"关于已办结的回执"，matter 办结时应被 sweep 自动清掉、不留僵尸卡；代码注释写明"故意不豁免 sweep"）。

### 4.4 卡动作组（attentionProjection 按 kind 分支）

| kind | 动作组 | 回流落点 |
|---|---|---|
| need_credential / need_info / tool_gap | inline 输入框（复用 mark_done textarea）+「不用了」 | mark_done(needhelp 支路, note) |
| need_decision | `opt:<options>` 拍板按钮 + inline「都不是，我说」+「不用了」 | mark_done(needhelp 支路, 选项文本) |
| need_outbound | `draft_reply`(AI 起草) +「我发了」(inline 回填) +「不用了」 | mark_done(needhelp 支路, 回填结果) |
| owned_by_other | inline「在谁那」+「帮我起草问他」(draft_reply) +「不用了」 | mark_done / 改 owner |

「不用了」走 `dismiss` 但**豁免 not_relevant**（cardsService:518-525 白名单加 needhelp 前缀，照搬 dangling）。

### 4.5 用户回流 → 挂 matter 的 context_unit（落证据路径）

见 P0-6 代码块。要点：`origin.kind='card_action'`（过回声门）、`relation='evidence'` + `effect:'no_change'`（不办结）、`mergeHint` 带轮次（多轮不覆盖）、`silent:true`（不触发 reducer echo）、落证据前先 `updateAttentionItemStatus(acted)`（解 skip 门）、落完 `kickInvestigation()`（叶子信号近实时解封）。

---

## 5. 防噪与约束遵循

**何时才求助（求助门槛）**：仅当 `isValidNeedFromUser(needFromUser)` **且** `confidence≥0.5` 才升 needhelp 卡。合法性是**kind 专属结构校验**（need_decision 须 options≥2、owned_by_other 须 name 出是谁等），不只靠 conf 这个"度量错维度"的阈值（审查1-P1-1）。不合法 → 回落 progress/dangling/静默。宁可少求助。

**去重**：`proposal:matter-needhelp:{matterId}` 前缀幂等（`hasLiveProposal`），同 matter 同时一张。

**冷却 + 防复发**：
- 升过 needhelp 且用户未回填前：`hasLiveMatterProposal`（已加 needhelp 前缀，P0-3）使 skip 门挡住重查 → 不复发、不浪费 gate；
- 用户回填解封重查若仍同类 blocker → 幂等键命中、**更新原卡话术**而非升新卡。

**互斥优先级**：`resolve > needhelp > progress > dangling`，顶替机制见 §4.3（代码层已兜，非仅文字）。

**防焦虑闸（上提到 P0）**：同一时刻只浮 N=2 张最高优 needhelp；P0 阶段灰度只对 `need_credential` + matter.priority=P0/P1 主动浮入待处理区，其余只在面板"需要你"区被动列出。用真实填充率再放宽（审查1-P1-3/审查3-P1-F：prompt 鼓励填 needFromUser 会拉高 unknown 的填充率，55%×填充率可能引爆噪声，必须有闸）。

**dismiss 不学负反馈**：needhelp 的「不用了」走 dismiss 但豁免 not_relevant（白名单加前缀，审查1-P2-1）。

**不增 LLM 调用**：`needFromUser` 搭在现有 `conclude` 同一次出参；解析侧加可选字段不增轮次；dispatcher 单件 in-flight 锁、priority 让位均未动。尊重单并发 gate。

**不碰对外发送**：`need_outbound` 只说"需要你去发"，至多 `draft_reply` 起草，绝不自动发（硬约束①）。

**投查仍硬只读**：回填走 `mark_done` 既有管道，不触发任何对外/不可逆动作（硬约束②④）。

---

## 6. 审查发现及如何已解决

> 三轮对抗审查（噪声/打扰、人→AI 回流闭环、复用/约束/最小闭环）共识：方向扎实（80% 接线非镀金），但 P0 原有 3 个致命断点 + 2 个防噪缺口。逐条对照源码核实后，全部上提 P0 并给出修法：

| # | 审查发现（已读源码核实） | 严重度 | 本方案如何解决 |
|---|---|---|---|
| 1 | `isStuckDeadEnd`（dispatcher:103-110）无新证据逃生门，55% unknown 主力场景"用户补了 AI 也不查"，闭环死 | **P0** | **P0-4**：skip 谓词给 isStuckDeadEnd 加 `&& !hasNewExternalEvidenceSince(...)`，与 isCoolingDown(:192) 同款对称修补 |
| 2 | `since` 用排查结束时刻 → in-flight 期回填被吃掉，永不重查 | **P0** | **P0-5**：`investigation_written_back` 增写 `startedAt`(派发起始)，`getLastInvestigatedAt` 改取它，覆盖 in-flight 期回填 |
| 3 | 直调 `requestInvestigationSoon` 引入循环 import | **P0** | **P0-8**：改调叶子模块 `kickInvestigation()`，复用 onInvestigationKick 转发 |
| 4 | `hasLiveMatterProposal`(db.ts:2967) 不认 needhelp → 重查浪费 gate / 回填后被自己挡 | **P0** | **P0-3**：SQL 加 needhelp 前缀 + 回填**前**先置 acted（配对，缺一引新 bug） |
| 5 | verdict 分流是 `else if` 链(writeback:158-176)，needhelp 会被 progress 截胡 / 双卡并存 | **P0** | **P0-2**：显式重排 `resolve>needhelp>progress>dangling` + `markAttentionItemsSupersededByHash` 顶替 + dangling 互查加 needhelp |
| 6 | `submit_evidence` 新造 CardActionKind 要穿透 4 处，漏改 mapKindToStatus 卡片不置 acted | P1→P0 | **P0-6**：不新造 kind，复用 `mark_done` + needhelp 前缀支路（零 protocol/状态映射改动） |
| 7 | 固定 mergeHint 致第二次回填覆盖第一次 + 闭环隐性依赖 UPDATE 刷 updated_at | P1→P0 | **P0-7**：mergeHint 带轮次 `:${Date.now()}`，每次新 unit+新 mcl，两条腿都新鲜 |
| 8 | `confidence≥0.5` 是错维度代理（度量 verdict 把握，非"缺什么"把握），unknown 易被硬凑成求助卡 | P1 | **P0-1+§5**：prompt 要求可枚举具体物 + `isValidNeedFromUser` kind 专属结构校验（need_decision options≥2 等），不靠 conf 单维度 |
| 9 | 防焦虑闸放 P1，P0 放量即裸奔（55% 基数刷屏） | P1 | **P0-9**：闸上提 P0，灰度只放 need_credential + 限浮 N=2 + 只 P0/P1 matter 主动浮 |
| 10 | dismiss needhelp 误学 not_relevant 负反馈 | P2 | **§5/P0-9**：cardsService:525 白名单加 needhelp 前缀 |
| 11 | inFlight 模块态广播，重启留陈旧"进行中"假阳 | P2 | **P1-1**：startedAt 陈旧兜底(>10min 不显示)，易失态不当持久真相 |
| 12 | trace 友好化"零后端"被低估 + CLI 原文泄漏 | P2 | **P1-2**：明确需 getTraceByMatterId + 术语映射 clip，只做术语层 |
| 13 | needhelp 误入 resolved-sweep 豁免名单 → 僵尸卡 | P2 | **§4.3**：走 raiseMatterProposal 内核 + 显式注释"不豁免 sweep" |

**已核实稳妥、可直接照抄的复用面**：`card_action` 不被回声门排除（origin 铁律成立）｜`effect:'no_change'` 不误办结｜needhelp 幂等去重(hasLiveProposal 同范式)｜不增 LLM 调用｜不碰对外发送(draft_reply 不发)｜schema 解析向后兼容(parseInvestigationStep 全程防御式降级)｜raiseMatterProposal 内核 + dangling 范本完整可照搬。

---

## 7. 验收标准

**目标1（更准确了解 AI 做/在做什么）**：
- 面板三区可见：进行中（inFlight 实时条，含 startedAt 陈旧兜底）、已做（置信 chip + verdict 色条 + 可展开 trace N 步）、需要你。
- 任一已查清记录可下钻看"AI 查了哪几步、各步查到什么"，工具名已友好化、无 CLI 原文泄漏。
- 用户能回答"AI 此刻在查哪件事 / 为什么暂时没动这件事"。

**目标2（AI 卡住→求助→你补→AI 继续）端到端闭环**：
- blocked/unknown 带合法 needFromUser 且满足门槛的事项 100% 升 needhelp 卡，话术明确说"卡在 X、需要你 Y"。
- 用户 inline 补一手后：① 卡置 acted；② 落 origin=card_action 的 matter 证据 unit（带轮次 mergeHint，多轮不覆盖）；③ `hasNewExternalEvidenceSince` 即返回 true（含 in-flight 期补的情况，since=派发起始）；④ skip 门三关全放行（hasLiveMatterProposal=false / isStuckDeadEnd 被新证据解封 / shouldSkipNoNewEvidence=false）；⑤ 下一 tick **自动**重查，AI 带新证据重新 conclude。

**防噪达标（硬约束）**：
- needhelp 卡不在待处理列表与面板重复出现（CardList 过滤前缀）。
- 无合法 needFromUser 的 unknown 不升卡（不污染 55% 基数）。
- 升过且未回填的 needhelp 卡不复发、不刷屏、不浪费 gate（hasLiveMatterProposal 认 needhelp）。
- dismiss needhelp 不学 not_relevant。
- 全链路零新增 LLM 调用、不触发任何对外动作。

**量化（实测验证后）**：needhelp 应答率（inline 回填 or dismiss）、回填后重查的结论改善率（unknown→progressed/resolved 占比）应显著高于今天静默丢弃的 0。

---

## 8. 单测清单

> P0-0 铁律核心：闭环有**两半**，单测必须同时覆盖"新证据"半 + "skip 门翻转"半（审查1-#1：原设计只测前半，必踩"补了不重查"或"没补乱重查"之一）。

### 8.1 回流解封闭环（P0-0/3/4/5/6/7）— 最关键

1. **新证据半**：求助卡回填落的 `card_action` unit → 断言 `hasNewExternalEvidenceSince(matterId, since)=true`（origin=card_action 过回声门）。
2. **skip 门翻转半**：needhelp 卡 `status='live'` 时 `hasLiveMatterProposal(matterId)=true`（挡重查）；回填置 `acted` 后 `=false`（放行重查）。**这半原设计漏测，必加**。
3. **止损逃生门（P0-4）**：构造近 2 次 verdict 全 dead-end 的 matter，无新证据时 `shouldSkip=true`；挂一条 card_action 新证据后 `shouldSkip=false`（isStuckDeadEnd 被解封）。
4. **since 语义（P0-5）**：模拟 in-flight 期回填（回填时刻 T1.5 ∈ (派发起始 T1, 排查结束 T1.9)）→ 断言下一 tick `hasNewExternalEvidenceSince(since=startedAt=T1)=true`（不被 T1.9 吃掉）。
5. **第二次回填也解封（P0-7）**：同卡补第二手 → 断言落**新** unit（mergeHint 含轮次，未覆盖第一手）+ 两条腿（cu.updated_at、mcl.created_at）均新鲜 + 解封 true。
6. **effect:no_change 不办结（P0-6）**：回填后 matter.status 不变（仍 open/in_progress）。

### 8.2 verdict 分流 + 互斥优先级（P0-2/§4.3）

7. blocked + 合法 needFromUser + conf≥0.5 → 升 needhelp 卡、**不**升 progress。
8. blocked + 合法 needFromUser → 顶替在场 progress/dangling 卡（markAttentionItemsSupersededByHash 命中，原卡 superseded）。
9. dangling helper 在 needhelp 在场时 `return false`（不双卡）。
10. unknown 无 needFromUser → 回落原路径（dangling 或静默），不升 needhelp。
11. unknown + needFromUser 非法（need_decision 无 options / owned_by_other 无人名 / ask 空）→ 不升 needhelp，回落兜底。
12. needhelp helper 在 matter resolved/dropped 时 `return false`（内核拒，防僵尸）。
13. matter 办结后 needhelp 卡被 resolved-sweep 清掉（**不**在豁免名单）。

### 8.3 schema 解析向后兼容（P0-1）

14. conclude JSON 无 needFromUser → 解析得 `needFromUser=undefined`，分流回落今天路径（旧行为不变）。
15. conclude JSON 带非法 needFromUser（kind 不在枚举 / 非对象）→ 容错降级为 undefined，不抛错。
16. `isValidNeedFromUser`：need_decision options<2 → false；ask 空白 → false；合法 need_credential → true。

### 8.4 防噪 + dismiss（P0-9/§5）

17. dismiss needhelp 卡 → 不调用 `applyAttentionFeedback({type:'not_relevant'})`（白名单豁免）。
18. 同 matter 已有 live needhelp → 第二次 `raiseMatterNeedHelpProposal` 幂等 `return false`（hasLiveProposal）。
19. 防焦虑闸：>N 张 needhelp 时，只有最高优 N=2 张 + need_credential 进待处理区，其余仅面板可查。

### 8.5 解耦（P0-8）

20. cardsService 回填路径 import 图不含 `investigationDispatcher`（只 import `investigationKick`）—— 静态断言/lint 规则防循环依赖回归。

---

## 9. 关键复用点汇总（避免新造）

| 能力 | 复用现成件 | 路径 |
|---|---|---|
| 求助卡内核 | `raiseMatterProposal` 参数化 + 新前缀 | matterResolveProposal.ts:30-54 |
| 顶替机制 | `markAttentionItemsSupersededByHash`（resolve 顶 progress 范本） | matterResolveProposal.ts:62 |
| 卡动作分发 | `defaultAttentionActions` 前缀分支（照搬 dangling） | attentionProjection.ts:90,121 |
| 回填落证据 | **`mark_done` kind + needhelp 支路**（改 effect:no_change，不新造 kind） | cardsService.ts:415-486 |
| dismiss 豁免 | 前缀白名单（照搬 dangling） | cardsService.ts:518-525 |
| 自动解封重查 | `hasNewExternalEvidenceSince`（排 investigation:% 回声） | db.ts:3023 |
| 止损/冷却门 | `isStuckDeadEnd` / `isCoolingDown` / `shouldSkipNoNewEvidence` | investigationDispatcher.ts:103,184,121 |
| 近实时解封信号 | `kickInvestigation`（叶子，绕循环依赖） | investigationKick.ts:18 |
| inline 输入 UI | `mark_done` 行内 textarea | SignalCard.tsx:848-905 |
| 拍板按钮 | `actionOptions`→`opt:*` 投影 | attentionProjection.ts:150 |
| 起草不代发 | `draft_reply` | cardsService.ts:350 |
| 进行中状态 | dispatcher `inFlight`+`finally` + `broadcast` ws | investigationDispatcher.ts:167,268 / ws.ts |
| trace 回显 | `task_traces`+`investigationToSteps` | playbookCapture.ts |
| 置信/verdict | `listAiActivity` 已 select、`AiActivity` 类型已含 | db.ts:2430 / api.ts |
| 决策信息包 | need_decision 接入 | investigationPrompt.ts:89-99 |

---

## 10. 实现落点（绝对路径）

- conclusion schema + prompt：`/Users/xinming/MyProject/ai-is-on/apps/server/src/investigation/investigationPrompt.ts`（type :50、conclude 模板 :30-38、解析 :213-225）
- verdict 分流重排 + startedAt 透传：`/Users/xinming/MyProject/ai-is-on/apps/server/src/investigation/investigationWriteback.ts`（:119-123、:158-176）
- needhelp 卡 helper + dangling 互查 + 顶替：`/Users/xinming/MyProject/ai-is-on/apps/server/src/matter/matterResolveProposal.ts`（仿 dangling :105-120 + :62 顶替写法）
- 卡动作组：`/Users/xinming/MyProject/ai-is-on/apps/server/src/attention/attentionProjection.ts`（:90 加 needhelp 前缀分支）
- 回填支路 + dismiss 豁免：`/Users/xinming/MyProject/ai-is-on/apps/server/src/cards/cardsService.ts`（:415-486 mark_done needhelp 支路、:518-525 豁免白名单加 needhelp）
- skip 门逃生 + since + inFlight 模块态：`/Users/xinming/MyProject/ai-is-on/apps/server/src/investigation/investigationDispatcher.ts`（:216-219 加 isStuckDeadEnd 逃生门、:224 startedAt、:167/:268 inFlight 升模块态）
- 叶子 kick：`/Users/xinming/MyProject/ai-is-on/apps/server/src/investigation/investigationKick.ts`（kickInvestigation）
- hasLiveMatterProposal 加 needhelp + getTraceByMatterId + /api/ai-activity/now：`/Users/xinming/MyProject/ai-is-on/apps/server/src/db.ts`（:2967、:2430 listAiActivity 旁、新增 getTraceByMatterId）
- 三区面板 + inline 回填 + 列表过滤：`/Users/xinming/MyProject/ai-is-on/apps/web/src/components/AiActivityPanel.tsx`、`/Users/xinming/MyProject/ai-is-on/apps/web/src/components/SignalCard.tsx`（:848-905 抄 textarea）、CardList（过滤 needhelp 前缀）
- trace 回显复用：`/Users/xinming/MyProject/ai-is-on/apps/server/src/playbook/playbookCapture.ts`（investigationToSteps）
- 活动流类型：`/Users/xinming/MyProject/ai-is-on/apps/web/src/lib/api.ts`（AiActivity 已含 confidence/verdict）
- 协议（不改）：`/Users/xinming/MyProject/ai-is-on/apps/server/src/claude/protocol.ts:48-59`（复用 mark_done，不新增 CardActionKind 成员）

---

## 11. 实现者复核（main loop，2026-06-18）

对三轮审查的 load-bearing 断点逐条对源码独立复核，全部属实并与我先期独立排查一致：① 回填 `card_action` origin 过 `hasNewExternalEvidenceSince` 回声门（chatConclusion 的 `chat:%` 同理已是先例）；② `kickInvestigation` 是零 import 叶子（`investigationKick.ts`），cardsService 必须调它而非 dispatcher 的 `requestInvestigationSoon`；③ `isStuckDeadEnd` 确无新证据逃生门——这是最致命断点，必修。设计可落地，复用充分。

**首轮实现范围细化（降噪优先）**：P0 升 needhelp 卡**只对 `need_credential` 一类**（最高 ROI = traceID 场景 = 用户真实 badcase 工作流；最具体、最不易误填）。其余 kind（need_decision/need_outbound/owned_by_other/need_info/tool_gap）本轮**解析+校验但不主动升卡**，留 P1-3 放宽。这样无需先做 N=2 计数即把噪声面收到最小。其余 P0-0..P0-8 全部照做（它们是"闭一个完整环"的地基，缺一不转）。
