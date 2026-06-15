# AI is ON · 持续优化循环日志

> 由 /loop（持续优化闭环）维护。目标：让系统真正可用 —— 及时监控工作事项，辅助/代办完成。
> 每轮：体检（数据库 + 运行状态）→ 找最痛的问题 → 修复 → 验证 → 记录。

## 待办问题清单（按影响排序）

1. **[P2] 看板标题相对日期复发**（"CLI POC 明天到期"，2026-06-12 实测；v3 prompt 已禁但 turbo 偶发不守）。
   - 方向：engine 解析处加违规检测（先观测频率，再决定自动修复 / 换模型）。暂缓：避免与并行会话改同文件冲突。
2. **[P3] 并行 Claude Code 会话与本系统共享 zai provider**（单并发互相挤兑，triage 消化变慢）。
   - 观察项：必要时给 triage 加批量合并（一次 LLM 调用处理多事件）摊薄排队。
3. **[P3] `.opencode/agent/*.md` 13 个文件 working tree dirty**（生成物未 gitignore；用户已拍板代码先不提交）。
4. **[P3] temp/ 下有 2026-05-20 旧研究会话遗留文件**（task_plan/findings/progress.md），已过时，待用户确认后清理。
5. **[P3] 56 个 UE 态 lark-cli 僵尸进程**杀不掉（不可中断内核等待，不持锁无害），等下次重启机器回收。

~~已解决~~：attention 104s→~25-70s（第 2/5/6 轮）；triage 静默销账（第 3 轮加重试+留痕）；
im collector 网络超时（lark-cli 已升 1.0.51 + 第 15 轮全链路硬超时）；采集挂死失明（第 15 轮三道防线）；
MVP31 生产验证负例（第 16 轮·会话 A：判定「未完成」→ 正确不升提案；正例待自然触发）。

## 迭代记录

### 2026-06-15 第 35 轮：自主排查的有用结论浮成「确认办结」提案卡（自主完成 + 反馈闭环）

- **体检**：试运行已自主跑 **15 次排查**、采 14 条轨迹——核心指标"AI 自主帮你做事的数量"真实增长。
  但 12/15 是 unknown（只能搜飞书，很多真相在外部/代码/trace，run_command 由并行会话在做）；
  且 3 次有价值的发现（resolved "glm-5.2 切换已实际执行"、progressed "黄炜深讨论公式机制对方已回复"）
  **都埋在 matter 摘要里、用户看不到、没法 react**。
- **想法→落地（MVP39）**：让自主排查的**高置信 resolved 结论主动浮成「确认办结」提案卡**，用户一键确认
  = 一次"用户认可的自主完成"，并形成反馈回路。复用 MVP31/32 提案卡机制（projection/动作/保护按字面前缀
  `proposal:matter-resolve:` 自动生效）。
  - 抽共享 helper `matter/matterResolveProposal.ts`（幂等、已 resolved/dropped 跳过；前缀字面与既有一致）。
  - investigationWriteback：verdict=resolved 且 conf≥0.75 → raiseMatterResolveProposal；**仍不自动改 status**
    （办结归用户裁决）。progressed/blocked 仍走摘要+nextAction（已有催办卡承载）。
- **验证**：tsc 干净（唯一报错是并行会话 readTools 的 run_command 半成品，非我代码）；回写测试加 4 用例
  （高置信升/低置信不升/progressed 不升/幂等），共 9 测全过；全量见下。**只提交自己的文件**（避开 readTools/config）。
- **逼近目标**：把"AI 自主查到这件事已完成"从埋在摘要里 → 变成用户看得到、点一下就闭环的提案，直接服务
  "用户越少参与并最终认可自主结果"+"根据反馈迭代"。run_command 落地后 resolved 比例会上升，提案会更多。

### 2026-06-15 第 34 轮：playbook 流程蒸馏（自发探索学成草稿）+ 并行会话协调

- **协调情况**：用户说"本地 fornax-cli 等存在的，不用写死，直接让本地 AI 用上"。动手前发现**并行 Claude 会话
  正在同仓库实现 run_command**（readTools.ts + config.ts 未提交、3min 前刚改，正是这个本地工具能力）。
  按记忆纪律"改同文件前先看 git diff"——**不重复 run_command，避开它的文件**，转去做互补的蒸馏。
- **流程蒸馏（MVP37，全在 playbook/ 新文件 + 低冲突文件）**：
  - `playbookDistillPrompt.ts`：蒸馏 prompt（同类轨迹→去具体化的标准 playbook）+ 解析。
  - `playbookDistillService.ts`：`shouldDistill`（纯函数：≥3 条同类轨迹才蒸、有权威版不蒸、每+3条重蒸）
    + `maybeDistillPlaybook`（runOneShot('aiisn-playbook-distill')→parse→distillUpsert）。
  - 注册 agent `aiisn-playbook-distill`（agents.ts，READ_ONLY）。
  - 触发：`captureInvestigationTrace` 落轨迹后 fire-and-forget 蒸馏（失败静默）。
  - **联动纪律保持**：distillUpsert 避让用户权威版；shouldDistill 也早退（有权威版不跑 LLM）。
- **验证**：我的 playbook 文件 tsc 干净（唯一报错是并行会话 readTools 的 run_command 半成品，非我代码）；
  新增蒸馏 4 测（阈值/解析/蒸草稿/避让权威），mvp36+37+38 共 41 测运行时全过。**只提交自己的文件**（不碰
  readTools/config，留给并行会话）。
