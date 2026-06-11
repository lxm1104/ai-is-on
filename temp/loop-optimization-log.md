# AI is ON · 持续优化循环日志

> 由 /loop（持续优化闭环）维护。目标：让系统真正可用 —— 及时监控工作事项，辅助/代办完成。
> 每轮：体检（数据库 + 运行状态）→ 找最痛的问题 → 修复 → 验证 → 记录。

## 待办问题清单（按影响排序）

1. **[P1] attention 单次 LLM 调用 ~104s，太慢**
   - 实测 input 26.6k tokens，其中用户消息只占 ~4k，约 22k 是 opencode 注入的系统侧内容（agent.md 15KB + 工具 schema + 项目 AGENTS 文件？）。
   - 方向：查清 opencode run 实际注入了什么；裁剪 aiisn-attention.md；考虑减小 packet（recentEvents 20 条、topActive 15 条是否都必要）。
   - 时延从 104s 降到 <30s 会质变「及时性」。
2. **[P2] triage 失败时直接 markEventProcessed 销账**（triageQueue.ts drain catch）
   - 非 retryable 错误时事件被静默丢弃，没有任何用户可见痕迹。考虑：失败计数 + 卡片/日志面板透出。
3. **[P3] im collector 偶发 lark-cli 网络超时**（exit 4, open.feishu.cn dial timeout）
   - 已能自愈（下轮重试），但 lastError 会一直挂着直到下次成功。观察频率，必要时加退避。
4. **[P3] lark-cli 1.0.49 → 1.0.50 有更新**（collector 错误信息里提示）。
5. **[P3] `.opencode/agent/*.md` 13 个文件 working tree dirty**
   - 是 `syncOpencodeAgents()` 启动时从 src/opencode/agents.ts 生成的产物（provider 改名 zhipuai→zai 后再生成）。要么提交，要么 gitignore（生成物不该追踪）。
6. **[P3] temp/ 下有 2026-05-20 旧研究会话遗留文件**（task_plan/findings/progress.md），已过时，待用户确认后清理。

## 迭代记录

### 2026-06-10 第 1 轮：attention 引擎 87% 失败 → 修复调用层

**体检发现：**
- attention_engine_runs 失败率：6/9 全天 167 失败 / 24 成功（87%），6/10 上午 81 失败 / 6 成功。
- 失败模式：`opencode one-shot 超时 (180000ms)`，主备模型（glm-5.1 / glm-5-turbo）双双超时。
- 实测：隔离环境单次调用 104s（glm-5.1）/ 85s（turbo），瓶颈是 26.6k token prefill + provider 延迟，换模型无效。
- 根因链：180s 超时贴着 p50 → 必然误杀 → 误杀后立即 fallback 重试 → provider 负载翻倍 → 全部调用（triage/attention/matter/分类器 15+ 调用方并发直发）在 provider 端互相挤兑排队 → 级联超时。
- 次生问题：纯内存 triage 队列重启即丢（tsx watch 改码即重启），积压 2014 条 processed_at IS NULL；agent_runs 4 条 5/19 起卡 running；attention 占位行重启后变永久 zombie。

**修复（全部已落地 + typecheck 通过）：**
- `triage/backgroundRuntime.ts`：新增全局 FIFO LLM 闸门（`OPENCODE_MAX_CONCURRENCY`，默认 1），所有 runOneShot 调用串行；排队发生在本地、不计入 timeout；排队 >15s 打日志；导出 `getLlmGateStats()`。
- `config.ts`：新增 `opencodeMaxConcurrency`、`attentionTimeoutMs`（默认 300s）。
- `attention/attentionEngine.ts`：超时 180s → `config.attentionTimeoutMs`（300s）。
- `collectors/scheduler.ts`：skipTriage 信号（doc_comment 等）ingest 时即打 processed_at，让 `processed_at IS NULL` 恒等于「等 triage」。
- 新增 `startupRecovery.ts` + index.ts 启动调用：孤儿 run 收尸（attention/agent）、>48h 积压销账、skipTriage 存量销账、年轻积压回灌 triage（cap 60）。

