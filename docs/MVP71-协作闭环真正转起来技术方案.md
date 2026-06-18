# MVP71 — 让「AI 卡住→需要你→你补→AI 接着干」协作闭环**真正转起来** + 可量化

> **实现状态（2026-06-19，全量 780/780 测试过）**：四支柱全落地 + 真实库/真实 UI 验证。
> - **KEYSTONE**（重查读到用户补的内容）：`db.listUserBackfillUnitsForMatter` → dispatcher/debug 透传 `userBackfills` → prompt `<用户补充>` 段。**让已上线的 need_credential 闭环第一次真正可用**（贴 traceID 重查能看到）。
> - **支柱B dangling 真正触发**：`needHelpClassifier.isSelfCommitment`（标题「（对X承诺）」+ executor∈selfSet + owner∈selfSet，稳健 self 集绕开身份碎裂）+ `scanDanglingCommitments` 独立静态扫描（不依赖重查）。**真实库实测：dangling 从历史 0 张 → 3 张 live 卡**（对高虎伟承诺/沙箱Excel/提醒触发器bug）。
> - **支柱C owned_by_other**：`deriveNeedFromUser` 确定性兜底（≤2 具名他人 + 我是 requester + conf≥0.5 + 过滤非人/代词）+ config 默认放开。集成测试确定性升卡。
> - **支柱D 完成度量盘**：`getAiActivityTally` + 面板顶部徽标。**真实 UI 实测**：折叠态「待你 3 件」+ 展开「✅办结0 · 📈推进13 · 🙋待你3 · 🤝已应答1（近7天）」。
> - **降噪闸**：合并「待你处理」配额（needhelp+dangling，默认 3）+ dismiss 后重升冷却（默认 7 天）+ conf≥0.5（否决 v1 降 conf>0）。
> - 未做（按红队建议延后）：owned_by_other 的「帮我起草去问X」draft 按钮（系统卡上下文薄，inline 回填路径已足够且与 KEYSTONE 构成真闭环）。
>
> **命名**：原拟 MVP70，但并行会话已用 MVP70（IM 解析 bug 修复 14cd147 + 感官 tripwire d74e376），故改 MVP71。
> **2026-06-19 诊断重估（证据优先）**：MVP70 的 14cd147 已查实并修复「IM 搜索结果被数成 0 条」的解析 bug——这是历史 52% unknown 的**大半主因**（API 返回 95 条却报 0）。故下方 §1 的 52% 是**修复前**数据，修复后真实 unknown 率会显著下降（修复后尚无新排查样本）。
> **影响**：本方案三根地基**与 unknown 量级无关、与 IM 修复正交**：① KEYSTONE（重查读到用户补的内容，让已上线 need_credential 真正可用，§10.1）；② 修 dangling 真正触发（§支柱B）；③ 完成度量盘（§支柱D）。owned_by_other 收益随 IM 修复缩小，降级为谨慎门控的扩展。与 MVP70 tripwire 不重复（它管"工具坏了"，本方案管"信息真不在 AI 可见范围、需要你补"）。
>
> 状态：**v2 已吸收 3 路对抗审查（降噪/闭环正确性/身份）**，下方 §10 为审查结论与方案修订，§3 起的原始设计请以 §10 修订为准。
> 落点：apps/server（investigation/writeback/matter helper/db/api）+ apps/web（AiActivityPanel）
> 前置：MVP66（无新证据不重查 + 新证据解封）、MVP67（dangling 承诺）、MVP69（needhelp 求助卡 + 闭环 plumbing）
> North Star：**AI 基于可得信息自主帮用户完成的工作量**越多越好。

---

## 0. 一句话

MVP69 把「AI 卡住→求助→你补→自动接着查」的**管道**全建好了，但**真实运行从未转过一次**——求助卡机制是死的。MVP70 用**确定性引擎层兜底**让它真正触发，把 52% 查不清（unknown）里那些「你一句话就能解封/办结」的事浮成可处理的「需要你」，并让「AI 帮你完成了多少 / 还差你什么」可量化可见。

---

## 1. 诊断（全部对真实库 `data/ai-is-on.sqlite` + 源码核实，证据优先）

### 1.1 North Star 现状：过半排查零产出

107 次 `investigation_written_back` 的 verdict 分布：

| verdict | 数量 | 占比 | 对用户的可见价值 |
|---|---|---|---|
| unknown | 56 | **52%** | **零**（不写 summary/nextAction/证据） |
| progressed | 34 | 31% | 进展回执卡 |
| blocked | 11 | 10% | 进展回执卡 |
| resolved | 6 | 5% | 办结提案卡 |