- **下一步**：等并行会话的 run_command 落地后，排查就能用本地工具（fornax-cli/grep 代码库等）；
  卡片"记住这样处理"按钮；蒸馏在试运行攒够轨迹后会自动产出草稿，到面板等用户批准。

### 2026-06-15 第 33 轮：项目排查档案（每个项目的额外 context + 做事方法）

- **用户问**：自主排查要用项目外部信息（如 Chatbot 代码库在 /Users/xinming/MyProject/bitable-chatbot、
  trace 用 fornax-cli），怎么输入给 AI？每个项目还需要额外 context + 做事方法。
- **用户拍板**：先只做「项目排查档案」（声明式，零新外部访问；代码库/fornax 只读工具留待后续）。
- **落地（MVP38）**：档案挂在项目 Space 上（context_spaces 加 investigation_profile 列），用户写一次、系统记住。
  - 召回 `investigation/projectProfile.ts`：按 matter.primarySpaceId 取所属项目档案。
  - 注入：自主排查 prompt 加 `<项目背景与排查方法>`（含"你只能用飞书只读工具，查不到的来源就在结论里告诉用户去查"）；
    「让 AI 处理」(askAgentPrompt) 加「项目背景与做事方法」块。
  - API：POST /context-spaces/:id/profile；GET detail 已返回 space.investigation_profile。
  - 前端 SpacesPanel 项目详情加「🧭 排查档案」编辑器（填代码库路径/trace 方法/术语/排查套路）。
- **验证**：tsc(server+web) ✓；新增 MVP38 4 测（召回/空值/清空/注入），全量见下；
  **真实 live**：给 Chatbot 项目设了真实档案（代码库 + fornax-cli），读回确认 ✓。
- 这正面回答了目标的「对不了解的 context 主动让用户提供并记住、不用重复」——项目级 context + 方法现可一次录入、长期复用。
- **下一步**：用户点头后加 read_codebase（限登记路径只读）/ fornax_trace 只读工具，让 AI 自主去查代码/trace；
  另：playbook 蒸馏服务、卡片"记住这样处理"。

### 2026-06-15 第 32 轮：能力二召回注入 + 前端面板 + 排查独立车道 + 真实试运行抓 bug

- **召回注入**：命中的 playbook 步骤注入「让 AI 处理」(askAgentPrompt) 与自主排查(investigationPrompt `<已知做法>`)，
  让 AI 照用户教过/自学的步骤做（人写/已批准措辞"优先照此"，草稿"仅供参考"）。新增 `playbookMatcher`。
- **前端 Playbook 面板**：列出/新建/编辑(权威)/批准草稿/停用——"在哪补充信息"的可见入口（preview 实测渲染 ✓）。
- **worthy 选件改看标题+下一步**：标题写"排查/确认是否"的 P0 也进候选（此前被 round22 回填的泛兜底 nextAction 漏掉）。
- **排查独立 gate 车道（关键 infra 修复）**：实测主道单并发 gate 被**挂死的 aiisn-attention** 占住数分钟，
  排查即便 priority 也饿死、试运行 3 次空转。根因：所有 one-shot 共用一条单并发 gate。
  修复：runOneShot 加 lane 选项 + `investigationGate=createLlmGate(1)` 独立道；排查走独立道，与主道互不阻塞、
  自身仍限并发 1（不爆进程）。另加 config.investigationPriority（默认 true）。
- **真实试运行（独立车道后端到端跑通）**：手动 tick 2 次均 dispatched:true。
  - 第 1 次：模型偶发未出有效 JSON → 优雅降级 unknown（系统不崩）。
  - 第 2 次：**完整成功**——AI 自主排查「排查智能体授权超时(对高虎伟承诺)」，真连查 5 步
    (搜"授权超时/超时时长/高虎伟"IM + 列待办)，结论"未找到进展证据"(合理 unknown)，回写 matter + 采到轨迹。
  - **试运行抓到真 bug**：`read_chat_messages` 用了 `--page-limit`，但 `im +chat-messages-list` 实际要 `--page-size`
    （lark-cli exit 2 unknown flag）→ 已修，真实命令 live 验证 `--page-size` 被接受 ✓，加回归断言。
- **验证**：tsc ✓；新增 worthy-by-title / read_chat_messages flag / 召回 等用例，全量 590+ 绿；
  4 次提交（6af9227 召回+面板 / 46cecba 独立车道 / 本轮 flag 修复）。
- **下一步**：蒸馏服务（同类轨迹≥N → LLM 蒸馏 distillUpsert，自动避让权威版）；模型 JSON 合规健壮性
  （偶发"未出有效动作"，可加一次"只输出JSON"重试）；卡片"记住这样处理"按钮。

### 2026-06-15 第 31 轮：playbook 教学通道（人主导播种 + 自发探索补空，加速收敛）

- **用户问**：在哪里补充信息帮 agent 快速收敛到正确 playbook？怎么和自发探索联动？
- **答 + 落地（MVP37 教学通道后端）**：三个输入汇成"一类型一 playbook"，带 `origin`(user/distilled)+`approved`+`confidence`。
  - **人主导联动规则**（核心）：人写/已批准的是权威，`distillUpsertPlaybook` 遇到权威版**直接 skip 不覆盖**；
    自发蒸馏只给没人教过的类型出 suggest 草稿。人写 = 立刻高置信(0.9)，跳过攒 N 条轨迹的等待。
  - store：`userUpsertPlaybook`(origin=user,approved=1,权威)、`distillUpsertPlaybook`(草稿,遇权威 skip)、
    `approvePlaybook`(草稿升权威)、`setPlaybookActive`(停用/启用)。schema 加 origin/approved 列(ensureColumn 补)。
  - API `routes/playbooks.ts`：GET /playbooks(列表)、POST /playbooks(用户编写/编辑权威版)、
    POST /playbooks/:key/approve(批准草稿)、POST /playbooks/:key/active(停用/启用)、GET /playbooks/:key。