**验证：**
- 启动恢复实测：events 未处理 2014 → 2；agent_runs 卡死 5 → 0；attention 孤儿 0。
- typecheck 通过；单测 9/9 通过。
- **端到端 attention run 验证成功**：09:13:29 触发 → 09:22:19 完成 status=ok，
  主模型 glm-5.1 一次通过（无 fallback）。分解：闸门排队 4.4min（排恢复回灌的 triage/matter 之后，
  一次性现象）+ LLM 实跑 268s。268s > 旧超时 180s —— 直接证明旧配置必杀此类调用。

### 2026-06-10 第 2 轮：prefill 解剖 → 发现 skills 注入元凶，单次调用 104s → 57.5s

**排查过程（排除法，每步用 ping 测 prefill = input + cache.read）：**
- baseline：~52.7k tokens —— 但 attention agent prompt 只有 ~10k，谜团 ~40k。
- 禁全部工具（tools: false 实验 agent）：只省 ~2.8k。不是工具 schema。
- 项目级 opencode.json 禁两个全局 MCP（chatbot_eval、pencil）：省 ~6.8k。
- 移走 ~/.config/opencode/skills（browserwing×2）：只省 ~0.3k（skills 只注入摘要）。
- `opencode debug agent` 解剖：发现 293 条 skill external_directory 权限 —— **opencode 兼容发现了
  ~/.claude/skills/ 下 138 个 Claude Code skills，每次调用注入全部元数据 ≈ 37k tokens**。
- `permission.skill: {"*": "deny"}`（项目级 opencode.json）：**prefill 52.7k → 8.3k（-84%）**。

**修复：** 新增项目根 `opencode.json`：禁用 chatbot_eval/pencil 两个 MCP + `permission.skill "*": deny`。
这些后台 agent 是纯文本进/JSON 出，从不用 skills/MCP，纯属误注入。aiisn-chat 同样受益（变快）。

**验证：**
- 真实规模 attention 调用：104s → **57.5s**（含真实输出 589 tokens；总 prefill 58.9k → 14.5k）。
- attention 每 5 分钟 tick 的占空比从 89%（268s/300s）降到约 20%（~60s/300s），
  单并发 provider 不再被 attention 吃满，闸门排队大幅缓解。
- 生产端 run 验证：09:5x 触发，等待完成中（后台监听）。

**经验：**
- opencode 会自动发现并注入 ~/.claude/skills（Claude Code 兼容层）—— 跑无头后台调用的项目必须
  在项目级 opencode.json 显式 deny，否则机器上装的 skill 越多、所有调用越慢。
- 测 prefill 用 ping + step_finish 的 tokens 字段（input + cache.read 才是总量），比测时延噪声小得多。

### 2026-06-10 第 3 轮：triage 失败可见化 + 清理重复 dev 守护

**做了：**
- events 新增 `triage_attempts` / `triage_failed_at` 列（ensureColumn 迁移）。
- triageQueue 失败路径重写：失败批次重试 1 次（拆成单事件批隔离毒丸），额度耗尽才销账并记
  triage_failed_at —— 不再静默丢弃 @我消息等事件。
- 环境排查：发现**两个 tsx watch 守护**（一个昨天 19:27 遗留），每次改码抢 8787 端口导致随机不可用；
  已杀掉遗留的，只留一个。
- 澄清：09:46 run 的 448s「失败」= 被我改码重启孤儿化（recovery 正确收尸），非真实 LLM 失败。

**验证：** typecheck 通过；列迁移生效；重启后 6 条新事件正常 triage（attempts 均为 0 无误伤）；
live 卡片审查：10 条内容质量好（封版日、阻塞事项、明日会议都有证据 id）；
今天失败率曲线：凌晨 12 失败/小时 → 修复后最近 3 个完整 run 全 ok。

**卡片质量观察（第 3 轮顺带审查）：** 当前 10 条 live 卡片全部工作相关、有证据、有 matter 绑定。
数量健康（TTL+supersede 在工作）。质量暂无需修。

### 2026-06-10 第 4 轮：加观测（排队/实跑/输入分离计时）

- run 表 input_summary 增加 inputChars / llmWaitMs / llmExecMs；runOneShot 返回 timing。
- 数据：输入实为 17.6k chars；exec 213-448s（一次主模型 300s 超时被杀转 turbo）；排队 79-161s。
- 结论：慢 = 输入大 × glm-5.1 慢 × 排队叠加，三个都要砍。