即 **36% 产出可见价值，52% 静默丢弃**。要把 North Star 抬上去，主战场就是这 52%。

### 1.2 协作闭环（MVP69）在真实运行中**从未触发**

- `attention_items` 里 `proposal:matter-needhelp:%` 卡 **仅 1 张**，且是手工 UI 测试那张（`acted`）。**自主运行 0 张**。
- 全库 `runtime_messages` / `task_traces` 里 `needFromUser` 字样 **0 次** → **模型基本不产出 `needFromUser`**。

**根因 1（机制 100% 依赖 LLM 自觉）**：升 needhelp 卡的唯一触发是 LLM 在 conclude 时主动填合法 `needFromUser`。实测模型几乎从不填（prompt 门槛"明确知道缺哪件具体的事"对 unknown 太苛刻；且 unknown 的"缺什么"往往不是缺 traceID）。**违反本仓库铁律——「凡靠 LLM 守的纪律都要在引擎层加确定性兜底」**。

### 1.3 MVP67 dangling「待你处理」卡也**从未触发**

- `proposal:matter-dangling:%` 卡 **0 张**。
- 根因 2（门控字段几乎全空）：`maybeRaiseDanglingCommitment` 要求 `matter.ownerEntityId` 解析 == self，但 **88% 的 open matter（52/59）`owner_entity_id` 为空**；近期 unknown matter 里 13/15 owner 为空。
- 根因 3（self 身份碎裂）：self 配置实体 `5aef…`（larkLocalizedName=**刘昕明**），但 matter 里执行人写成独立实体 `刘昕明`(fdfa，无属性) / `我`(cf8d)，**三者互不 alias**（`entity_aliases` 里 self 零别名）。所以即便 owner 填了 fdfa，`resolveAliased(owner)===5aef` 也为 false。**任何只认单个 self entity_id 的门都形同虚设。**

### 1.4 这 52% unknown 到底卡在什么（读真实 factSummary 归纳）

| 类别 | 占比感觉 | 真实样本 | AI 查不到的原因 | 你能补什么 |
|---|---|---|---|---|
| **A. 你欠的承诺查无跟进** | 大 | "对高虎伟承诺调长授权超时"(conf0.8)、"对陈一柯承诺/new 清理"、"长对话评测集" | 起因已确认，但**根本没有后续证据**（事可能没做/线下做了/已不需要） | 一句话真实状态：**已办结 / 推进中(补一句) / 放下** |
| **B. 进展在他人名下** | 大 | "确认王爽11点前完成测试"、"跟进黄炜深/冼晓东修复排期"、"鲁升纲权限修复进展" | 他人 task/进展 AI 看不到 | **帮你起草去问 X**（draft 不代发）／你直接告诉 AI「X 说了…」→ 自动接着查 |
| C. 缺凭据(traceID) | 小 | "middleware 报错"需 traceID | 没 traceID 无法 run_command 追 | 贴 traceID（MVP69 已设计的 need_credential） |
| D. 真查不到原因 / conf=0 | 中 | "排查器未给出有效动作" | 模型空转/确无线索 | **无**——必须保持静默，绝不升卡 |

**关键洞察**：MVP69 只放开了 C（need_credential，最罕见），而真正的大头 A、B **两条浮出通道（dangling / owned_by_other）都是死的**。所以闭环从不转，52% 一直静默丢弃，North Star 被锁死。

### 1.5 可用信号（确定性分类器的弹药，已核实）

- `matter_entities` 角色齐全：executor 54 / requester 35 / target 34 / about 47 / participant 22。unknown matter 也都挂了（executor 12 / requester 10 / target 7）。
- self 真实身份可得：self 实体 attributes 有 `larkLocalizedName=刘昕明` / `larkOpenId` / email。
- 标题模式强信号：A 类几乎都含 `对{人}承诺`；B 类执行人是**具名他人**（需过滤 lark_task:/http/meego 这类非人实体）。

---

## 2. 目标与硬约束

### 2.1 目标
1. **让闭环真正转起来**：把 A、B 两类 unknown 浮成可处理「需要你」卡，用户补一手 → 复用 MVP69 plumbing 自动接着查 / 办结 / 起草。
2. **可量化可见**：「AI 替你做了什么」面板顶部给出近 7 天 **查清 N · 推进 M · 办结 K · 待你 J** 的完成度量盘，直接回答"AI 帮我完成了多少"。

