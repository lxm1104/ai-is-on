# MVP74 — 从「投查 loop」到「解决 loop」技术方案

> 状态：设计定稿（脑暴4视角 + 3轮对抗审查 + 实现者复核）。所有基线/约束已对真实库 `data/ai-is-on.sqlite` 与源码 file:line 核实。

## 0. 实现者复核（main loop，2026-06-24）—— 一处 load-bearing 纠正

workflow 的最致命发现「断点③：179 次排查里 trace→file:line 链跑通 0 次，bitable-chatbot=0」**是错的**——它查的是 `audit_logs.payload_json`，而 investigation 的 audit payload 只有 `{matterId,verdict,confidence,resultUnitId}`、**从不含工具参数**。查对的表 `task_traces.steps_json` 后实测：
- AI 在 **bitable-chatbot 跑过 37 次 run_command**（rg/git 真读到代码）。
- **bytedcli/fornax（trace 精准路径）跑过 10 次**（非 0）。

**结论**：排查链路**是通的**（已 37 次读到代码 + 10 次拉 trace）。所以 workflow 原方案的 **P0-0「先取证证明链路能跑」这道独立门槛取消**——折叠进 P0-1 的真实数据验证即可（实现后跑真实 badcase，确认产出的 `targetRef` 是真实定位到的 file:line）。其余设计（架构、护栏、度量诚实性）全部采纳。

**调整后 P0 顺序**：P0-3(度量标尺) → P0-1(conclude 长出 artifact+solvability 出口) → P0-2(交付卡) → 真实数据验证。安全闸不变：`targetRef` 必填 + `evidence≥1` 后端校正 + 卡标「建议待你核实/应用」+ 绝不自动 apply。

---

## 1. 背景与基线（实测，证据优先）

| 项 | 实测 |
|---|---|
| matter 去向 | open 77 / resolved 16 / in_progress 14 / blocked 13 → **闭环≈13%** |
| `matter_auto_resolved` | **0**（Tier A 自动办结从未触发） |
| `lark_task_created` | 2 | 
| `investigation_written_back` | 179（纯只读查） |
| resolved 投查 | 仅 6/179≈3%，且全是同一 matter；自 2026-06-16 后断粮 |
| progress 卡去向 | **64% expired，acted 仅 5.2%** |
| AI 在 bitable-chatbot run_command | **37**（rg/git，读到代码）；bytedcli/fornax **10** |

**两根真断点**（断点③已纠正为"链路通但产出没出口"）：
- **断点①**：`conclude` 只吐 `{verdict,confidence,factSummary,evidence,needFromUser}`，**没有装"可执行件"的字段**——诊断到产出之间没有出口。
- **断点②**：Tier A 自动办结上游枯竭——投查极少给 `resolved`（读只读约束下，只能确认"已完成"才给，罕见），故 `matter_auto_resolved`=0。

**核心真相（决定可行边界）**：AI 工具**硬只读 + 对外/不可逆 confirm 门控 + IM 代发禁**，所以**不能自主"做"大多数事**。约束内的"解决/推进" = **产出"最推进一步、你一步可确认/应用的可执行件"**（代码修复方案 file:line+改法、待建任务 spec、决策信息包）+ **Tier A 内部可逆动作自动闭环**（自动办结）。设计严格区分「AI 自主完成」vs「AI 推进到一键待确认」。

## 2. 愿景与端到端

把每件事从「查清有没有」升级成「**能解到哪一步、并尽量把那一步替你做出来**」：AI 先自评 solvability → 能内部可逆闭环的自动闭环 → 够不到闭环但**查到真凭据**的凝成"一键可应用交付件" → 缺具体物的明确求助。全程不碰对外/不可逆动作。

```
runInvestigation (循环/run_command/单并发gate 不变)
   └─ conclude ──新增── solvability + artifact(最推进一步的可执行件)
         └─ writeback：不重写级联，仅在 resolve 分支后、needhelp 分支前**插一个 artifact 分支**
              ├ can_close        → Tier A 自动办结(P1 救上游+级联护栏)
              ├ can_produce_artifact → 「交付卡」(新)：复制file:line/复制方案/让AI起草/办结
              ├ need_user        → needhelp 求助卡(已有)
              ├ cant             → dangling/静默(已有)
              └ (solvability 缺失 → 逐分支等价回退今天 verdict 级联，零行为变化)
         └─ 解决漏斗度量(新): 未动→已诊断→已产出件(带targetRef)→待你一步→闭环
```