### 2026-06-10 第 5 轮：闸门优先级 + packet 瘦身

- 闸门双级队列，attention priority=true 插队；packet 裁剪：matters 30→12（最大段 4.7k）、
  recentEvents 20→12、interactions 20→10、topActive 15→10、collaborators 12→8、currentLive 20→12。
- 验证：输入 17.8k→13.4k chars；wait 161s→2.6-68s；exec→171-225s；端到端 ~600s→~230s，全 ok。

### 2026-06-10 第 6 轮：attention 切 turbo（关 thinking）+ P0 从严

- 发现：turbo 在真实输入上 94s，其中 reasoning 8255 tokens 占大头；项目 opencode.json 加
  `provider.zai-coding-plan.models.glm-5-turbo.options.thinking={type:disabled}` 后 **15.6s**（缓存暖）、
  reasoning 0、输出质量结构合规（7 items 全带证据 id）。glm-5.1 关 thinking 撞 300s 超时，否决。
- 落地：ATTENTION_MODEL=glm-5-turbo（主）/ glm-5.1（fallback 兜质量）；runOneShot 支持 per-call
  model 覆盖；attention prompt v2 加「P0 从严（≤3 条，拿不准给 P1）」补偿 turbo 无 thinking 的标定偏松。
- 验证：typecheck+单测过；等 2 个生产 run 计时（预期端到端 <60s）。

### 2026-06-10 第 7 轮：看板防抖（churn guard）

- turbo 生产验证：exec 24-48s、排队 ~10ms ✓；但每轮全量重发看板（1h 29 条 superseded、
  created_at 重置、用户状态丢失）+ 一例标题日期漂移（「今日 14:00」vs 证据 06/11）。
- 修复：引擎侧等价判定（同 priority + 同 matterId 或同 signal 集）→ 保留旧卡丢新卡；
  第二轮发现模型重发可不带 supersedeIds 造成双卡 → 等价检查范围扩大到全部 live；
  prompt 加「保留是默认动作」「标题时间与证据一致」两行；手工清掉 1 张存量双卡。
- 验证：防抖首轮生效（每轮 6-7 条 → 1-2 条、created_at 稳定、P0=3 达标）；广义防抖待下轮数据。

**今天整体改善曲线（第 1-7 轮累计）：**
| 指标 | 今晨 | 现在 |
|---|---|---|
| attention 成功率 | ~13%（凌晨 0%） | 100% |
| 端到端时延 | 370-600s+（常超时） | 25-48s |
| 排队 | 80-160s | ~10ms |
| 事件丢失 | 重启即丢 + 失败静默销账 | 重启恢复 + 重试 + 失败留痕 |
| 看板稳定性 | 每轮重写 | 等价保留，增量更新 |

### 2026-06-10 第 8 轮：ask_agent 链路质检 + 授权看门狗

**质检（用今早 2 次真实 ask_agent 复盘，零副作用）：**
- 质量整体合格：AI 真的拉了 IM 记录、发现卡片信息已过时、给出明确结论和表格化进展；
  第二例把内测群的 CSV 乱码反馈整理成了结构化问题。
- **缺口 1（产品级，待用户拍板）**：处理结论不回流 —— AI 说"这条可以关了"，但底层 Matter
  仍 open，之后可能再生成新卡继续催。需要「聊天结论 → matter 状态建议 → 用户一键确认」的回流通道。
- **缺口 2（已修）**：lark token 过期时系统静默失明，用户在聊天里才得知。

**建设：authWatchdog.ts** —— collector 失败消息匹配 auth 特征（identity missing / token
expired / 飞书 99991663-5 错误码）→ 升确定性 P0 系统卡「飞书授权已失效，监控暂停」（无 LLM、
固定 input_hash 去重）；举报者 collector 本人成功 → 自动撤卡（防 bot/user 双身份误撤闪烁）。

**验证：** typecheck + 单测过；功能实测：升卡 ✓、网络超时不误报 ✓、恢复自动撤卡 ✓。

### 2026-06-10/11 第 9 轮：深度研究消化 + 夜间稳定性确认