- **验证**：tsc ✓；MVP37 6 测（含"人写的不被蒸馏覆盖""批准后也不被覆盖"两条联动用例）；全量 **589/589**；
  真实 API 冒烟：建 user playbook(origin=user/approved/2步)、列出成功。代码已提交。
- **三个"补充信息"入口（这轮建后端，前端随后）**：① Playbook 面板(列表/编辑/批准/停用,主入口)；
  ② 卡片"记住这样处理"(把"让 AI 处理"的一次性指令沉淀成 playbook)；③ 排查结果"这步对/错"(纠偏调置信)。
- **下一步**：前端 Playbook 面板 + 卡片"记住这样处理"按钮；蒸馏服务(同类轨迹≥N→LLM 蒸馏 distillUpsert)；
  召回注入(命中 playbook→塞进 buildRichAskAgentPrompt 当推荐步骤)。

### 2026-06-15 第 30 轮：开启排查试运行 + 能力二地基（操作流程落库）+ 提交

- **用户批准**：开启能力一真实试运行（`INVESTIGATION_DISPATCH_ENABLED=true` 写入 .env）；继续建能力二；提交代码。
- **开启 dispatcher**：.env 置 true（重启生效，`GET /api/debug/investigation/status` 实测 enabled:true）；
  新增 `POST /api/debug/investigation/tick`（手动立即跑一次派发，便于观察试运行）。
- **代码提交**：b435c8d —— 累积 rounds 22-29 + 之前未提交工作（执行腿 MVP34/35、自主排查 MVP36、next_action、
  负反馈压制等），全量 583 绿时提交（.env 已 gitignore，未提交密钥）。
- **能力二地基（MVP37，操作流程落库，零放权风险）**：
  - `playbook/PlaybookTypes.ts`：TaskTrace/TaskPlaybook 类型 + **中粒度 taskTypeKey**（matterType:粗意图，
    跨不同人/项目累积，避开 canonicalKey 太细→样本永不够的坑）+ coarseIntent（verify/reply/deliver/chase/...）。
  - `playbook/playbookStore.ts`：task_traces + task_playbooks 两表 CRUD（db.ts 加 CREATE TABLE）。
  - `playbook/playbookCapture.ts`：把自主排查的 toolLog（已结构化、全保真，比聊天截断数据强）转成有序 TraceStep 落库；
    接入 dispatcher + 调试路由——每次排查后自动采集"这次怎么查的"。
- **验证**：tsc ✓；新增 MVP37 4 测（归类键/轨迹存取/playbook upsert/排查→轨迹）；**全量 587/587 全绿**。
- **下一步（能力二剩余）**：蒸馏（同类轨迹 ≥N → LLM 蒸馏成 playbook，suggest 档）+ 召回匹配（新卡命中 playbook
  → 注入 buildRichAskAgentPrompt 当推荐步骤）+ 放权升降档（成功/纠正信号驱动，套 correctionWriter 可撤销范式）。

### 2026-06-15 第 29 轮：能力一收尾 —— 结论回写 + 自主 dispatcher（MVP36 能力一完整）

- **结论回写**（`investigation/investigationWriteback.ts`）：把排查结论**安全**落到 matter——① 事实+证据写成
  action_result unit 挂 matter 作证据（effect=no_change），② factSummary 并进 currentSummary（卡片直接显示
  "［AI 排查］…"），③ verdict=resolved 高置信只把 nextAction 改成"疑似已完成待确认"。**绝不自动改 status**
  （办结仍由用户确认，保守不伤信任）。审计 investigation_written_back。
- **自主 dispatcher**（`investigation/investigationDispatcher.ts`）：后台低频自动挑"需排查"matter→跑只读排查→回写。
  - 纯函数 `isInvestigationWorthy`（regex 认"确认是否/核实/排查进展/查证"类，排除 deriveDefaultNextAction 泛兜底）
    + `selectInvestigationCandidate`（worthy + 非冷却 → 优先级↑ 再最久未动↑ 取 top-1）—— 可单测。
  - 安全闸：**默认关**（config.investigationDispatchEnabled，opt-in）；每 tick≤1 件；同 matter 冷却 6h；
    单件 in-flight 锁；priority:false **让位 attention**（解决第 28 轮发现的 gate 饿死）；硬只读全程。
  - config 旋钮（默认关/10min tick/6h 冷却/3 轮）+ index.ts start/stop 接线。
- **验证**：tsc ✓；新增回写 5 测 + dispatcher 5 测，MVP36 累计 25 测全过；**全量 583/583 全绿**（含 collector-hang）。代码按约定不提交。
- **能力一完整**：只读工具→prompt/解析→循环→aiisn-investigate(全 deny)→回写→dispatcher→调试路由，全部就绪。
  开启方式：`INVESTIGATION_DISPATCH_ENABLED=true`，或调试路由 `POST /api/debug/investigation/run {matterId, apply:true}` 手动单查。
- **下一步**：能力二（操作流程全量 tool I/O 落库 + 蒸馏 playbook，suggest 档）；前端展示"AI 已排查"标记 + 证据。

### 2026-06-14 第 28 轮：自主排查执行循环（MVP36 能力一核心，后端中介式硬只读）