互斥序 **resolve > artifact > needhelp > progress > dangling**。artifact 门**比 needhelp 更严**（强制 `targetRef`+`evidence≥1`），缺则落到 needhelp/progress，**绝不吞掉本该求助的 badcase**（保护 MVP72 缺 traceID→need_credential 闭环）。实现纪律**"薄一层"**：只插一个分支，其余一字不动；`solvability===undefined` → 零行为变化。

## 3. 分阶段路线

### P0 — 让代码 badcase 真往前推进一步（用户核心工作流）

**P0-3 解决漏斗度量（先做，否则改了无法证明）** — `db.ts`
- 扩 `getAiActivityTally` 成五档漏斗（确定性、零LLM）：未动→已诊断(有 meaningful 排查)→已产出件→待你一步→闭环。
- **诚实口径（审3 P0-A）**：新增 audit `matter_artifact_raised`，payload 落 `{matterId,hasTargetRef:boolean,artifactKind}`；"已产出件"**只数 `hasTargetRef=true` 的 distinct matter**（不凭"发了卡"刷高）。
- "闭环"=`matter_auto_resolved ∪ 用户在交付/办结卡点 matter_resolve 的 distinct matter`，**排除问题类级联翻牌的兄弟 matter**。分母=`open+in_progress+本周新建`（注释钉死，与 tally 近7天口径统一）。

**P0-1 conclude 长出 artifact 出口 + solvability 自评** — `investigationPrompt.ts`
- `InvestigationConclusion(:84)` 加两可选字段（不填=今天行为，严格向后兼容）：
  ```ts
  solvability?: 'can_close'|'can_produce_artifact'|'need_user'|'cant';
  artifact?: { kind:'code_fix'; title:string; rootCause:string;
               targetRef:string; /*file:line 必填—校正硬门*/ body:string; verifyCmd?:string };
  ```
- prompt 代码/badcase 段(:46)收尾：先自评 solvability；若 can_produce_artifact，根因+改法+验证命令填 artifact，**`targetRef` 必须是真实 trace/代码里定位到的 file:line，不得编造**。
- `parseArtifact`/`isValidArtifact`（仿 `parseNeedFromUser`/`isValidNeedFromUser`）：非法即降级 undefined，绝不脏数据穿透。
- **后端确定性校正**（防 LLM 自评虚高，对齐 autoResolveEligible "必须有证据"）：标 can_produce_artifact 但 artifact 缺 targetRef 或 evidence<1 → 降级，不升交付卡。
- 零额外 LLM gate（同一步多吐字段）。

**P0-2 「交付提案卡」：artifact → 一键可应用卡** — `matterResolveProposal.ts` + `attentionProjection.ts`
- `raiseMatterArtifactProposal` 转调内核 `raiseMatterProposal`，前缀 `proposal:matter-artifact:`。卡正文=file:line+根因+改法+验证命令。
- `defaultAttentionActions(:90)` 加 artifact 前缀分支。动作组（**修正审查**）：
  - **复制 file:line / 复制修复方案**：纯前端 `navigator.clipboard`，零后端、零 sourceUrl 依赖（**不用 open_source**——artifact 卡 signalIds:[] 无 sourceUrl=死按钮）。
  - **让 AI 起草补丁**：`kind:'ask_agent'`（现成，buildDefaultPrompt 已禁写）。
  - **办结**：`kind:'matter_resolve'`（现成）。**继续跟进**：`dismiss`。
- writeback 接线（薄一层）：resolve 分支后、needhelp 分支前插 `can_produce_artifact && isValidArtifact && config.investigationArtifactEnabled` 分支；其余不动。
- **降噪闸真生效**：artifact 前缀**纳入** `countLivePendingUserProposals`（否则配额闸虚设）；复用 `blockedByReRaiseCooldown` + 顶泛 progress 卡。
- **TTL 豁免**：artifact 是高价值信号，不与泛 progress 卡同享 24h TTL（实测 64% expired）；建卡写远期 `expires_at` + 前端置顶露出（同 MVP72 求助卡置顶）。
- dismiss 豁免 not_relevant（同 needhelp）。