**夜间验证（12:00Z 起 ~16h）：163 ok / 1 failed / 70 cache_hit（99.4%），零重复卡、零积压、
零 collector 错误 —— 第 1-8 轮修复整夜稳定。广义防抖验证通过。**

**深度研究（业界闭环设计，107 agent；注：因会话限流，多数 claim 未完成对抗校验，标注区分）：**

已验证（Outlook Prioritize My Inbox，3-0/2-1 票）：
- 优先级判定显式偏向 action-required（行动导向加权）。
- 定制机制 = 用户自然语言规则（短语式、至少一条启动）——印证我们的 user_rules 路线，
  值得把「教 AI 规则」入口做得更显眼。
- **可解释性建立信任：点开每条优先级判定即显示理由** —— 我们卡片的 why 字段方向正确。

高价值线索（来源可靠但未完成 3 票校验）：
- **LangChain Agent Inbox 模式**：AI 提案的人类动作收敛为四元词汇 accept / edit / respond /
  ignore，且**每个提案单独配置允许哪几种动作**（allow_accept/edit/respond/ignore 四个布尔）——
  这正是「结论回流 + 渐进放权」的现成设计：把 ask_agent 产出的草稿/结论变成结构化提案，
  用户 accept 即回写 matter 状态 / 发出草稿，boundary rule 控制每类提案的可用动作。
- **EAIA（LangChain 参考实现）**：triage 硬三分类 IGNORE / NOTIFY / RESPOND（比纯 priority
  更行动导向；NOTIFY=值得知道但无需回应）。
- **Motion**：过期任务不留死尸——自动重排并展示新时间（对应我们 matter 的 stale 跟进）。
- **Horvitz mixed-initiative / LookOut**：自动化与否 = 期望效用决策（出错代价 × 置信度），
  渐进放权的理论框架。
- Gmail AI Inbox（2026-01）：VIP 识别 = 通信频率 + 通讯录 + LLM 关系推断。

**转化为 backlog（按价值排序）：**
1. 「提案-动作」回流通道（Agent Inbox 模式落地，解决缺口 1）—— 等用户拍板后细化方案。
2. triage 增加 action-required 显式信号（已验证模式），attention 优先级判据引用它。
3. matter stale 自动跟进（Motion 模式）：超过 N 天无证据的 in_progress matter 生成「要不要催/关」卡。
4. 用户规则入口显性化（前端）。

**用户拍板（2026-06-11 晨）：** ① 回流通道：做 ✅（第 10 轮已落地）；② 飞书推送：先不做；③ 代码：先不提交。

### 2026-06-11 第 10 轮：MVP31 提案-动作回流（最小版）落地

- 链路：turn_done → attention 来源 topic（绑 matter）→ 取末条 assistant 消息 → aiisn-chat-conclusion
  判定（resolved/progressed/blocked/no_change + confidence）→ resolved≥0.75 升「确认办结」提案卡
  （确认办结 / 还没完继续跟）→ 确认即 userResolveMatter → 下轮 tick 自动清催办卡。
- 设计：AI 只提案不直改状态（渐进放权第一档）；提案卡「还没完」不学 not_relevant 负反馈；
  同事项提案去重；判定失败静默放弃。
- 新增/改动：chatConclusionPrompt/Service、agents.ts 注册、protocol/types 加 matter_resolve、
  projection 提案卡专属按钮、cardsService 执行器、interactions union、index 接线。
- 验证：判定正反例（resolved 0.95 / no_change 0.95）✓；合成数据全链路（升卡→确认→resolved）✓；
  双端 typecheck + 单测 ✓。生产路径待真实 ask_agent 点击验证。

### 2026-06-11 第 11 轮：新失败模式根因（磁盘+opencode.db 膨胀）+ 日常维护任务

- 现象：2h 内 77 个 exit=1 失败，stderr=`Failed to run 'PRAGMA wal_checkpoint(PASSIVE)'`。
- 根因：磁盘 99% 满（仅剩 6.9GB）+ opencode.db 三周膨胀到 592MB（每天 200+ 一次性 session
  从不清理，10351 个 session / 14 万 part 行），checkpoint 在高水位下间歇性失败。