### 2.2 硬约束（不可违反，继承自 MVP69 + throughput 实测教训）
- ① 对外发送公司禁 AI 代发 → 只 `draft_reply` 起草、用户自己发；
- ② 一切对外/不可逆动作 confirm 门控；④ 投查硬只读；
- ③ 单并发 opencode gate 稀缺 → **零新增 LLM 调用**（分类器是纯函数，搭在已有 conclude 出参上）；
- ⑤ **降噪红线**（throughput 实测：放宽候选会拉高 unknown + 挤兑 gate）：
  - 只在 `conf>0`（真查过）时考虑升卡；conf=0「排查器未给出有效动作」一律静默；
  - 确定性分类**高精度优先**——signal 不明确就返回 undefined、不升卡；
  - 沿用 N=2 防焦虑闸、幂等去重、dismiss 豁免 not_relevant。

---

## 3. 设计（四根支柱）

### 支柱 A — 确定性 `needHelpClassifier`（引擎层兜底，零 LLM）

**新模块** `apps/server/src/investigation/needHelpClassifier.ts`，纯函数、无副作用、可单测：

```ts
// 1) 稳健 self 身份集（绕开身份碎裂根因 3）
export function getSelfEntityIds(): Set<string> {
  // self_person_entity_id（resolveAliased）∪ 所有 alias_of==self 的 ∪
  // 所有 type=person 且 name===self.larkLocalizedName 的 ∪ name==='我' 的 person
  // 结果缓存（settings/实体表低频变化），由 entity_aliases/实体变更失效。
}

// 2) 是否具名他人（过滤非人实体）
function isNamedOtherPerson(entityId, name, selfSet): boolean {
  // type==='person' && !selfSet.has(resolveAliased(id)) &&
  // name 非空 && !/^(lark_task:|https?:|.*larkoffice|.*feishu\.cn\/)/.test(name)
}

// 3) 兜底推导 needFromUser（仅当 LLM 没给合法的）
export function deriveNeedFromUser(
  matter: Matter,
  conclusion: { verdict; confidence; factSummary },
  ctx: { entities: Array<{id,name,type,role}>; selfSet: Set<string> }
): NeedFromUser | undefined {
  if (!(conclusion.verdict === 'unknown' || conclusion.verdict === 'blocked')) return undefined;
  if (conclusion.confidence <= 0) return undefined;           // conf=0 静默（降噪红线）

  // B 类：进展在具名他人名下 → owned_by_other（高精度：executor 是具名他人 + 我不是 executor）
  const execOthers = ctx.entities.filter(e => e.role === 'executor' && isNamedOtherPerson(e.id, e.name, ctx.selfSet));
  const iAmExecutor = ctx.entities.some(e => e.role === 'executor' && ctx.selfSet.has(resolveAliased(e.id)));
  if (execOthers.length && !iAmExecutor) {
    const who = execOthers.map(e => e.name).slice(0, 2).join('、');
    return { kind: 'owned_by_other', ask: `这件事的进展在 ${who} 名下，我查不到。要我帮你起草一句去问 ${who}，还是你已经知道结果了？` };
  }
  return undefined; // A 类（你欠的承诺）交给 dangling（支柱 B），其余静默
}
```

- **为何 A 类不走 needhelp 而走 dangling**：A 的最佳动作是「办结/放下/我补一句」（dangling 卡动作组天然吻合），不是「补凭据让 AI 接着查」。职责清晰：needhelp=「补一手 AI 接着查」，dangling=「你欠的事，你来裁决」。
- **为何 need_credential 不做确定性兜底**：缺哪条 traceID 引擎无从得知，只能靠 LLM 具名 → 保留 LLM 通道（MVP69 已有），不强兜。

### 支柱 B — 修复 dangling **真正触发**（A 类头号 unknown 模式）

改 `maybeRaiseDanglingCommitment`（investigationWriteback.ts），把"是不是你欠的承诺"判定从**只认空的 owner_entity_id** 换成**双信号高精度判定**：

```ts
function isSelfCommitment(matter, selfSet): boolean {
  // 信号1（最强、无需身份解析）：标题含「对{1..12字}承诺」 → 你显式承诺给某人的事
  if (/对.{1,12}承诺/.test(matter.title)) return true;
  // 信号2：matter_entities 里 executor ∈ selfSet（稳健 self 集，非空 owner_entity_id）
  if (matterExecutorIds(matter.id).some(id => selfSet.has(resolveAliased(id)))) return true;
  // 兼容旧门：owner_entity_id 解析 == self
  if (matter.ownerEntityId && selfSet.has(resolveAliased(matter.ownerEntityId))) return true;
  return false;
}
```

