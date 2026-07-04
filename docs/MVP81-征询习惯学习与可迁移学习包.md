# MVP81：征询习惯学习（记录 → 会用）+ 可迁移学习包

## 目标定调（2026-07-04 /goal，本 MVP 的两条主线）

1. 「知道我需要做什么……**也明确知道什么时候需要我确认，不需要我确认的时候可以持续自主推进**」——把"何时该问/何时直接办"从写死的规则变成**从用户真实选择里长出来的机制**。
2. 「让 AI 能够有自主的学习能力，不只是局限于我的任务和我的工作方式，**能够复用泛化到其他用户其他人的业务场景**」——学习的载体要做成可携带、去个人化的形态。

衔接 MVP79 留下的明确下一步：「习惯学习 v1 只记录不排序；攒够 consult_choice 后按（请求人/事项类型→历史选择）排序或预选」。本 MVP 直接做到"预选之上"：惯例成立就不再问。

## 一、习惯引擎（habit/consultHabitEngine.ts）——纯函数，泛化的载体

**零项目依赖**（不 import db/config/lark/matter），输入 = 历史选择事件（`{key, subjectId, choice, at}`）+ 参数，输出 = `auto`（照惯例直接办）或 `ask`（问，可带「猜你会选」提示）。换用户/换业务（邮件、工单、CRM），只要把事件映射成同形状，引擎原样可用。

- **两层作用域**：具体对象层（同请求人同类事）优先、通用类型层（同类事跨请求人）兜底——与 playbook 中粒度 taskTypeKey 同一泛化哲学（MVP37：样本要跨人/跨项目才凑得齐）。具体层**有任何历史就定调**：对张三总是"先查"，不因对别人总选"起草"就对张三自动起草。
- **保守判据**：最近**连续一致** ≥ N 次（默认 3，`CONSULT_HABIT_AUTO_MIN`）才算惯例，中间出现任何别的选择就断掉重数——比多数票保守，宁可多问一次。
- **安全白名单铁律**：只有 `draft`（只给草稿绝不代发）和 `investigate`（只读排查）可自动；`ignore` 会归档事项、`instruct` 无法复现原话，**永远要问**。
- **暂停闸**：用户说过「先问我」的键永不自动（只提示）。过期（>90 天）事件不作数。

## 二、绑定进征询闭环（consultService）

- **惯例成立 → 不再问**：`maybeConsultOnMatterCreated` 在终身一次幂等闸后先算决策；auto 且开关开、自动日配额（`CONSULT_AUTO_DAILY_MAX`，独立于征询配额）未用尽 → 直接执行（investigate 走 KEYSTONE 回填+kick；draft 走 aiisn-push 沙箱起草）+ ⚡DM 通告「照你的惯例，这次没再问你……回『先问我』」+ `consult_auto_handled` 审计（payload 带 `followedYourHabit:1`、habitKey、evidenceCount）。
- **auto 被拦不浪费证据**：配额用尽/开关关/暂停闸命中 → 降级为**带提示的征询**（实测抓出的 bug：最初 hint 只在 ask 模式生成，auto 降级时提示丢失——测试先红后绿修正）。
- **「猜你会选 N」提示**：历史不够自动时，征询末尾加「按你过去 N 次同类事的选择，我猜你会选 N——回『好』我就照这个办」；hintedChoice 落 `consult_asked` payload；用户回「好/嗯/ok」→ `handleConsultChoice` 回查提示兑现（无提示时「好」仍按自由指示走，不瞎猜）。
- **刹车**：任何征询/通告回「先问我」→ `pauseConsultHabit`（settings `consult:habitPausedKeys`，宽刹车暂停整个任务类型层）+ `consult_habit_paused` 审计 + ack「这类事以后我都先问你再动」。
- **不自我强化**：自动执行不写 `consult_choice`（只有人的选择才是证据），惯例不会靠自动执行自己养肥自己。

## 三、面板四类结果观（MVP80 铁律的延伸）

`consult_auto_handled` 进「助理工作日志」结果行（结果观④「AI 照你的做法办成」）：⚡「照你的惯例，没再问直接办了」+ 紫色徽标「⚡ 按你的惯例」（title 注明飞书回「先问我」可关）。tally 新增「⚡ 照惯例 N」（近 7 天 distinct matter）。

## 四、可迁移学习包（routes/learning.ts）——目标 2 的载体

- **导出** `GET /api/learning/export`，去个人化纪律：
  - playbooks：中粒度 key + 蒸馏时已「去具体化」的步骤（方法可携带）；
  - habits：**只导出通用类型层**统计（key→选择计数），绝不带请求人实体 id——"你和张三之间"的习惯不出这台机器（测试断言导出 JSON 不含实体 id）；
  - problemClasses：label+根因+系统性解法（业务知识，转移正是目的）。
- **导入** `POST /api/learning/import`，人主导纪律（与 MVP37/51 同一联动规则）：playbook 一律进 **distilled 草稿（approved=0）**，接收方批准后才权威；接收方已有权威版的 key **跳过不覆盖**；坏条目计数返回不静默吞；`learning_pack_imported` 审计。
- **诚实边界**：habits/problemClasses v1 只导出不导入——习惯必须由本地真实选择长出来，问题类依赖本地 matter 关联。

## 验证

- 新增 7 测试（mvp81-consult-habit.test.ts）：引擎判据（连续一致/白名单/暂停/具体层覆盖/过期）、自动执行+配额降级、提示兑现、「先问我」刹车、面板行+徽标+tally、学习包导出去个人化+导入避让权威。
- 全量 871 测试：868 过；3 个失败在 mvp49-run-command，**干净 HEAD 同样失败**（容器目录布局 /home/user vs 测试假设的 /root/MyProject，环境性、与本次无关）。两端 tsc 干净。

## 已知边界 / 下一步

- 惯例证据目前只来自征询选择（consult_choice）；卡片流上的同类互动（attention 反馈、proposal 应答）尚未并入证据池。
- 「先问我」是永久刹车，恢复需清 settings `consult:habitPausedKeys`（尚无「恢复自动」口令）——宁可保守。
- draft 惯例自动路径复用 draftReplyForMatter 默认 oneShot（真实 LLM），失败有既有的降级 DM 兜底；观察真实命中率后再考虑放宽 evidenceCount 展示到面板。
- 学习包尚无前端入口（API 已可用 curl 驱动）；导入 habits 需要"证据种子"语义设计，刻意不做。