- 处置：`opencode db` 是只读 → 用 sqlite3 小批量（500/批 × 短事务 + 逐批 TRUNCATE checkpoint，
  低磁盘下避免大事务 WAL 膨胀）删 14 天前 session：10351→1152；VACUUM：**580MB→24MB**，
  磁盘可用 6.9→7.4GB。
- 固化：新增 maintenance.ts —— 每 24h 自动清理 14 天前 opencode session（启动后 5min 首跑，
  不做 VACUUM 留给手动）。typecheck/单测 ✓。
- 磁盘清理（用户授权「清安全缓存」）：删 go-build 4.4G / goimports 1.4G / Homebrew 1.6G /
  pip 895M / 各类更新器残留 ~4.3G / playwright 旧版本 —— **可用 7.4GB → 21GB（99%→95%）**。
  跳过运行中应用缓存（飞书/微信/Chrome/Codex/JetBrains）。清理后生产 run 全绿（exec 15-43s）。
- 顺带：matter 过期跟进卡（Motion 模式）实查 0 个 ≥4 天无进展的事项 → 暂缓，列入观察。

### 2026-06-11 第 12 轮：action-required 信号（prompt v3）+ 两个卡片质量 bug

- 行动导向落地（已验证的 Outlook 模式）：unit 行透出 \`[action=act/ask]\` 标签（原来模型看不到
  actionability 字段）；优先级判据加"同等紧迫度下需用户行动 > 纯信息"；P0/P1 suggestedAction
  必填且必须具体。ATTENTION_PROMPT_VERSION → v3。
- 修 bug①：supersede-only 卡识别只认全等 'supersede'，模型写带后缀的泄漏成真卡 → 改宽匹配
  （startsWith + 有 supersedeIds）。
- 修 bug②：卡片标题用相对日期（"明天14:00"）跨天后变错 → prompt 禁止 title 用相对日期（用 6/11
  这类绝对式），why 里可用。清掉 2 张存量坏卡。
- 自身教训：sqlite datetime('now') 与库内 ISO 'T' 格式比较会失真（误报 89 失败），
  时间过滤一律用 strftime('%Y-%m-%dT%H:%M:%S',...)。
- 验证：typecheck + 单测 ✓；缓存设计小瑕疵记录在案（cache 按 input_hash 不分 prompt 版本，
  TTL 5min 可接受）。真实 v3 LLM run 的行动导向效果待下轮看板审查。

### 2026-06-11 第 13 轮：v3 复查 + 防抖升级盲区修复

- v3 复查：10 run 全 ok；绝对日期生效（"6/11 14:00"）；P0/P1 suggestedAction 全覆盖 ✓。
- 新盲区：模型升级卡片优先级（P2→P1）时不声明 supersedeIds → 跨优先级同内容双卡
  （Francis 评测集 / 豆包Pro / Badcase 三例）。防抖扩展：内容等价（同 matter 或同 signal 集）
  但 priority 不同 → 自动替掉旧卡。清 3 张存量双卡。
- P0=4 略超从严线：第 4 张是今天 14:00 的会（合理 P0），观察自我修正，不干预。
- MVP31 仍未被真实触发（今天 0 次 ask_agent）。

### 2026-06-11 第 14 轮：防回归加固 + 唤醒 66 个休眠测试

- 体检全绿：30min 9 ok 零失败、零重复、P0 自行收敛回 3。
- 闸门逻辑抽成 `llm/llmGate.ts`（纯函数工厂，可测）；chatConclusionService.parseVerdict 导出。
- 新增 test/loop-hardening.test.ts：闸门并发上限/FIFO/高优插队/release 唤醒 ×4、
  authWatchdog 模式识别 ×2、parseVerdict 解析 ×3。
- 发现 test/ 下有 **66 个测试文件**但 test:unit 只跑 1 个（hardcode）→ 改为 glob 全量。
  唯一失败是 scheduler-skip-triage 断言旧源码实现 → 更新为断言新行为（skip 行即时标 processed）。
- **全量 470 测试通过** —— 本周 13 轮全部改动在完整套件下零回归。

**经验：**
- coding-plan 类 provider 近似单并发，客户端必须自己串行化，否则并发越高失败越多。
- 超时必须显著高于真实 p95，否则「超时 → 重试」反而是负载放大器。