- 其余门不动：`conf>0`、够旧（overdue 或 创建满 `investigationDanglingMinAgeMs`，默认 3 天）、无在场 resolve/progress/needhelp 提案（helper 内已兜）。
- **互斥**：B 类（self 承诺）若**同时**被分类器误判出 owned_by_other（不会，因 iAmExecutor 互斥），以 dangling 为准；needhelp 顶 dangling 的现有顺序不变。
- 效果：让 "对高虎伟承诺"、"对陈一柯承诺" 这类**显式自我承诺**的 unknown 终于浮成「待你处理」卡（我来跟进 / 标记办结 / 不再跟进）——这是把"查无跟进"转成"你一键办结=一次完成"的关键。

### 支柱 C — writeback 分流接入确定性 derive + 放宽 `owned_by_other`

`investigationWriteback.ts` 的 needhelp 分支（:165-179）改为：

```ts
const need = isValidNeedFromUser(c.needFromUser)
  ? c.needFromUser
  : deriveNeedFromUser(matter, c, { entities, selfSet });   // ★ 兜底
... else if (
  (c.verdict==='blocked'||c.verdict==='unknown') && c.confidence>=0.5 &&
  config.investigationNeedHelpEnabled && isValidNeedFromUser(need) &&
  config.investigationNeedHelpKinds.includes(need.kind)
) { raiseMatterNeedHelpProposal(proposalMatter, { needFromUser: need, factSummary, evidence }); }
```

- **config 放宽**：`investigationNeedHelpKinds` 默认从 `['need_credential']` → `['need_credential','owned_by_other']`。其余 kind（need_decision/need_outbound/need_info/tool_gap）仍只解析不主动升卡（留后续按填充率放宽）。
- **owned_by_other 卡动作组**（attentionProjection 按 kind 分支）：
  - 「帮我起草去问 X」→ 复用 `draft_reply`（AI 起草、你自己发，绝不代发）；
  - inline「我知道了，对方说…」→ 走 mark_done needhelp 支路落 card_action 证据 → 自动接着查（确认/办结）；
  - 「不用了」→ dismiss 豁免 not_relevant。

> ⚠️ 待审查确认点：分流里 `confidence>=0.5` 这道闸对 owned_by_other 是否合理。owned_by_other 的价值不依赖"对 verdict 把握"，低 conf 的 unknown（查了一圈确认查不到）恰恰最该升。倾向：**owned_by_other 走 `conf>0` 即可，不卡 0.5**（need_credential 维持 0.5）。见 §6 审查项。

### 支柱 D — 完成度量盘（透明 + 回答"有多少"）

- 后端 `GET /api/ai-activity` 响应加 `tally` 字段：近 7 天确定性统计
  ```ts
  tally: {
    resolvedCount,    // matter_auto_resolved + 用户确认 resolve 提案（实际办结）
    progressedCount,  // investigation_written_back verdict∈{progressed} 去重 matter
    needYouLiveCount, // 当前在场 needhelp+dangling 卡数（待你补）
    answeredCount,    // 近7天 needhelp/dangling 被 acted（你补了一手）
  }
  ```
  全部来自 `audit_logs` / `attention_items` 确定性聚合，零 LLM、零新表。
- 前端 `AiActivityPanel.tsx` 头部一行徽标：「近 7 天 AI 替你：**查清 N · 推进 M · 办结 K** ｜ 待你 **J** 件」。点"待你"滚动到「需要你帮忙」区。
- 价值：直接量化 North Star（用户一眼看到"AI 帮我完成了多少"），并把"待你"做成召唤行动（提高 needhelp/dangling 应答率 = 闭环转化率）。

---

## 4. 端到端闭环（MVP70 后）

```
runInvestigation → conclude{verdict, conf, factSummary, evidence, needFromUser?}
        │
applyInvestigationResult 分流（resolve > needhelp > progress > dangling）
        │
  ┌─────┴───────────────────────────────────────────────┐
resolved          unknown/blocked, need = LLM需要 ?? derive(兜底)
高置信→办结     ┌────────────┴──────────────┐
              owned_by_other(具名他人)    A类:你欠的承诺(标题对X承诺/exec=self)
              → 🙋needhelp 卡             → 修好的 dangling「待你处理」卡
                · 帮我起草去问X(draft)       · 我来跟进(inline补一句→证据→重查)
                · 我知道了:对方说…(→重查)    · 标记办结(=一次完成✓)
                                            · 不再跟进(drop)
        │
   用户补一手 → mark_done/needhelp 支路 → card_action 证据 → kickInvestigation
        │
   下一 tick 自动重查（MVP66 新证据解封 + MVP69 三道 skip 门全放行）
        │
   AI 带你补的信息再 conclude（unknown→progressed/resolved 的转化率↑ = North Star↑）

  面板顶部：近7天 查清N·推进M·办结K ｜ 待你J  ← 实时量化
```

---