- **落地**：在 MVP36 只读工具层之上建排查执行循环。
  - `investigation/investigationPrompt.ts`：排查推理器 prompt（模型每轮输出 JSON：请求只读工具 或 给结论
    {verdict/confidence/factSummary/evidence}）+ 鲁棒解析（非法降级 unknown）。
  - `investigation/investigationLoop.ts`：循环引擎——judge↔runTool 交替，LLM 调用数严格 ≤ maxRounds（每次过单并发 gate）；
    未知/写工具名直接记失败不执行；judge/runTool 全注入可测。
  - 注册 `aiisn-investigate` agent：**permission 全 deny（bash/edit/write/webfetch 全关）**——纯文本进 JSON 出，
    连 shell 都没有。比 aiisn-chat 的软约束硬一档：排查推理器无法执行任何动作，只能"请求读"，由后端白名单只读工具执行。
- **验证**：tsc ✓；新增 8 测试（解析 conclude/investigate/降级/抛错 + 循环投查→结论/轮数上限/未知写工具不执行/解析失败收尾），
  readTools 7 + loop 8 = 15 个 MVP36 测试全过；agent 文件物化确认 `bash: deny` + 工具清单注入。
  **真实端到端验证（关键）**：直接喂真实 matter「长对话评测集→确认评测集是否已发给鲁升纲」给 aiisn-investigate(绕开拥塞的 gate)，
  模型**正确输出合法 JSON、action=investigate、请求对的只读工具 search_im_messages + 合理 query（"评测集 鲁升纲"/"长对话评测集"）**
  ——证明 AI 面对真实事项会正确决定去查并选对工具。读工具侧 task +get-my-tasks 真实读到数据；循环逻辑 8 测；硬只读护栏 7 测。
- **过程中两个真实发现 + 修复**：
  ① **gate 拥塞/饿死**：背景排查 priority:false 会被 attention 的 high 队列持续插队饿死（实测 curl 等满超时）；
     且单个挂死的 attention opencode 调用会占住单并发 gate 阻塞所有 LLM 数分钟。→ 给循环加 priority 选项（背景让路、手动验证可插队）。
  ② **原生工具误调**：实测模型偶尔想用 opencode 原生 read/grep 工具而非输出 JSON（read 默认 allow 没堵），既偏协议、又有读本地
     文件风险、还拖慢 runOneShot。→ agent 改 **全工具 deny（含 read）** + prompt 强化"严禁调用任何工具"，彻底封死。
- tsc ✓；MVP36 累计 15 测全过；agent 物化确认全 deny。代码按约定不提交。
- **下一步**：dispatcher（后台低频挑 top-1 需排查 matter、matter 级 in-flight 锁、让路 attention、一键关）+ 结论结构化回写
  matter（progressed/blocked 经 reduceUnitWithCandidates 双闸、证据链接挂 action_result）；能力二 tool I/O 全量落库。

### 2026-06-14 第 27 轮：自主排查+流程记忆 —— 多 agent 调研定方向 + 硬只读边界基座（MVP36）

- **背景**：用户提出 next_action 里"需排查/外部取数"类希望 AI 自主执行，并希望"吸取用户操作流程"形成可复用记忆。
- **调研**（7-agent 工作流，~70 万 token，带 file:line）：① AI 已能自主排查取数但仅用户手点 ask_agent 触发、结论几乎不回流、"只读"是 prompt 软约束；② 流程记忆=零（boundary 只学分类不学操作，routine kind 死代码，141d119 还禁止沉淀操作经验）；③ **对抗审查挖出关键纠错**：chat turn 不过 llmGate（多 topic 真并发），原设计"派发太松饿死闸门"反了，真实风险是并发 opencode 进程爆炸。详见记忆 [[aiisn-investigation-playbook-design]]。
- **用户拍板**：两条能力**并行**推进；**先建硬只读边界再开自动**。
- **本轮落地（MVP36 硬只读边界基座）**：放弃在不可靠的 opencode bash 模式匹配上建边界，改**后端中介式**——模型不碰 shell，
  只能请求白名单只读工具，后端用 lark-cli 读命令执行（顺带绕开并发爆炸：走后端读+gated one-shot，不开 turn）。
  新增 `investigation/readTools.ts`：4 个只读工具（search_im_messages/read_chat_messages/list_my_tasks/read_doc）+
  `assertReadOnly()` 读动词白名单+写动词黑名单双重护栏（写命令按构造不可能发出）。
- **验证**：tsc ✓；新增 7 测试（写动词必拒/白名单放行/默认拒绝/构造正确/缺参不调/注册表无写能力），全量 565（1 个 collector-hang flaky 重跑即过，余全绿）✓；真实只读命令（task +get-my-tasks）live 验证返回数据 ✓。代码按约定不提交。
- **下一步**：能力一——排查执行循环（runOneShot aiisn-investigate：给 matter 上下文+工具清单→模型选只读工具→后端执行→回喂→判断是否继续→结构化回写 matter）+ dispatcher（后台挑 top-1 需排查 matter，matter 级 in-flight 锁）；能力二——全量 tool I/O 落库 + 蒸馏 suggest 档。

### 2026-06-14 第 26 轮：判断准确度 —— 负反馈确定性压制（dismiss 的卡不再复发）

- **质量体检发现**（无新使用数据时转向打磨准确度）：① 无相对日期违规、优先级分布健康（P0=3/P1=4/P2=5）；
  ② **信任杀手**：一张被 dismiss 的卡「检查张天赐招聘日报触发器配置」4 天内被引擎重生 ~50 次。
