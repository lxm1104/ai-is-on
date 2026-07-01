# MVP76 — 把 AI 的追查链路做深做全（像侦探穷尽线索）

> 用户目标：AI 帮我追查时，尽可能准确地找齐所有用于追查的信息，像侦探一样不放过系统能拿到的任何线索。① 很多结果落在**代码提交**里，要纳入追查；② 追查顺序：**先去问题最初出现的地方看进展**，再搜相关关键词；③ 持续迭代直到穷尽所有信息源。

## 1. 基线与三根断点（真库证据）
- 投查近14天工具分布：search_im_messages **790**（主力）/ run_command 237 / list_my_tasks 123 / read_chat_messages 61 / read_doc 17。run_command 里 git 仅 38 次、且几乎全是代码 badcase 的 `git log`；bytedcli/fornax 各 3-4 次。
- **断点① 不从源头查**：dispatcher 传给排查器的上下文只有 title/summary/nextAction/entities，**没有"这件事最初出现在哪"（源头对话/文档）**。AI 只能凭摘要瞎搜关键词，不会"先回原群/原文档看进展"。而 matter→created_from_context_unit_id→event 里**其实有 chatId（im）/ note_doc_token（minutes）/ url**，够得到源头。
- **断点② 代码提交没系统查**：git log 只在有 traceID 的代码 badcase 用。大量 open matter 是**飞书任务源的项目/代码事项**（"多维表格附件返回值优化""日程工具返回值冗长""继续切 CLI"）——这些"做没做/修没修"的答案很多就在 commit 里，但 AI 没被引导去 `git log --grep`。
- **断点③ 没有穷尽纪律**：prompt 有零散引导（"别只搜 IM 就收工"），但**没有"把每个源都查一遍 + conclude 前自审还有哪个源没查"的系统清单**。

## 2. 方案（P0，纯 prompt+上下文，不新增工具）
### P0-1 源头先行——把源头喂进上下文
- `db.ts` 新增 `getMatterOriginHint(matterId)`：matter→created_from_context_unit_id→context_unit→源头 event，解出**原对话 chatId（用 read_chat_messages 读）/ 原文档 token（read_doc）/ url + 最初内容**，渲染成一句话。
- dispatcher + debug/investigation/run 传 `originHint`；`buildInvestigateUserMessage` 在**第 1 轮**注入 `<源头（第一步先回这里查）>` 段。

### P0-2 追查纪律——侦探式穷尽清单（investigationPrompt）
在判定纪律前新增「追查纪律」：
- 🔍 **第一步永远先回源头**看有没有新进展/回复/结论，别一上来瞎搜关键词。
- 系统性**把每个源都查一遍**：① IM（每个人名+术语+别名多组搜 + 相关群读原文）② 待办 ③ 文档 ④ **代码提交**（`git -C <repo> log --all --oneline --grep 关键词` / `git log -S 关键标识` / `git show <commit>`——很多"做没做/修没修/落地没"就在 commit 里）⑤ badcase：日志ID→traceID→trace→file:line/引入commit。
- ✅ **穷尽了才结论**：conclude 前自问"还有哪个够得到的源没查？源头看了吗？相关代码提交查了吗？人名都搜了吗？"，还有没查的就继续 investigate，别提前 unknown。

### P0-3 给足轮数
`investigationMaxRounds` 3→**5**（穷尽要轮数；简单事项会提前 conclude、不额外花）。

## 3. 硬约束
投查仍**硬只读**（run_command git 只读子命令白名单 + 路径根限；不新增任何写动作）；单并发 gate（熔断已缓解，5 轮可接受，简单事项早结）；不代发、不改状态。

## 4. 验收
- AI 排查代码类事项时真的会 `git log --grep` 查提交（toolLog 实测）。
- 有源头 chatId/doc 的事项，第一步先 read_chat_messages/read_doc 回源头。
- 找到的进展/证据更全（不再只搜 IM 就收工）。

## 5. 落点
db.ts(getMatterOriginHint) / investigationLoop.ts(originHint 透传) / investigationPrompt.ts(源头段渲染 + 追查纪律) / investigationDispatcher.ts + routes/debug.ts(传 originHint) / config.ts(maxRounds 5)。