## 5. 实现落点（绝对路径）

- **新增** 分类器：`apps/server/src/investigation/needHelpClassifier.ts`（getSelfEntityIds / isNamedOtherPerson / deriveNeedFromUser，纯函数）
- 分流接 derive + owned_by_other：`apps/server/src/investigation/investigationWriteback.ts`（:165-193）
- dangling 触发修复：同上 `maybeRaiseDanglingCommitment`（:210-222，加 isSelfCommitment）
- config 放宽：`apps/server/src/config.ts`（:204 investigationNeedHelpKinds 默认加 owned_by_other）
- owned_by_other 卡动作组：`apps/server/src/attention/attentionProjection.ts`（needhelp 前缀按 kind 分支，draft_reply + inline）
- 度量盘后端：`apps/server/src/db.ts`（listAiActivity 旁加 getAiActivityTally）+ 路由 `routes/aiActivity.ts`
- 度量盘前端：`apps/web/src/components/AiActivityPanel.tsx`（头部徽标）+ `apps/web/src/lib/api.ts`（类型）
- 取 matter 实体：复用既有 `listMatterEntities`/matterStore 查询（核实后用现成件）

---

## 6. 待对抗审查的高风险点（自陈，供 red-team 攻）

1. **self 身份集精度**：`name==='刘昕明'` 匹配可能误纳同名他人 / 漏掉别名。是否够稳？是否该只用 larkOpenId 当锚？（fdfa 无 openid，只能靠 name）
2. **owned_by_other 误升**：执行人是具名他人但其实**事已完成只是 AI 没搜到**→ 升卡打扰。conf 门怎么设才平衡漏报/误报？factSummary 是否要含"未查到对方进展"才升？
3. **A/B 分类互斥是否真互斥**：一件事既挂 self executor 又挂他人 executor（如 middleware：exec 徐礼杰+鲁升纲，无 self）会落到哪类？多 executor 怎么裁。
4. **标题 `对X承诺` 正则**：会不会误命中（"反对X承诺的做法"之类）？是否过宽。
5. **降噪红线**：A+B 同时放开后，52% 基数 × 命中率会不会刷屏？N=2 闸是否够（needhelp 和 dangling 各自计数还是合并计数）。
6. **闭环 owned_by_other 半环**：用户"帮我起草去问 X"后，AI 仍查不到对方进展（draft 是给用户发的，对方回了也未必进 IM 被采到）→ 会不会反复升同一张卡？幂等键够不够。
7. **度量盘口径**：resolvedCount 把 auto_resolved + 用户确认提案都算，会不会重复计数同一 matter。
8. **回归**：derive 兜底会不会让原本静默的大量 unknown 突然升 progress/dangling，冲击收件箱？需灰度/开关。
9. **零新 LLM 调用核实**：getSelfEntityIds 每次 writeback 查实体表，性能/缓存。

---

## 7. 验收标准

- **闭环真转**：构造（或在真实库回放）一件 A 类（标题"对X承诺"unknown conf>0）→ 出 dangling 卡；一件 B 类（exec 具名他人 unknown）→ 出 owned_by_other needhelp 卡。两类都能：用户补一手 → 落 card_action → 下一 tick 自动重查。
- **降噪达标**：conf=0 不升；具名他人信号不明确不升；同 matter 不双卡；dismiss 不学负反馈；N=2 闸生效。
- **可量化**：面板头部显示近 7 天 查清/推进/办结/待你 四个数，与库内确定性聚合一致。
- **零回归**：全量测试通过；无新增 LLM 调用；无对外动作触发。
- **量化提升（实测后）**：dangling/owned_by_other 卡的应答率 + 应答后重查的 unknown→progressed/resolved 转化率，对比 MVP70 前的"静默丢弃 0"。

---

## 8. 单测清单

1. getSelfEntityIds：含 5aef + name==刘昕明(fdfa) + 我(cf8d)；不含无关他人。
2. isNamedOtherPerson：person+具名他人=true；lark_task:/http/meego/self=false。
3. deriveNeedFromUser：B 类(exec 他人,我非exec,conf>0)→owned_by_other；conf=0→undefined；我是 exec→undefined；无具名他人→undefined。
4. isSelfCommitment：标题"对高虎伟承诺"=true；exec∈selfSet=true；纯他人=false。
5. dangling 触发：A 类 unknown conf>0 够旧 → 升 dangling（owner_entity_id 为空也触发）。
6. 分流：LLM 无 needFromUser 但 derive 出 owned_by_other → 升 needhelp(owned_by_other)；不撞 progress。
7. config 门：owned_by_other 不在 kinds 时不升；在时升。
8. 互斥：同 matter 不同时 dangling + needhelp（needhelp 顶 dangling）。
9. 度量盘聚合：构造若干 audit/卡 → tally 四个数正确、不重复计数。
10. 回归：conf=0 unknown 仍静默；progressed≥0.6 仍走 progress；resolved 高置信仍走 resolve/auto。

