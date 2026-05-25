# MVP6 后续方案研究发现

## 代码与文档基线

- 文档 `docs/MVP2-MVP6-Context连续性系统开发执行方案.md` 定义了 ContextUnit、Trigger、Agent Run、Context Space、Boundary 的完整路线。
- 服务端已经落地主要表：`context_units`、`context_entities`、`context_links`、`triggers`、`agent_runs`、`action_proposals`、`context_spaces`、`boundary_rules`、`audit_logs`。
- 当前链路是：collector/manual event -> events -> minimal ContextUnit -> triage contextUpdates -> upsert ContextUnit -> trigger evaluator -> agent queue -> action proposal -> card -> feedback/boundary/audit。
- 前端已有 `CardList`、`ContextPanel`、`SpacesPanel`、`RulesPanel`，偏调试和控制台形态。

## 实际数据状态

- 本地 SQLite 中已有：276 events、302 context_units、152 context_entities、12 triggers、34 agent_runs、63 cards、2 context_spaces、2 boundary_rules、4 audit_logs。
- ContextUnit 以 `event|work` 为主，已有少量 `state`、`uncertainty`、`commitment`、`emotion`、`intent`。
- Agent 已实际跑过 `track_commitment`、`caring`、`daily_digest`、`sync_draft`、`prepare_meeting`，但部分历史 run 仍处于 running。

## 主要缺口

- Agent 处理 context 的“判断坐标系”还散在 prompt、heuristic 和 card action 中，没有统一的 work profile / goal / project map / responsibility / permission bootstrapping。
- 冷启动目前靠用户在 Composer 手动输入、创建 Space、点“以后自动”，没有结构化 onboarding。
- Trigger 以规则驱动为主，缺少统一的 Context Delta 解释层：what_changed、affected_goal、affected_people、risk、missing_info 等。
- Space 主要靠 entity seed 做关联，项目目标、角色责任、权威文档、协作关系还不够厚。
- Boundary 能学习来源/优先级，但还没有按行动类型、可逆性、影响范围、实体关系形成更细的授权。
- Feedback 记录了“理解错了”，但尚未形成自动校正 context/entity/rule 的闭环。