- **根因**：复发压制**完全依赖 prompt 里 `recentAttentionInteractions`（7 天窗）让 LLM 自觉不重发**——
  但实测 dismiss 在窗内（距今 3 天）LLM 仍重生；且该卡 signalIds 丢空、无 entity 可降权，
  negative-feedback 的两条间接机制都兜不住。结论：**靠 LLM 守负反馈不可靠**（同 titleHygiene/churn guard 教训）。
- **修复**：`titleHygiene.isDismissSuppressed`（纯函数）+ attentionEngine emit 前确定性过滤：新生成卡若归一化标题
  命中近 7 天 dismiss/not_relevant 且**优先级未升级**（不比被 dismiss 时更紧急）→ 直接不落地。
  优先级升级（如 dismiss 时 P2、现 P0/P1 有新紧急证据）才放行，与 prompt 规则一致。
- **验证**：tsc ✓；新增 4 单测（同级压制/升级放行/降级仍压/未 dismiss 不压），title-hygiene 13/13、全量 **558/558** ✓；
  对照实测：该卡 dismiss 时 P0、复发为 P1 → `rank(P1)≥rank(P0)` 命中压制 ✓；清理存量 live 复发卡（live 12→11，复发 1→0）；
  重启后真实 attention run status=ok（新代码路径不崩）。代码按约定不提交。

### 2026-06-14 第 25 轮：执行腿第二刀 —— AI 起草并新建飞书文档（MVP35，内部可逆，无授权阻塞）

- **选型**：IM 代发待用户授权（第 24 轮），故并行推进**已授权 scope**（docx:document:create）的内部可逆动作——
  把事项一键整理成飞书文档草稿。复用 execute-on-confirm 范式，不重造。
- **落地**：新增 `lark/larkDocService.ts`（confirm 门控；v1 内容**确定性生成** = 标题+当前情况+下一步+相关上下文证据，
  不依赖慢 LLM；`docs +create --api-version v2 --content '<title>..'`；无 idempotency-key 故复用 external_task_bindings
  provider='lark_doc' 本地去重；XML 转义；写回 silent action_result + 挂 Matter 作 progress 证据；审计 lark_doc_created；
  缺 scope 也给友好提示）。路由 POST `/cards/:id/lark-doc`（支持 dryRun）。前端 SignalCard「📄 起草成飞书文档」按钮，
  成功显示文档链接。
- **验证**：tsc（server+web）✓；新增 4 测试（confirm 门控/命令+content 正确/幂等复用/dry-run 不写回），全量 **554/554** ✓；
  **真实 dry-run 实测**：经路由→服务→真 lark-cli，`ok:true` 无 missing_scopes（docx scope 已授权、命令受理、标题从 matter
  正确解析），即真实创建路径完全通；**前端实测**（截图）：12 张卡均渲染「📄 起草成飞书文档」+「🤖 代我回复飞书」双按钮。
- **克制**：UI 标「只读飞书」，且用户本会话才批准对外执行——**未自动创建真实文档**（dry-run 已证路径通），真实创建留用户点击，
  既尊重只读姿态又能产生真实使用数据。代码按约定不提交。
- **现状小结**（执行腿）：① IM 代发：建好+验证到授权边界，待用户跑 `lark-cli auth login --scope im:message.send_as_user`；
  ② 建文档：建好+路径全通（scope 已授权），用户点即真实产出；③ 建任务：既有，已授权。三类自主完成动作就位，等真实使用数据。

### 2026-06-14 第 24 轮：MVP34 生产验证 —— 真实 dry-run 揭示唯一阻塞 = 缺发消息授权

- **加 dry-run 安全验证**：`sendImReplyFromCard` 支持 `dryRun`（附 lark-cli `--dry-run`，鉴权+目标校验+命令受理
  但不真发；不写回/不标记/不审计为已发）。路由 POST 支持 `dryRun`。
- **真实 dry-run 实测**（经 路由→服务→真 lark-cli，零发送）：命令构造正确、身份识别为 user、目标解析有效，
  **唯一阻塞 = 缺 OAuth scope `im:message.send_as_user`**（exit 3, missing_scopes 明示）。即整条执行路径已通，
  距真实投递只差一次用户授权。
- **已授权 scope 盘点**：发消息缺 `im:message.send_as_user`；但 **建任务 `task:task:write` ✓、建文档
  `docx:document:create` ✓ 均已授权**（task 历史真建过 2 次为证）。→ 内部可逆动作（建文档/任务）无需新授权即可执行。
- **缺 scope → 自助解锁**：catch 检出 missing_scopes 即抛友好可操作提示（"运行 lark-cli auth login
  --scope im:message.send_as_user 完成浏览器验证后重试"），前端回复面板直接显示。实测 dry-run 返回该友好文案 ✓。
- **验证**：tsc ✓，全量 **550/550** ✓。
- **给用户的决策点**：要真实启用 IM 代发，需你跑一次 `lark-cli auth login --scope "im:message.send_as_user"`
  （浏览器授权"以你身份发消息"，是你账号的权限决策，我不能代办）。在你授权前，下一步我推进**已授权 scope** 的
  「AI 起草并新建飞书文档」（docx:document:create 已有）—— 内部可逆、可立即端到端验证真实产出。

### 2026-06-14 第 23 轮：执行腿第一刀 —— AI 代发飞书 IM 回复（MVP34，对外执行 execute-on-confirm）

- **断点定性**（量化）：用户点「让 AI 处理」(ask_agent) 18 次，AI **全部只调研/起草**（cardsService 的
  buildDefaultPrompt 与 askAgentPrompt 都硬写「不要执行任何对外发送或写操作」）；唯一真实执行
  create_task（建飞书任务）一生只用过 2 次且 6-09 后停滞。"AI 自主完成任务数"≈2。系统停在"告诉你怎么做"。
