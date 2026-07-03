# MVP80：「AI 替你做了什么」重做为助理工作日志——四类结果观

## 用户定调（2026-07-04，成为铁律）

「面板都是没用的信息」+「我希望 AI 处理能让我看到结果：**让我确认也是一种结果，需要我的帮助也是结果，你自己学习、按照我之前的做法完成了一件事情也是结果**。」

即结果四类：① 看得到的成果 ② 等你确认的 ③ 需要你帮忙的 ④ AI 照你的做法办成的。此定义扩展 MVP75 第一性原理（结果/需要你的才占像素），此后所有"给用户看什么"的决策按此执行。

## 实测四大噪声（重做依据）

1. meeting_action_items / daily_digest / reminder 行 payload 无 title → **全空行**；
2. 同一事项的建议/产出按 audit 流水直铺（「Analysis Agent 读公式失败」7 天 4 条重复行）；
3. 每日例行 daily_digest/reminder 混进「替你做了什么」；
4. 真正的大活（批量清理 7 件、征询、飞书回复处理）反而没纳入。

## 重做规则（listAiActivity）

- **成果**：matter_auto_resolved / chat_conclusion / lark_task / lark_doc 原样；investigation_recommended / matter_artifact_raised **按 (action, matter) 去重取最新**，repeatCount 显示「第 N 次跟进」；backlog_swept **按批次聚合一行**（「你确认后一次清掉 N 件：标题…」，前端徽标「共 N 件」）。
- **来找过你**：consult_asked（🤝 征询）、notify_pushed kind∈{needhelp, resolve_proposal} 合成 🙋求助 / ✋待确认 行、backlog_sweep_proposed（🧹 清单等你一句话）、backlog_sweep_restored（↩️ 照你要求恢复）。
- **照你做法办成**：dispatcher 把 playbook 命中与用户回填透传 writeback → 三类结果 audit 落 `followedYourPlaybook` / `usedYourBackfill` → 面板徽标「📘 按你教的做法」「🧩 用了你补的信息」。
- **剔除**：全部 action_proposals 行（空标题+例行；日报/提醒在卡片流有位置）、mode=command:*/consult_choice 的 notify_reply_handled（防与批次行/choice 行双计）、未知动作前端整行不渲染（防再变垃圾场）。
- 面板按天分组（今天/昨天/MM-DD）；tally 加 🧹 清理数。

## 对抗审查（4 维并行审查 + 双怀疑者验证 workflow）

- **确认 P1 并已修**：批次行的件数「N 件」只存在于 reason 冒号前缀，被前端 detailOf 冒号截断吃掉且徽标被抑制——件数在 UI 任何位置都不出现，恰是该行存在的意义。修：徽标「共 N 件」。
- 人工核定的其余候选：排序比较器相等时不一致（已改 localeCompare）；「恢复」互动被 command:% 过滤吞掉（已加 backlog_sweep_restored 行）；meeting_brief 失去最后可见入口（**有意取舍**：当前 payload 无标题=空行，待其产出真正带内容的标题后再回归）。
- 注：验证阶段约半数 agent 撞订阅会话额度上限（resets 1am），未验证候选由人工逐条核定。

## 验证

- 7 个新测试（mvp80-activity-feed.test.ts）+ mvp66 旧断言反转注明缘由；全量 864/864；两端 tsc 干净。
- 浏览器实测（preview）：按天分组正常；tally「🎯20% 💡6 ✅1 🔧4 🧹7 🙋待你 🤝」；**首行即真实数据的最佳注脚——MVP79 征询已真实触发**（「蔡蔚请你处理『周一开通测试租户』，已收集来源信息并发飞书征询」，notify_pushed kind=consult 送达留底）。

## 遗留

- consult 幂等键 `aiisn:consult:<uuid>` 恰好 50 字符压线（合法但无余量）——后续新 kind 命名要过 makeIdempotencyKey，勿裸拼。
- 「按你教的做法」归因目前只覆盖自主排查路径（dispatcher）；chat/manual 路径的结论未归因。
- meeting_brief/action_items 需要先让 proposal 产出真实标题，再考虑回归面板。