### P1 — 救活上游 + 扩产出件种类（P0 度量验证后）
- **P1-4 救 Tier A 自动办结上游 + 级联护栏**：prompt 判定按"内部可逆 vs 对外/不可逆"分档（内部可逆查到完成证据敢给 resolved+can_close；对外/P0 保守）。门(conf≥0.85+evidence≥1+非P0)不动只喂上游。**必补级联护栏**：autoResolve 若该 matter 是问题类**最后一个未 resolved 成员**（会触发 `syncClassStatusForResolvedMatter`→`allMemberMattersResolved` 不分归属人静默翻整类）→ 降级为 resolve 提案卡（人确认）；回执披露级联。
- **P1-5 code_fix.body**：文字改法为主；diff 由 LLM 基于读到的上下文手拼放 body、标"草稿 patch，apply 前 review"、过 16KB 校验超限降文字；**绝不 git diff 自动产 patch（工作树干净输出空+截断成坏 patch）、绝不自动 apply**。
- **P1-6 扩 kind**：`task_spec`（progressed"已确认采用X"→建任务，**用 `opt:`+actionOptions+directive 走既有角度通道**，裸 create_task 后端无分支=死按钮）；`decision_brief`（decision 类→信息包，不替用户拍板）。

### P2 — 度量验证后
reply_draft（复用 previewImReply 只起草不发）、dangling 升级成"我替你起了初稿"、unknown 分流 tool_gap（先核证据）。**明确不做新增触发场景**（瓶颈是深度/产出/蒸发，非覆盖面）。

## 4. 严守硬约束（代码级）
- IM 代发：`larkImReplyService.ts:241` 无条件 throw；只起草。
- 对外/不可逆 confirm 门控：建任务 `larkTaskService.ts:72` `if(!confirm)throw`；artifact 永进待确认卡；patch 只复制绝不自动 apply。
- 投查只读：run_command 不变；git diff 在只读白名单（计算非写盘）；路径根限 allowedRoots。
- 单并发 gate：solvability/artifact 是 conclude 同一步多吐字段，零额外 gate。
- 反噪声：artifact 卡纳入配额闸+冷却+顶泛 progress+TTL豁免；复制类按钮真有用非空草稿。
- **AI 全程不自主做对外/不可逆动作**。度量区分"AI 自主完成"(只数 matter_auto_resolved+lark_task_created) vs"推进到一键待确认"(单列，绝不混入"已做")。

## 5. 验收（北极星）
| 指标 | 定义 | 基线 | 验收 |
|---|---|---|---|
| ① 闭环解决率 | (auto_resolved ∪ 用户在交付/办结卡 resolve 的 distinct matter，排级联兄弟)/活跃 | 13%(自主=0) | 自主闭环转正、总闭环上行 |
| ② 推进/产出率 | 升过 artifact 卡且 hasTargetRef=true 的 distinct matter / 排查过的 matter | ~1% | 显著>1% |
| ③ 自动完成率 | matter_auto_resolved distinct / 活跃 | 0% | 救活上游后转正 |
| 漏斗硬门 | artifact 卡 acted 率 | progress 卡 acted 5.2% | **显著>5.2%**，否则判噪声回滚 |

## 6. 复用点
排查 loop/run_command、`raiseMatterProposal` 内核、ask_agent/matter_resolve/dismiss kind、`opt:`+actionOptions 角度通道(P1-6)、autoResolveEligible门+二档核实+可重开、`countLivePendingUserProposals`/冷却/顶替降噪闸、`getAiActivityTally` 骨架、lark task/doc/im 现成动手能力。**唯一真新造**：artifact 字段+parseArtifact+raiseMatterArtifactProposal+前缀+一个卡分支(复制类纯前端)+漏斗 SQL+`matter_artifact_raised` audit。

## 7. 实现落点（绝对路径）见 workflow 产出（investigationPrompt.ts / investigationWriteback.ts / matterResolveProposal.ts / attentionProjection.ts / db.ts / config.ts / SignalCard.tsx）。