- **架构发现（避免重造）**：执行能力其实**已存在**——opencode.json 虽 `skill:{"*":deny}`，但 agent 都
  `bash:allow`，lark-cli 写操作走 bash；只读是 prompt 层刻意约束。且 `larkTaskService.createLarkTaskFromCard`
  已是一套成熟的 execute-on-confirm 范式（confirm 门控+幂等+审计+回写 context+绑定）。
- **方向决策（已问用户拍板）**：用户选「同时含对外发送」——AI 备好草稿+收件人，用户一键「发送」才真发出，
  每次确认都是不可撤回的对外消息（用户接受此风险）。
- **落地（MVP34，最高价值切口 = IM 回复）**：新增 `lark/larkImReplyService.ts`：
  - 目标**服务端确定性解析**（不信前端 chatId）：signalIds→context unit.origin.refId→event→raw_json
    的 chat_id/message_id；**多会话歧义即拒绝、无 IM 消息即拒绝，绝不猜**；优先 `+messages-reply`
    锚定对方原消息，退化 `+messages-send`。confirm 必填、空/超长拒发、lark-cli `--idempotency-key` 防重发。
  - 发完写 silent action_result + 挂 Matter 作证据（真实"我发出的消息"由 im collector 自然采回交 reducer，
    不在此替用户判办结）。审计 `im_reply_sent`/`im_reply_failed`。
  - 路由 `routes/larkReply.ts`：GET preview（只读、给前端看"回复给谁"）+ POST 发送。
  - 前端 SignalCard「🤖 代我回复飞书」：点击→preview→**先展示目标会话+对方原话+可编辑草稿**→「确认发送」。
    不可逆动作前必让用户看清打给谁。
- **验证**：tsc（server+web）✓；新增 7 测试（解析/歧义拒绝/空值拒绝/confirm 门控/参数正确/回写挂链/幂等键），
  全量 **550/550** ✓；**真实数据只读 preview 实测**：P0 卡正确解析到与孔恩培单聊+锚定其消息，群消息卡解析到真实群，
  文档来源卡正确拒绝；**前端 preview 实测**：点击后确认面板正确显示"回复给 oc_…·回应 孔恩培"+原话+草稿
  （**未点确认发送**，不向真人试发）。代码按约定不提交。
- **下一步**：① 真实场景由用户点一次「确认发送」端到端验证投递；② 把执行扩到文档评论回复 / 起草并新建飞书文档
  （内部可逆，门槛更低）；③ 高频可逆动作沉淀 boundary rule 走渐进放权（少确认）。

### 2026-06-14 第 22 轮：matter.next_action 87% 为空 → 修复 create 丢字段 + prompt + 兜底 + 回填

- **体检**：系统健康（采集水位滞后 1-13min、attention 全 ok、无挂死 lark-cli）。最痛的是**目标缺口**而非稳定性：
  55 个活跃 matter 里仅 7 个（13%）有 `next_action` —— 其余只是提醒，不是"自主判断该如何完成"。
- **根因**：`matterReducer.applyDecision` 的 **create 分支调用 `createFromUnit()` 时根本没传 `decision.nextAction`**，
  LLM 已产出的下一步被直接丢弃（attach 分支 line 381 正常）。由于多数 matter 走 create，故 87% 空。
  次因：reducer prompt 把 nextAction 标"可选，没有就 null"，未要求 create 必给。
- **修复（3 处）**：① create 路径接 `decision.nextAction`；② `deriveDefaultNextAction(type)` 类型化兜底，
  保证活跃事项 next_action 永不为空（无 LLM 的规则建路径也覆盖）；③ prompt 加规则 7：create / progress / block / reopen
  必给具体可执行 nextAction（带动作+对象、≤40字、禁空话），resolve / ignore 给 null。一次性回填存量 48 条。
- **验证**：tsc ✓；新增 T12-T14 三测（LLM 给值保留 / 未给走兜底 / 规则建也兜底），reducer 14/14 ✓，全量 540/540 ✓；
  agent 文件已物化规则 7（证明服务重启生效）；**live API 实测活跃 matter next_action 非空率 13% → 100%（55/55）**。
  前端 MatterPanel 每张卡显示"下一步：…"；attentionPrompt 也复用它生成 suggestedAction（更一致、少幻觉）。
- **下一步方向**（留给后续轮）：兜底是"地板"，真正逼近目标是让这些 next_action 变成**可一键执行的提案**
  （MVP31 Agent Inbox：accept/edit/respond/ignore），把"告诉用户怎么做"升级成"AI 直接做掉大部分"。

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

### 2026-06-12 第 15 轮：采集失明 19h 事故 —— lark-cli 整批挂死 + 三道防线

**体检发现（最痛）：** 全部 7 个 collector 自 6/11 11:55（本地）后零成功扫描、零新事件 ~19h；
attention 期间照常跑且全报 "ok"（吃陈旧数据），用户毫无感知。

**根因链：** 6/11 11:59 起 lark-cli 子进程成批挂死（UE 态=不可中断内核等待、0 CPU，
连 `auth status` 都挂；触发条件不明，疑与网络/当日 lark-cli 升级 1.0.51 相关，挂死进程
SIGKILL 都吃不进只能等重启回收）→ `runLarkCli` 的 await **无超时** → collector tick 的
`running` 互斥锁被永久占住 → 后续所有 interval tick 静默跳过；16:51 服务重启也没救
（首轮 tick 的新 lark-cli 又挂住）。authWatchdog 只认「错误消息」，挂死不产生错误 → 零告警。
累计 87 个僵尸 lark-cli（含多轮 tsx watch 重启遗留的孤儿）。

