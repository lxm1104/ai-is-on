# MVP14 Attention 交互反馈闭环技术方案

## 背景

当前左侧 attention 卡片的「知道了」和「忽略」主要改变卡片展示状态：

- 「知道了」把 `attention_items.status` 从 `live` 改为 `acted`。
- 「忽略」把 `attention_items.status` 从 `live` 改为 `dismissed`。
- 只有「理解错了？→ 这条没用」会走 `attentionFeedback.not_relevant`，进而降低相关 entity 权重并触发下一轮 attention。

这导致用户在主操作区点「忽略」时，直觉上是在给系统负反馈，但实际只是在关闭当前卡片；「知道了」也没有进入下一轮 attention 的输入，未来仍可能重复出现类似提醒。

## 目标

1. 「知道了」表达弱反馈：用户已看过/当前不用再提醒，同一件事短期内不应重复浮出。
2. 「忽略」表达负反馈：当前 item 对用户不重要或不相关，应影响后续 attention 排序。
3. 不把每一次按钮点击都写成长期 `ContextUnit`，避免污染长期记忆。
4. 保留强反馈入口：「这条没用」仍然是明确 `not_relevant`，可降低 entity 权重。

## 非目标

- 不改 attention LLM 的核心输出 schema。
- 不新增复杂偏好编辑器。
- 不为「知道了」创建 `action_result` ContextUnit。
- 不处理飞书任务创建；任务外部行动另走 `commitment + action_result` 方案。

## 数据模型

新增 `attention_interactions` 表，作为 attention 专属交互日志：

```sql
CREATE TABLE attention_interactions (
  id TEXT PRIMARY KEY,
  attention_id TEXT NOT NULL,
  action TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  priority TEXT NOT NULL,
  title TEXT NOT NULL,
  signal_ids_json TEXT NOT NULL DEFAULT '[]',
  related_entity_ids_json TEXT NOT NULL DEFAULT '[]',
  related_space_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
```

`action` 取值：

- `ack`：用户点「知道了」。
- `dismiss`：用户点主按钮「忽略」。
- `not_relevant`：用户点「这条没用」。
- `ask_agent`：用户点「让 AI 处理」。

## 行为设计

### 知道了

```text
click ack
→ record attention_interaction(action='ack')
→ status: live -> acted
→ card_updated
→ 下一轮 attention prompt 携带 recentAttentionInteractions
```

语义：这条我看到了，但不一定判断错误。后续同 signal/title 不应短期重复出现，除非有新证据、优先级升级或 deadline 变化。

### 忽略

```text
click dismiss
→ record attention_interaction(action='dismiss')
→ apply not_relevant 轻量负反馈
→ status: live -> dismissed
→ 相关 entity confidence -0.1
→ audit + correction_journal
→ enqueue attention tick
```

语义：这条对我没价值。它比「知道了」更强，应影响后续 attention 的输入权重。

### 这条没用

继续走 `attentionFeedback.not_relevant`，但记录 `attention_interaction(action='not_relevant')`，保证强反馈也进入 prompt 历史。

## Attention 输入改造

`assembleGlobalContextPacket` 增加 `attentionInteractions` slice，默认取最近 7 天、最多 20 条。`buildAttentionUserMessage` 新增：

```xml
<recentAttentionInteractions>
- [ack] P1 xxx (signals: ...)
- [dismiss] P2 xxx (signals: ...)
</recentAttentionInteractions>
```

system prompt 增加规则：

- `ack`：不要短期重复输出同一 signals/title，除非出现新证据或优先级升级。
- `dismiss/not_relevant`：视作负反馈；不要输出同类/同 signals item，除非存在明确高优先级新证据。

`inputHash` 纳入 interaction fingerprints，确保用户操作后下一轮 attention 不被旧 hash cache 吃掉。

## 自审

- 数据边界：interaction 日志不进入长期 ContextUnit，避免记忆污染。
- 行为一致性：主按钮「忽略」与「这条没用」都能影响 attention，不再只是隐藏卡片。
- 可追溯性：负反馈仍写 audit / correction_journal；ack 写轻量 interaction。
- 回滚风险：新增表是 `CREATE TABLE IF NOT EXISTS`，旧库兼容。
- 剩余风险：LLM 是否完全遵守 interaction prompt 取决于模型；后续可加硬规则，在落库前过滤与 dismiss/not_relevant 完全同 signal 的 item。

## 验收

1. 点「知道了」后产生 `attention_interactions.action='ack'`，attention item 变为 `acted`。
2. 点「忽略」后产生 `attention_interactions.action='dismiss'`，attention item 变为 `dismissed`，相关 entity confidence 下降。
3. 点「这条没用」后产生 `attention_interactions.action='not_relevant'`。
4. attention prompt 中包含 recent interactions。
5. inputHash 会因 recent interactions 变化而变化。