---

## 9. 关键复用点（避免新造）

| 能力 | 复用 | 路径 |
|---|---|---|
| 求助卡内核 + 顶替 + 防焦虑闸 | raiseMatterNeedHelpProposal / countLiveNeedHelpProposals | matterResolveProposal.ts:131 / db.ts |
| dangling 卡 | raiseMatterDanglingCommitmentProposal | matterResolveProposal.ts:108 |
| 回填→证据→重查闭环 | mark_done needhelp 支路 + kickInvestigation + hasNewExternalEvidenceSince | cardsService.ts / db.ts |
| self 身份/属性 | self_person_entity_id 设置 + parsePersonAttributesFromRow(larkLocalizedName) | selfProfile.ts |
| 别名解析 | resolveAliased | entityResolver.ts:22 |
| 起草不代发 | draft_reply | cardsService.ts |
| 活动流 | listAiActivity + AiActivityPanel | db.ts:2430 / AiActivityPanel.tsx |
| needFromUser 校验/类型 | isValidNeedFromUser / NeedFromUser | investigationPrompt.ts:73 |

---

## 10. 对抗审查结论与方案修订（v2，全部对源码亲自复核）

3 路红队（降噪/闭环正确性/身份精度）+ 实现者对源码独立复核。结论：**方向对，但 v1 有一个致命错误（闭环是假的）+ 一组降噪闸缺口**，全部修法已并入下方 v2 设计。

### 10.1 🔴 致命发现（基石）：v1 的协作闭环是**假闭环**——重查读不到用户补的内容

**已亲自核实的决定性链路**：
- `cardsService.ts:429-450`：用户补一手 → 落 `silent` unit + `attachMatterContextLink({effect:'no_change'})`。
- `investigationWriteback.ts:98`：`currentSummary` **仅 meaningful（resolved/progressed/blocked）时更新**，`no_change` 回填**不进 summary**。
- `investigationDispatcher.ts:238-248`：重查 `runInvestigation` 入参只有 `currentSummary/nextAction/entities`，**完全不读 matter 挂的 card_action 证据 unit**。
- `db.ts:hasNewExternalEvidenceSince:3037`：只返回 boolean（有无新证据 → 触发解封），**不搬运内容**。

→ **结论**：MVP69 的 plumbing 只做了"解封"半环，"把用户补的内容喂回 AI"这半环**从来不存在**。所以 need_credential（已上线）和 owned_by_other **都是假闭环**：解封重查后 AI 手里信息和上次一模一样 → 必然再 unknown → 还撞 isStuckDeadEnd ×4 退避。**MVP69 自主卡 0 张正坐实了这点**（即便升了卡、用户答了，也查不清）。

**修法（v2 P0-KEYSTONE，必须最先做）**：让重查真正读到用户补的内容。
- 新增 `db.listUserBackfillUnitsForMatter(matterId, sinceIso?)`：`matter_context_links ⋈ context_units WHERE origin_kind='card_action' AND status='active'` 取内容（按时间倒序，≤5 条，clip）。
- `investigationDispatcher` 派发时调它 → 新参 `userBackfills: string[]` 传入 `runInvestigation`。
- `investigationPrompt.buildInvestigateUserMessage` 渲染 `<用户补充（务必据此重新判断）>` 段，并在判定纪律里加："用户已就此补充信息，请优先据此 conclude（如对方已确认完成 → resolved；给了 traceID → 用 run_command 追）。"
- 这一条让**已上线的 need_credential 也第一次真正可用**，是整个 MVP70 的地基。无它，其余全是镀金。

### 10.2 🔴 降噪闸缺口（红队1，全部已用 SQL 实测）

- **P0-1 dangling 无全局上限**：`countLiveNeedHelpProposals`(db.ts:2968) 只 `LIKE needhelp`，**dangling 不计数、无 MaxLive**。而本方案主力放开的恰是 dangling（A 类）。实测 3 个"对X承诺"matter 6 天龄、零在场卡 → 可同 tick 一起冒。
  - **修法**：新增 `countLivePendingUserProposals()` = needhelp + dangling 合并计数；dangling 与 needhelp **共享同一"待你处理"配额**（默认上限提到 3），一把闸管两条通道。