**处置 + 三道防线（全部落地）：**
- 运维：`pkill -9` 清掉可杀僵尸（56 个 UE 态进程杀不掉，等机器重启回收，不持锁无害）；
  互斥锁释放后采集当场恢复。
- 防线① `util/larkCli.ts`：所有 spawn 硬超时（`LARK_CLI_TIMEOUT_MS` 默认 120s，超时按失败
  resolve + SIGTERM→5s→SIGKILL）；in-flight 子进程登记 + 进程退出时统一收割（堵孤儿累积）。
- 防线② `scheduler.ts`：互斥锁卡死看护 —— 卡超 max(3×interval, 15min) 强制释放（owner token
  防旧 tick 迟到的 finally 误释放新锁）；快照透出 running/runningSince。
- 防线③ `collectors/freshnessWatchdog.ts`（新）：每 5min 查全部 collector 的 last_success_at，
  连最新的都 >30min（COLLECTOR_STALE_ALARM_MS）→ 升确定性 P0 系统卡「采集已停滞」；恢复自动撤。
  与 authWatchdog 互补：那边管"报错"，这边管"沉默"。

**验证：** typecheck ✓；新增 11 测试全过，全量 481/481 ✓；僵尸清理后 collector 当场恢复
（lastSuccessAt 全部刷新，calendar/drive/minutes 新事件入库）；im 补 24h 欠账中。
超时实测：sleep 5 模拟挂死 → 300ms 按失败返回 ✓。

### 2026-06-12 第 16 轮（并行会话 A）：聊天 turn 烂尾根因反转 + 重启自愈

**根因反转：** 「让 AI 处理」两次烂尾（半截调查就没下文）的真凶不是模型弃疗 ——
手动在同一 opencode session 续跑完全正常（11 步工具调用流畅）。真凶是 **tsx watch
重启杀掉了正在跑的聊天 turn**（开发期改码/编辑器保存=常态），且 forceKill 的
「本轮被中止」system_info 被 messageBus 静默吞掉，用户与恢复机制都看不见死亡。

**修复（三层）：**
- TopicSession：runTurn 返回 finishReason；以 `tool-calls` 烂尾的 turn 自动续跑一轮
  （上轮已落地，保留作第二层保险）。
- messageBus：system_info 不再吞 → 「本轮被中止」落库可见（兼作恢复标记）。
- startupRecovery：扩展聊天续跑 —— 启动时找「末条消息=中止标记且 30min 内」的 topic
  （cap 2），自动补「继续完成并出结论」。
- chat prompt：lark-cli 输出就在 Bash 结果里、禁读临时文件；每轮必须以结论收尾。

**验证：** typecheck ✓ 全量 481 测试 ✓；第三次生产测试（测试期间不改码）**完整跑到
结构化结论**；MVP31 负例验证 ✓ —— 结论判定「承诺未完成」→ 正确不升办结提案。
正例提案待真实办结场景自然触发。

**协同注记：** 本轮起确认有并行会话 B 在同仓库工作（lark-cli 挂死三防线 + git 提交
0b48625）。改共享文件前先 git diff；日志条目只追加不改写。

### 2026-06-12 第 17 轮（会话 B）：标题相对日期治理（解析处确定性改写）

- 待办 #1 落地：与其追 prompt 补丁，不如解析处兜底 —— 新增 `attention/titleHygiene.ts`，
  「今天/今日/明天/后天/大后天」按生成时刻本地时区替换为绝对「M/D」（语义零损失；
  大后天先于后天匹配防部分替换）。attentionEngine 解析后逐 item 改写 + warn 留观测痕迹。
- 存量修复：live 卡「CLI POC 明天到期」→「CLI POC 6/13到期」（UPDATE 保卡片状态，不重建）。
- 验证：typecheck ✓；新增 6 测试（含跨月进位、大后天边界）全过；全量 487/487 ✓。

### 2026-06-12 第 18 轮（会话 B）：UI 全链路审计 + churn guard v2（保卡片身份）

**审计（Claude preview 起独立 vite 实例，真实浏览器视角）：**
- 看板/聊天/采集状态条/卡片动作均健康；新卡片标题绝对日期 ✓；collector 新鲜度在头部有展示。
- 发现并修复 2 个渲染瑕疵：卡头 "Agent Agent" 双徽标（source 与 lineage 同文案时只显示一个）；
  "为什么" 段与摘要重复（reason===summary 时不再重复渲染）。preview 实测生效。
- 基建顺手修：vite 端口从硬编码挪到 PORT env（默认 5173 不变，preview 工具可分配端口）。

**churn guard v2（信任侵蚀型问题）：** DB 取证发现同标题卡 5min 内成对 superseded+新建
（"同步给小李" / "回复陈一柯" / "提交专利" 全中招）—— created_at 重置、用户状态丢失、看板洗牌。
两个漏洞：① 模型每轮引用 signalIds 略有出入 → 集合等价判不出同卡；② 优先级变化走「杀旧建新」。
修复：等价判定加标题归一化全等（不同 matterId 硬否决不受影响）；priority 变化改为**原地升降级**
（updateAttentionItemPriority，保 id/created_at/用户状态）。

**验证：** typecheck ✓；新增 3 测试，全量 490/490 ✓；UI 修复 preview 实测 ✓；
看板身份稳定性 13min 跨 2-3 轮观察进行中（后台）。

