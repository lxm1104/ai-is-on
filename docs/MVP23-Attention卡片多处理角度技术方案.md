# MVP23 — Attention 卡片「多处理角度」技术方案

> 状态：草案 **v2**（已对照最新工作区代码核对，可开工）
> 作者：刘昕明 + Claude
> 日期：2026-06-03

> **v2 变更**（基于三轮 review）：
> 1. rebase 到工作区未提交的「S# 引用编号重构」+「MVP5 飞书任务 slice」之上（§0.5）；
> 2. 落库/反序列化插入点精确到 `attentionStore` 真实函数，纠正 v1 指错层的问题（§5.3）；
> 3. directive 强约束为自包含自然语言、禁含 S#（§6）；
> 4. 角度生成成本门槛（只对 P0/P1 生成）从「可选」升为「定稿」（§6.1 / §11）；
> 5. 与 MVP22 的关系改为排期问题（MVP22 尚未实现）（§0.5 / §3.3）；
> 6. 前端 acked 态按钮收敛、「更多」工作量、密度处理（§8）。

---

## 0. 背景与现状（Problem）

「待处理」模块里每张 attention 卡片，无论内容是什么，前端拿到的动作都是 [attentionProjection.ts:66](../apps/server/src/attention/attentionProjection.ts#L66) `defaultAttentionActions()` 写死的同一组：

| 按钮 | kind | 作用 |
|---|---|---|
| 知道了 | `ack` | 标记已读 |
| **让 AI 处理** | `ask_agent` | 把卡片背景塞给右侧 Claude——**只有一种万能处理方式** |
| 忽略 | `dismiss` | 降权 + 不再提醒 |

「让 AI 处理」点下去，跑的是 [askAgentPrompt.ts:27](../apps/server/src/attention/askAgentPrompt.ts#L27) 那一句固定开场白——「给出下一步建议或帮我做必要的查询/起草」。**一个万能 prompt，不区分处理角度。**

问题：同一张待处理卡，对一条「@我未回」的消息，用户可能想「起草回复」，也可能想「先把长对话总结一下再决定」，还可能想「转成任务」。现在把这些角度全压成一个按钮，用户每次都要在右侧自己补打字说明意图。

### 0.1 现状里已有的「角度」雏形

系统其实**已经在判断「这事该用哪种能力跟进」**，写在 attention item 的 `recommendedAgent` 字段。注意一处**既有不一致**：

- prompt 铁律 7 实际只列 **5** 个取值：`prepareMeeting | commitmentDigest | recapActionItems | caring | syncDraft`；
- 而 parse 白名单 `ALLOWED_AGENTS` 有 **6** 个（多一个 `docComment`）。

这个字段现在**只被用来给那个唯一的 prompt 加一行「系统建议调用 X 能力」**（[attentionProjection.ts:102](../apps/server/src/attention/attentionProjection.ts#L102)）。本方案把这个「engine 已经在做的处理判断」**放大成结构化的多角度按钮**。

### 0.5 与在途改动 / MVP22 的关系（**开工前必读**）

本方案 rebase 到**工作区当前未提交的两批改动**之上，它们改了 MVP23 依赖的输出契约：

1. **「S# 引用编号」重构**（`attentionPrompt.ts`）：
   - packet 每条记录行首带 `[S3]` handle；LLM 的 `signalIds` 等输出填 `["S3","S7"]` 而非真实 id；
   - `buildAttentionUserMessage` 签名变为返回 **`{ message, refs }`**；
   - engine 在 parse 后用 `resolveAttentionRefs(items, refs)` 把 S# 反查真实 id。
   - **对 MVP23 的影响**：见 §6。`resolveAttentionRefs` 只处理 4 个 ref 字段、**不碰 `processingOptions`**，所以 directive 必须是自包含自然语言（禁含 S#），否则会把生字符串泄漏给执行端。
2. **MVP5 飞书任务 slice**：新增 `packet.tasks` + `<tasks>` 块（飞书原生 todo，独立于 commitment）。**这是一类新卡源，且是多角度的好素材**（见 §1）。

3. **MVP22（Live 卡就地刷新）尚未实现**（仓库只有草案文档，无 `attentionStaleness.ts`）。因此两者是**排期问题**而非即时冲突：
   - 建议 MVP22 先落（修更基础的 bug）；
   - MVP22 的 **Tier-2 代码兜底**（机械追加 signalId、不重发 LLM）刷新一张 live 卡时，**不会重算角度**。届时在 Tier-2 兜底处加一行：**把该卡 `action_options_json` 清成 `null`**（退回单按钮），比留着滞后角度更诚实，几乎零成本。

---

## 1. 适用卡源与角度示例

| 卡源（recommendedAgent / slice） | 适配 | 角度举例 |
|---|---|---|
| 会议类 prepareMeeting | ★★★ | 备发言要点 / 拉历史背景 / 起草同步 |
| @我未回（im + commitmentDigest）| ★★★ | 起草回复 / 梳理要点 / 拟成待办 |
| 承诺/进度 commitmentDigest | ★★★ | 起草进度同步 / 拆成待办 / 催办协作人 |
| 纪要待办 recapActionItems | ★★★ | 提取行动项 / 拟成任务 / 同步团队 |
| **飞书任务（MVP5 `<tasks>`）** | ★★★ | 拆解子任务 / 起草进度 / 催办相关人 |
| 文档评论 docComment | ★★ | 起草回复 / 总结争议点 |
| 同步/周报 syncDraft | ★★ | 起草内容 / 汇总进展 |
| 人际关怀 caring | ★ | 保持单按钮 |
| P3 / 无 recommendedAgent | ✗ | 单按钮 |

---

## 2. 目标与非目标

### 2.1 目标
- **G1**：卡片出现 2–3 个由 AI 针对真实内容生成的处理角度按钮，点击即把该角度交给右侧 Claude。
- **G2（LLM 生成，非查表）**：角度由 attention LLM 在同一次推理里产出，能利用全局上下文（其他承诺、用户偏好）给跨卡片角度。
- **G3（零回归 / 优雅降级）**：角度缺失/坏/空 → 卡片退回单按钮，**item 本身绝不受影响**。
- **G4（不动执行通道）**：复用既有 `ask_agent` 状态机、`sendTopicMessage`、`recordAttentionInteraction`。

### 2.2 非目标
- 不做结构化写操作（「拟成待办」v1 仍是出文本草稿，不真建任务）；结构化执行器留 M2。
- 不做偏好学习闭环（埋点先留，M3）。
- 不改去重 / supersede / TTL / cache。
- 不给 P3 / 无 recommendedAgent 卡硬凑角度。

---

## 3. 关键决策：角度在哪一层生成（in-tick）

### 3.1 三候选
| 候选 | 做法 | 结论 |
|---|---|---|
| **① in-tick（选中）** | 扩 attention LLM 输出 schema，每个 item 多吐 `processingOptions` | ✅ 最省 token、质量最高、实现面最小 |
| ② 后置 pass | 独立模块对每张卡再跑一次 LLM | ❌ 总成本更高、上下文更少、两段式复杂 |
| ③ 渲染时懒生成 | 卡片渲染才生成 | ❌ 列表 N 张并发；加缓存即退化成② |

### 3.2 为什么 in-tick 优于后置 pass
1. **成本**：in-tick 复用 engine 本来就在进行的深度推理，只增量多吐 output token，**无新调用**；后置 pass 每卡一次新调用且要**重喂展开上下文**（最贵的 input token）。
2. **质量**：engine 那次手握**完整 packet**（spaces / commitments / tasks / **preferences**），能产跨卡片、懂偏好的角度；后置 planner 只看单卡。
3. **职责边界**：engine **现在就在吐 `suggestedAction` / `recommendedAgent`**，「怎么处理」这条边界早跨过；`processingOptions` 是其结构化演进，非平行新概念。
4. **新鲜度**：`directive` 只命名角度、**不嵌内容**；执行时 `buildRichAskAgentPrompt` 仍实时拉最新 ContextUnit。即「tick 时定角度 + 点击时喂新鲜内容」。
   - 例外：MVP22 Tier-2 就地刷新不重算角度 → 按 §0.5 在兜底处清空 options 退单按钮。
5. **复杂度**：in-tick **不需要**新模块/排队/二次 broadcast/新 agent 配置；落库只是在 store 多写一列（见 §5.3）。

### 3.3 in-tick 的唯一真实代价 & 去风险
代价：要动 `ATTENTION_SYSTEM_PROMPT` 与 `AttentionLLMItem` 输出契约（系统最金贵、测试最多的 prompt）。但**团队刚刚就在主动扩这个 schema**（加 S#、加 tasks），证明这是被认可的演进方式。去风险：
- `processingOptions` schema 严格可选，**逐字段降级**：坏字段 → 丢字段、**不伤 item**。
- `directive` 短、只命名角度，控膨胀也控 staleness。
- 角度生成成本门槛：**只对 P0/P1 的 item 生成角度**（§6.1）。
- 角度指令放 system prompt 靠后、不抢核心注意力；上线前用真实卡片肉眼验。

---

## 4. 设计总览

```
runAttentionTick  (attentionEngine.ts — 持久化路径零改动)
 ├─ buildAttentionUserMessage → {message, refs}     (现状，已是 S# 制)
 ├─ runOneShot(ATTENTION_SYSTEM_PROMPT)             ← ⟳ prompt 末尾新增「角度生成」指令（仅 P0/P1）
 ├─ resolveAttentionRefs(parseAttentionOutput(...)) ← ⟳ parse 的 coerceItem 加 processingOptions 解析
 │                                                     resolveAttentionRefs 的 {...it} 自动保留新字段（零改）
 └─ insertAttentionItem({ llmItem })                ← engine 透传 llmItem，零改
        │
        ▼ (attentionStore.insertAttentionItem)      ← ⟳ row 多写 action_options_json
   attentionProjection.defaultAttentionActions(item)← ⟳ 读 actionOptions 出多按钮（2 直出 + 更多）
        │ card.actions
        ▼
   前端 SignalCard.tsx                              ← ⟳ 多 ask_agent 按钮：前 2 直出、第 3+ 收「更多」
        │ 点角度 → onAction(cardId, 'opt:<oid>', {extraPrompt?})
        ▼
   cardsService.applyAttentionAction()              ← ⟳ ask_agent 分支按 oid 查回 directive
     prompt = buildRichAskAgentPrompt(attn)
            + "\n【本次处理角度（请只做这一件）】" + option.directive
            + (extraPrompt ? "\n【用户补充】"+extraPrompt : "")
```

**角度与 item 同生同灭**：同一次 LLM 调用产出、同一行 insert、同一张卡 supersede 时作废。无两段式、无二次 broadcast。

---

## 5. 数据模型与迁移

### 5.1 类型（attentionTypes.ts）
```ts
export type ProcessingOption = {
  id: string;          // 卡内稳定标识，如 'draft_reply' | 'summarize' | 'to_task'
  label: string;       // 按钮文案，≤6 字，如 '起草回复'
  directive: string;   // 执行时拼进 rich prompt 的角度指令（后端持有，前端拿不到）
};
// AttentionLLMItem（LLM 直出）新增可选：
processingOptions?: ProcessingOption[];
// AttentionItem（持久化领域型）新增：
actionOptions: ProcessingOption[] | null;   // null = 未生成 / 已降级；禁止存 []
```

### 5.2 DB（db.ts）
迁移机制**已确认**：项目用幂等 helper `ensureColumn(table, column, ddl)`（[db.ts:401](../apps/server/src/db.ts#L401)，`PRAGMA table_info` 探测列缺失才 `ALTER TABLE ... ADD COLUMN`），在模块加载时顶层成排调用（如 `ensureColumn('cards','source_url','TEXT')`）。MVP23 照此约定：

- `CREATE TABLE attention_items`（[db.ts:759](../apps/server/src/db.ts#L759)）加列 `action_options_json TEXT`（nullable，给新库）。
- 在 db.ts 顶层迁移区加一行（给旧库，幂等、可重复启动）：
  ```ts
  ensureColumn('attention_items', 'action_options_json', 'TEXT');
  ```
- `AttentionItemRow` 类型加 `action_options_json: string | null`。
- 裸 SQL `dbInsertAttentionItem`（[db.ts:2554](../apps/server/src/db.ts#L2554)）的 INSERT 列表 + values 加该列。

### 5.3 落库 / 反序列化插入点（**精确到 attentionStore 真实函数**）

> v1 曾把这两处指到 db.ts，错了。llmItem→row 的字段提取与 row→item 的反序列化都在 **attentionStore.ts**，db.ts 只是裸 SQL 层。

| 动作 | 函数 | 改动 |
|---|---|---|
| 解析 | `coerceItem`（[attentionPrompt.ts:597](../apps/server/src/attention/attentionPrompt.ts#L597)，逐字段构造 object literal）| 在 618–629 的返回里加 `processingOptions: coerceProcessingOptions(o.processingOptions)`（新防御 coercer，见 §6.2）|
| ref 解析 | `resolveAttentionRefs`（`{...it, signalIds:…}` спред）| **零改动**，新字段自动保留 |
| 写库 | `attentionStore.insertAttentionItem`（[attentionStore.ts:99](../apps/server/src/attention/attentionStore.ts#L99)，raw_json/recommended_agent 都在 110–117 提取）| row 加 `action_options_json: JSON.stringify(llmItem.processingOptions ?? null)`（**长度 0 也归一成 null**）|
| 读库 | `rowToAttentionItem`（[attentionStore.ts:62](../apps/server/src/attention/attentionStore.ts#L62)，getAttentionItem/listLive 的**唯一收口**）| 加 `actionOptions: parseOptionsOrNull(row.action_options_json)` |
| engine | 落库循环透传 `llmItem`（[attentionEngine.ts:244](../apps/server/src/attention/attentionEngine.ts#L244)）| **零改动**；supersede-only item（title==='supersede'）本就被跳过落库（239–240），无影响 |

> 备注：`raw_json` 本就存完整 llmItem，in-tick 下 options 已在其中；但领域 `AttentionItem` 从类型化列反序列化、不读 raw_json，故仍需独立列，且独立列能干净表达「null=降级」。

---

## 6. Prompt 改造（attentionPrompt.ts）

### 6.1 system prompt 末尾新增「角度生成」指令段（要点，非最终文案）
- **仅对 priority 为 P0 / P1 的 item** 生成 `processingOptions`（成本门槛）；P2/P3 不生成。
- 每个 item 给 2–3 个**彼此不重叠**的角度：`label`（≤6 字动词短语）+ `id`（小写蛇形）+ `directive`（一句话，告诉**执行时的 Claude** 做什么，**只产草稿/分析，不发送不写库**）。
- **directive 必须是自包含自然语言，严禁出现 `S#` 引用编号或任何 id**（因 `resolveAttentionRefs` 不处理该字段，写了不会被解析）。
- 用 `recommendedAgent` 当线索但不被限制；可结合 packet 其他承诺 / preferences 给跨卡片角度。
- 角度差到没区分度时**允许只给 1 个或省略**，不硬凑。

输出示例（schema 块现已是 S# 制，`signalIds:["S3"]`；`processingOptions` 并列新增）：
```json
{
  "priority": "P1",
  "title": "李四催 API 交付",
  "why": "[S3] 李四下午 @你确认接口能不能本周给，你没回",
  "suggestedAction": "回复确认交付时间",
  "signalIds": ["S3"],
  "recommendedAgent": "commitmentDigest",
  "processingOptions": [
    { "id": "draft_reply", "label": "起草回复", "directive": "基于我当前进度，起草一条可直接发给李四的回复，明确能否本周交付及预计时间，仅草稿。" },
    { "id": "summarize",   "label": "梳理要点", "directive": "把这条对话里李四到底要什么、有哪些约束，浓缩成 3 条要点供我快速决策。" },
    { "id": "to_task",     "label": "拟成待办", "directive": "把『本周交付 API 给李四』整理成任务描述（标题+截止+验收点），先给文本，不要真建任务。" }
  ]
}
```

### 6.2 解析：逐字段降级（coerceItem 内新增 coercer）
`coerceProcessingOptions(raw)`：
- 非数组 / 缺失 → 返回 `undefined`（→ 落库 null → 单按钮）。
- 逐元素校验 `id`/`label`/`directive` 必须非空 string；`label` 截 ≤8 字；`directive` 截 ≤200 字；`id` 规整为 `[a-z0-9_]` 并去重；**directive 命中 `\bS\d+\b` 的元素丢弃**（防 S# 泄漏）。
- 有效项 0 个 → `undefined`；>3 → 截前 3。
- **任何异常只影响该字段，绝不让 item 解析失败**（沿用现有 try/字段白名单风格）。

---

## 7. 投影与执行改造

### 7.1 projection（attentionProjection.ts `defaultAttentionActions` [:66](../apps/server/src/attention/attentionProjection.ts#L66)）
```
[ack]
if (item.actionOptions?.length)
  for o: push { id:`opt:${o.id}`, label:o.label, kind:'ask_agent' }
else
  push { id:'ask_agent', label:'让 AI 处理', kind:'ask_agent' }   // 单按钮兜底
[dismiss]
```
- 角度按钮 `kind` 仍是 `'ask_agent'` → 现有路由/状态机/埋点全复用；**directive 不下发前端**（后端持有）。
- 注：现有 `CardAction.prompt` 字段是**死字段**——`applyAttentionAction` 不读它（见 §7.2），角度按钮不必带 prompt。

### 7.2 execution（cardsService.ts `applyAttentionAction` ask_agent 分支 [:322](../apps/server/src/cards/cardsService.ts#L322)）
```ts
let directive: string | undefined;
if (actionId.startsWith('opt:'))
  directive = attn.actionOptions?.find(o => `opt:${o.id}` === actionId)?.directive;
const prompt = [
  buildRichAskAgentPrompt(attn),
  directive ? `\n【本次处理角度（请只做这一件）】${directive}` : '',
  userPrompt ? `\n【用户补充】${userPrompt}` : '',
].filter(Boolean).join('\n');
// 其余（sendTopicMessage / 标 acted / recordAttentionInteraction）不变
```
- **因后端重建 prompt、不信前端 prompt，directive 必须存后端按 id 取回**——本方案天然满足。
- `applyAttentionAction` 开头会 `defaultAttentionActions(attn)` 重算校验 action 是否存在（[:316](../apps/server/src/cards/cardsService.ts#L316)）；只要 `rowToAttentionItem` 已带 `actionOptions`，`opt:*` 按钮即匹配通过。
- directive 置 prompt 末尾、语气强制（「请只做这一件」），抵消 rich prompt 较长的注意力稀释；M1 抽查是否真按角度走。

---

## 8. 前端改造（SignalCard.tsx，工作量**中**）

对照现行代码（[SignalCard.tsx:309](../apps/web/src/components/SignalCard.tsx#L309) / [:659](../apps/web/src/components/SignalCard.tsx#L659)）确认三件事：

1. **「更多」是纯新增**：`visibleActions.map(...)`（659）平铺渲染所有按钮，今天无 overflow。M1 建议**先只出 2 个角度、不做「更多」**，第 3 角度 M1.5 再加溢出菜单。
2. **acked 态会保留全部角度按钮**：`isAcked ? [...actions.filter(ask_agent||draft_reply), 标记未读] : actions`（309–314）。卡片被某角度处理后进「已处理」抽屉会显示全部角度按钮 → **需收敛**：acked 后只保留单个「再让 AI 处理」+「标记未读」（在 `visibleActions` 过滤里把多个 `opt:*` 折叠成一个）。
3. **每个 ask 按钮各带一个内联指令输入框**（[:673](../apps/web/src/components/SignalCard.tsx#L673)）：3 角度 = 3 输入框，密度偏重 → 更应「2 直出 + 收起」。
- 复用现有 `extraPrompt` 流（每角度可补话）；无 `actionOptions` 的卡渲染零变化。

---

## 9. 旧卡 backfill（可选，一次性）

in-tick 只在「新 item 实际生成」时算角度；`cache_hit` / `skipped_no_change` 不重算。功能上线时已存在的 live 老卡不会自动长角度，等被新证据 supersede 的新卡才有。若要立即铺满：写一次性脚本（参考已存在的 `scripts/backfill-attention-signal-ids.ts` 风格）对当前 live 卡补一遍，跑完即弃。可接受自然 churn 则不做。

---

## 10. 学习闭环（埋点先留，M3）

点角度仍记 `recordAttentionInteraction(attn, 'ask_agent')`（[attentionInteractions.ts:72](../apps/server/src/attention/attentionInteractions.ts#L72)）→ engine「短期别重复同卡」逻辑继续生效。M3 再把被点 `option.id` 存进 interaction（加列）、喂回 prompt 做个性化排序。本期不实现。

---

## 11. 失败 / 边界 / 成本

| 场景 | 行为 |
|---|---|
| LLM 没吐 / 吐坏 processingOptions | 逐字段降级 → null → 单按钮，**item 正常** |
| directive 含 S# | 该角度丢弃（防泄漏） |
| 有效角度 0 / 1 个 | 降级单按钮 / 显示 1 个，不硬凑 |
| P2/P3 / 无 recommendedAgent | prompt 不生成 → 单按钮（成本门槛） |
| 卡被 supersede | 新行重算；旧 options 作废 |
| MVP22 Tier-2 就地刷新 | 兜底处清 options 退单按钮（§0.5） |
| 成本 | 仅 engine 单次调用增量 output，且仅 P0/P1；无新调用；directive 短 |

---

## 12. 分阶段落地
- **M1（✅ 已实现）**：迁移加列（`ensureColumn`）+ 类型 + prompt 指令（仅 P0/P1）+ 可降级 coercer（降级 / S# 丢弃 / 去重）+ projection 多按钮 + execution directive 拼装 + 前端 acked 态折叠为单个「再让 AI 处理」+ 单测。
- **M1.5（✅ 已实现）**：角度上限升到 3；前端角度按钮**紧凑化**（前 2 直出 + 第 3 收进「⋯更多」溢出菜单）。
  - UX 取舍：角度按钮**不带内联指令输入框**（directive 已编码意图；要补话在右侧 topic 里说）。内联输入仅保留给「无角度时的单个『让 AI 处理』」与 `draft_reply`。
- **M2（✅ 已实现）**：结构化执行器 `executor:'claude_topic' | 'create_task'`（最多 1 个角度用 create_task）。
  - create_task 角度投影成 `kind:'create_task'`，前端路由到**既有 confirm-gated 建任务通道**（`POST /cards/:id/lark-task`，复用 `window.confirm` + `confirm:true`），透传 `optionId` → 服务端用该角度 directive 作为任务「处理意图」写进描述（`larkTaskService.resolveOptionDirective`）。不绕过任何写入边界。
- **M3（未做）**：角度偏好学习闭环（记 `option.id` → 喂回 prompt 个性化排序）。

---

## 13. 权衡与已知风险（自评）
- 动了最金贵 prompt：靠「严格可选 + 逐字段降级 + 指令靠后 + 仅 P0/P1」去风险，坏字段不伤 item；核心注意力是否被稀释需上线前真卡肉眼验。
- 角度质量是 LLM 方案固有不确定性：靠 prompt「不重叠 / 可只给 1」+ 真卡调几轮；M1 先灰度看质量再放量。
- directive 注入稀释：置末尾、强语气，M1 抽查。

---

## 14. 待确认项（开工前 close）
- ✅① ~~增量迁移机制~~ **已确认**：用 `ensureColumn('attention_items','action_options_json','TEXT')`（§5.2），幂等、旧库新库通吃，无需自造。
- ⚠️② prompt 输出膨胀（仅 P0/P1）对核心判断质量的实测影响——M1 灰度抽查。
- ⚠️③ 「2 直出 + 1 收起」+ acked 收敛的卡片密度交互是否符合预期。
- ⚠️④ 与 MVP22 的落地顺序最终拍板（建议 MVP22 先，Tier-2 处清 options）。