- **P0-2 owned_by_other 不可降到 conf>0**：实测低 conf 候选（c70abecf conf0.35 被查10次、7314a289 conf0.25）正是信噪比最差的反复空查件。**v2 否决 v1 §6.4，owned_by_other 维持 conf≥0.5**。
- **P0-3 dismiss 后可重升（幂等失效）**：`hasLiveProposal` 只查 `status='live'`，dismiss→下轮 unknown 会重升同卡。
  - **修法**：升 needhelp/dangling 前查 `attention_interactions` —— 该 matter 的同类卡近 `pendingReRaiseCooldownDays`(默认7) 天内被 dismiss 过 → 不重升（复用 MVP 既有 dismiss 抑制范式）。
- **P1-1 群事项误升**：`7314a289` 挂 12 个具名他人 executor → owned_by_other 会"帮你问孔恩培、向李晗璐"，纯打扰。
  - **修法**：owned_by_other 加 **具名他人 executor 数 ≤ 2** 精度门（>2 视为群/分发事项，静默）。

### 10.3 🟠 owned_by_other 的真实形态（红队2 S1+S2）

- 有了 §10.1 基石后，owned_by_other **变成真闭环**：用户 inline「对方说…」→ 落 card_action → 重查读到 → AI 据此 conclude progressed/resolved。
- draft「帮我起草去问X」(S2)：系统卡 signalIds/relatedEntityIds 空 → 起草上下文薄。**修法**：升 owned_by_other 卡时把具名他人 entityId 填进 `relatedEntityIds`（raiseMatterNeedHelpProposal 扩参），让 draft 至少知道"问谁"；matter 的 currentSummary（含 AI 排查发现）经 buildRichAskAgentPrompt 也会进 draft，够起草"想问下{X}，关于{事}进展如何"。不过度投入。

### 10.4 🟠 路径/复用订正（红队2 S3+S4）

- `selfProfile.ts` 在 `apps/server/src/context/`（非 matter/）；`parsePersonAttributesFromRow` 在 `context/personAttributes.ts`（已核实能取 larkLocalizedName）。
- `listMatterEntities`(matterStore.ts:373) 只返回 `{entityId, role}`，**不带 name/type** → deriveNeedFromUser 需 join `getContextEntityById`（复用 dispatcher `buildEntities:204-212` 现成模式）。
- `attentionProjection` 的 needhelp 动作组现**写死 mark_done/dismiss、不分 kind** → 按 kind 投影 owned_by_other 的 draft+inline 是**新代码**（§9 误标为"复用"，订正）。
- ✅ 成立的复用：mark_done needhelp 支路对任意 needhelp 前缀生效（落证据+解封 OK）；三道 skip 门对 owned_by_other 与 need_credential 一致放行；A 类 dangling「我来跟进」走 ack（不重查，用户裁决），是**天然真闭环**。

### 10.5 身份精度（红队3，结论并入）

`getSelfEntityIds()` 稳健集 = `resolveAliased(self_person_entity_id)` ∪ {alias_of==self} ∪ {type=person 且 name===self.larkLocalizedName} ∪ {type=person 且 name==='我'}。以 larkOpenId/email 为最强锚优先；name 匹配做兜底（同名他人风险低但存在 → 仅用于"是不是我"的宽判，不用于"是不是他人"的严判，二者不对称：owned_by_other 的"具名他人"必须 `!selfSet.has(...)` 且过滤非人 name）。`resolveAliased` 对无别名 id 返回自身（已核实 entityResolver.ts:22）。详细精度结论以 §11 身份红队回执为准。

### 10.6 修订后实现顺序（每步独立可测可验、可灰度）

1. **P0-KEYSTONE**：重查读到用户补的内容（§10.1）—— 让已上线 need_credential 先真起来。
2. **P0-A 修 dangling 触发**（A 类真闭环，最低风险最高确定性收益）+ §10.2 降噪闸（合并配额/重升冷却）。
3. **P0-B owned_by_other**（§10.3，依赖 1 才成真闭环）+ 精度门（≤2 人、conf≥0.5、过滤非人）。
4. **P1 完成度量盘**（§3 支柱D，透明 + 量化 North Star）。

每步：纯函数单测 + 真实库回放 + dev 端到端验证（不靠猜）。default 开关可灰度（owned_by_other 一类可单独 config 关）。

---

## 11. 身份红队（重跑）结论 + 最终实现决策（v3 定稿）

### 11.1 🔴 S3（致命·真因修正）：dangling 浮出被错误耦合在「重查」上