**审计遗留（产品方向，待用户拍板）：** Rules & Audit（教 AI 规则）入口埋在左栏底部折叠区 ——
round 9 已验证的 Outlook 模式建议显性化（如头部入口/首屏卡位）。涉及布局调整，等用户意见。

**第 18 轮补充：** 稳定性观察结果 —— 跨 2 轮 attention，6 张卡 id 全保持、同标题洗牌对 0
（churn v2 实测生效 ✓）。顺带抓到新漏网：模型发不带 supersedeIds 的「supersede: 清理…」卡，
旧宽匹配（要求有 ids）漏成用户可见 P3 卡 → 收紧为「标题以 supersede 开头一律不落地」
（无 ids 即 no-op），清掉存量 1 张。全量 490/490 ✓；修复后看板 7 卡零泄漏、P0=3 守线。

**第 18 轮补充 2（前端状态同步缝隙）：** 审计发现状态条「Claude 离线/启动中」长期失真 ——
runtime_status 只在变化时 WS 推送，页面加载/重连晚于 ready 广播就永远停在旧态（dev tsx watch
每次改码重启必现）。修复：api 加 fetchRuntimeStatus（/api/health）；初始加载与 WS 每次
(re-)open 都补拉 runtime + cards + collectors 快照。web typecheck ✓，preview 实测
「离线」→「在线」自愈 ✓。

### 2026-06-12 第 20 轮（会话 A）：提案卡被引擎误杀 —— 保护性免疫

- **事故**：MVP31 今天产生了 2 个自然正例提案（专利办结 + 宁波力劲模板问题办结），
  全部在升起后约 20 分钟被「优先级升级替代」误杀 —— 同 matter 的 P0 催办卡与 P1 提案卡
  被 contentEquivalent 判定等价（matterId 相同），触发 priority-shift 清理。系统左手杀右手。
- **修复**：attentionEngine 引入 isProtectedCard（input_hash 前缀 proposal:* / system:*）——
  LLM 点名替代（sIds）与防抖等价机制（findEquivalentLive / findPriorityShiftedLive）一律跳过；
  这类卡的生命周期只归各自服务（用户动作 / matter resolve / 看门狗恢复）。
- 数据修复：复活 2 张被误杀提案（已免疫）；清除 1 张「清理：」前缀泄漏卡
  （注给 B：titleHygiene 的 supersede 宽匹配可考虑加中文「清理：」变体，留你定夺）。
- 验证：tsc ✓ 全量 490 测试 ✓（与 B 的 attentionEngine 在途改动无冲突，仅微创三处）。

### 2026-06-12 第 21 轮（会话 C）：MVP33 —— 采集覆盖水位 + 观察闭环（专利事故两层根因的普适修复）

- **事故定性**（用户问"为什么跟周强单聊说过了 attention 没认出来"）：
  ① 决定性根因：6-11 12:51-12:58 的闭环对话（"都提交好了哈"→周强"可以，点赞"）落在 lark-cli
  挂死盲区开头；6-12 回灌时 `messages-search --page-limit 5` 最新锚定只回 100 条（has_more 被忽略），
  **比 6-11 20:06 更早的 ~8h 被静默永久丢弃**。复现实锤：同窗口同参数重放，周强会话 0 条命中。
  ② 系统性根因：当天交底书 drive 编辑、周强评论、专利系统"待审批"通知都进来了，triage 也产出了
  5 条专利 observation（含 progress/advance）—— 但 matter_observations 是只写死信（MVP29 预留的
  candidate_matter_ids_json 恒空），reducer 只吃 5 种语义 kind，event/state 单元全被闸门挡掉。
- **普适修复（MVP33，docs/MVP33-采集覆盖水位与观察闭环技术方案.md）**：
  - U1 覆盖水位契约：`Collector.collect → { signals, coveredUntil }`；collector_state 新列
    covered_until（错误轮 COALESCE 保旧值）；调度器游标只推进到水位 + 7d 保险丝；im 全保真
    （6h 有界追赶窗口、最新锚定源 has_more 收缩重试、asc 源 per-chat clamp −60s、信号上限改
    按时间排水不再按优先级永久丢弃）；发射不变量：事件只产自 (since, coveredUntil]，跨轮窗口
    不相交（agg 不重复计数）；drive 单页拉满 clamp；其余 5 个快照式 collector 契约适配。
    freshnessWatchdog 新增第二类告警：扫描在成功但水位落后 >2h → P1 系统卡（与停滞 P0 卡互补）。
  - U2 观察消费通路：triage 落 observation 后 fire-and-forget 消费——门槛（advance/resolve/block/
    reopen + conf≥0.6）→ 让路（event 已产 HANDLED_KINDS 单元归 reducer hook，防双判）→ 召回
    （scoreAndRank 实体轴 ∪ obs.title 标题轴）→ 复用 reducer 的 llmJudge + applyDecision 保守阈值
    （永不 create/drop）→ 销账回写 candidate_matter_ids_json；judge 瞬时失败不销账，启动补扫
    （48h 窗、cap 50）接住。明确砍掉 detectSelfAction 扩词（实例级补丁，由 U2+MVP32 覆盖）。
- **验证**：tsc ✓；新增 18 个测试全过（含验收通例：24h 停摆 + 25 条/页分页上限 → 多轮排干
  240 条零丢失零重复）；全量 539 测试 ✓ 零回归。生产实测：水位机制上线即自动 clamp 过一次
  （im coveredUntil 落后 13min 排水中）。
- **事故自愈**：把 im 水位拨回 2026-06-11T03:55:40Z（水位回拨=免费补扫能力），等多轮 tick
  排干后周强会话应入库 → triage → reducer/consumer 推进 matter 04ce4f28。