**已亲自核实**：3 件「对X承诺」matter 的 `owner_entity_id` **就是 self(5aef)**、6 天龄、dangling 默认开——按现有 `maybeRaiseDanglingCommitment` 本该出卡，却 0 张。真因（git+audit 实证）：
- MVP67(dangling) 于 **2026-06-18 13:58** 提交；这 3 件最后一次排查是 **2026-06-16 21:20**（unknown conf 0.6/0.8）。
- dangling 代码出生时它们已被 MVP66「无新外部证据不重查」+ isStuckDeadEnd 门**永久停查**，此后 `maybeRaiseDanglingCommitment` 从未在 dangling 代码存在的情况下被调用。
- **即：浮出 stuck 件的逻辑只在「又跑了一次排查得 unknown」时触发，而 stuck 件恰恰被正确地不再排查。** 改 isSelfCommitment 判定函数对此无效——触发入口根本不命中。

**最终修法（支柱B 重定义）**：新增**独立静态扫描** `scanDanglingCommitments()`（纯确定性、零 LLM、零 gate），在 dispatcher tick 末尾低频调用：
```
对每个 open/in_progress matter：
  isSelfCommitment(matter, selfSet)            // 标题（对X承诺）锚定 + executor∈selfSet + owner∈selfSet
  && 够旧（overdue 或 age≥investigationDanglingMinAgeMs）
  && 最近有过 unknown/blocked 排查（AI 试过查不清，getRecentInvestigationVerdicts）
  && 无在场 resolve/progress/needhelp/dangling 提案
  && 未在 pendingReRaiseCooldownDays 内被 dismiss 过
  → raiseMatterDanglingCommitmentProposal（受合并「待你处理」配额约束）
```
保留 writeback 内的 maybeRaiseDanglingCommitment（新鲜 unknown 即时升），静态扫描兜住"停查后才出生/停查后才够旧"的存量——两者幂等键一致、不双升。

### 11.2 🔴 S1（身份取数）：localizedName 必须取 `attributes.larkLocalizedName`，不是 `entity.name`

self 实体 `5aef` 的 `name` 是占位符 `用户df5b5e`，真实姓名「刘昕明」只在 `attributes.larkLocalizedName`（已核实 `parsePersonAttributesFromRow` 能取出）。`getSelfEntityIds` 必须：
```
selfId = resolveAliased(self_person_entity_id)
localizedName = parsePersonAttributesFromRow(getContextEntityById(selfId))?.larkLocalizedName   // ←「刘昕明」
selfSet = {selfId} ∪ {alias_of==selfId} ∪
          {type=person 且 name===localizedName 且 (无 openid 或 openid==self.openid)}    // ★防同名他人：候选有不同 openid→剔除
          ∪ {type=person 且 name==='我'}
```
实测：name='刘昕明' 的 person 仅 1 个(fdfa,无 openid→纳入)、name='我' 仅 1 个(cf8d)、无同名他人。openid 防撞名守卫为未来同名同事兜底。模块级缓存，settings/entity 变更失效。

### 11.3 🔴 S2（owned_by_other 误升）：≤2 具名他人 + self 必须是 requester

12 人「Badcase 收集群」、3 人提测、多人评审 matter 的 executor 全是具名他人且 self 不在场——v1 会误升 owned_by_other（"帮你问何志斌、卢俊杰"，荒谬）。最终门：
```
execOthers = executor 中的具名他人（isNamedOtherPerson）
iAmExecutor = executor 中有 self
iAmRequester = requester 中有 self                        // ★ 只有「我委派出去」的才归我催
升 owned_by_other 仅当：
  1 ≤ execOthers.length ≤ 2                               // ★ ≥3 视为群/评审，静默
  && !iAmExecutor && iAmRequester
  && conf ≥ 0.5（红队1 P0-2：维持，不降 conf>0）
```
`isNamedOtherPerson`：主过滤 `type==='person'`（实测 executor 全是 person，URL/lark_task 正则纯防御）+ 名长 2-12 + 排除代词（对方/他/她）。

### 11.4 S4 标题正则收紧：`/[（(]对([^）)]{2,6})承诺[）)]/`（括注锚定，挡 反对/针对/对接…承诺）。标题信号错了还有 executor∈selfSet / owner∈selfSet 两路冗余兜底。

### 11.5 最终实现顺序（v3）
1. **KEYSTONE**（§10.1）：重查读到用户补的内容 → 让已上线 need_credential 真起来。**最高杠杆、与一切正交、先做。**
2. **支柱B（静态扫描版，§11.1）** + `getSelfEntityIds`（§11.2）+ 合并「待你处理」配额 + 重升冷却（§10.2）。
3. **完成度量盘**（§支柱D）。
4. **owned_by_other**（§11.3 严格门控；收益随 IM 修复缩小，放最后、可单独 config 关）。

每步：纯函数单测 + 真实库回放/端到端验证。
