# MVP25 会议智能纪要接入 Context 技术方案

> 修复 MVP11.1（`meetingArtifactCollector`）的失效实现。MVP11.1 的设计与字段全部基于**假想的 lark-cli schema**，与真实返回对不上，导致上线至今 `events` 表 `source='minutes'` **零条**。本方案换发现入口、按真实 schema 重写解析，把"我参与的所有有智能纪要的会议"接入 context。

## 背景

用户诉求：与他人开视频会议后，会议的**智能纪要（总结 / 待办）**应作为 context 的一部分，进入 attention 判断。

对现有 `meetingArtifactCollector.ts`（已授权 `minutes:minutes:readonly` / `minutes:minutes.artifacts:read` / `minutes:minutes.transcript:export`）做了逐字段实测核验，结论如下：

| 失效点 | 现状代码 | 实际 lark-cli 返回 | 实测证据 |
|---|---|---|---|
| **① 发现入口窄** | `minutes +search --participant-ids me`（行90-103） | 只返回"我拥有/被分享"的妙记，不含我作为普通参会人的会 | 近30天 `minutes +search` 只得 **5** 场；`vc +search --participant-ids <我open_id>` 得 **85** 场会议、其中 **61** 场带智能纪要 → 漏 **56** |
| **② 搜索结果字段错** | 读 `data.items[].minute_token / title / owner_id`（行104-113） | 实际是 `data.items[].token` + `display_info`（多行字符串） | `minutes +search` 实测返回 `{token, display_info, meta_data}`，无 `minute_token` 字段 |
| **③ 纪要内容字段错** | 读 `data.items[].ai_notes.{summary, action_items, decisions}`（行62-78）+ `transcript`（行195） | 实际是 `data.notes[].artifacts.{summary.content, todos[].content, chapters[], keywords, transcript_file}` | `vc +notes` 实测：`note.artifacts` keys = `['chapters','keywords','summary','todos','transcript_file']`，**无 `ai_notes`、无 `action_items`、无 `decisions`** |
| **④ 元信息命令不存在** | `minutes minutes get`（行148-156） | `minutes` 子命令仅 `+search/+download/+update/+upload/+speaker-replace`，无 `get` | 该调用必然抛错，`fetchMinuteMeta` 恒返回 null |
| **⑤ owner_is_me 恒 false** | 写死 false + TODO（行284-290） | 已有 `getMyOpenId()`（`util/identity.ts`）可用 | scope / `owner_is_me` 判断恒失效 |
| **⑥ 窗口太短** | `lookbackDays=3`（config 默认） | 会议常在 6+ 天前 | 3 天窗口 `vc +search` 实测 0 场，14 天 1 场，30 天 61 场 |

**核心结论**：

1. MVP11.1 是**未经真实联调的实现**——即使 ①②⑥ 都修好、真搜到了妙记，③ 的字段错也会让 `buildContent` 提取出空。三个 bug 叠加，从任一环节都进不了 context。
2. 正确入口是 **`vc +search`（会议记录）**：以"会议"为中心，列出我参与的每一场，`display_info` 直接标注哪场有「智能纪要」，再以 `vc +notes --meeting-ids` 按真实 `artifacts` schema 取总结/待办。
3. 下游链路（`scheduler` → `events` → `kind='event'` ContextUnit → `recentEvents` → attention prompt）**机制本身正确，collector 改造无需动它**——问题 100% 在发现与解析层。但首次把 N 天历史一次性灌进来时，`recentEvents` 的"按入库时间过滤 + cap 20 + 显示 occurredAt"会产生回填洪峰与时序错位，需配套策略（见 [§recentEvents 时序语义与首次回填](#recentevents-时序语义与首次回填)）。

### 关键实测：完整读取路径（全程验证通过）

> **实现期重大修正**：原计划假设 `vc +notes --meeting-ids` 直接返回 `artifacts`（summary/todos）。实测发现——**我参与的会议里，"智能纪要"绝大多数是一份云文档（`note_doc_token`），不是妙记 AI 产物**。抽样 10 场全部如此（0 场带 artifacts，`vc +recording` 多为 404）。`artifacts` 仅在少数有录制的会出现。因此真实路径需多一步 `docs +fetch` 读智能纪要文档。

```
① getMyOpenId() → ou_0e40039c5069cd982b21440cc0684244        [复用; 注意 openId 在 identities.user.openId]
② vc +search --participant-ids <open_id> --start <iso>
     --page-size 30 (+ page_token 全分页)
   → items[]{ id=meeting_id, display_info, meta_data }        [实测 85 场 / 3 页；display_info 标注"智能纪要"]
③ vc +notes --meeting-ids <meeting_id> --output-dir <相对路径>
   → notes[0]{ create_time, creator_id,
        note_doc_token,      ← 智能纪要（AI 总结）云文档【主路径】
        verbatim_doc_token,  ← 逐字稿云文档（不读取）
        artifacts? }         ← 仅少数有录制的会才有【兜底路径】
④ docs +fetch --doc <note_doc_token> --api-version v2
   → data.document.content (DocxXML)                          [实测成功：含 主题/参会人/总结/待办]
⑤ stripDocxXml + buildContentFromDocText → content
   （<cite user-name> 还原为姓名；去 whiteboard/免责声明/尾部噪声；保留换行）
```

> **另一个实测坑**：现有 `sanitizeExcerpt` 会把换行压成空格并**截断到 120 字**（仅适合短摘要）。直接用它处理智能纪要正文会只剩标题行。本方案改用本地 `redactSensitive`（脱敏但保留换行、不截断），由 `MEETING_TEXT_CAP=2000` 控制长度。

`vc +notes` 用 `--meeting-ids` 可直接拿纪要，**无需**先 `vc +recording` 换 `minute_token`（省一次调用）。

## 目标

1. 采集"我参与的、**有智能纪要**的会议"的 **总结 + 待办**，进入 context（覆盖 5 → 61，近30天）。
2. 对下游**契约零改动**：仍产出 `RawSignal{source:'minutes', kind:'meeting_artifact', skipTriage:true}` → `events` → `insertMinimalEventContextUnit`（`kind='event'`）→ `GlobalContextPacket.recentEvents` → `attentionPrompt`。⚠️ 机制不变不等于"行为零影响"——回填会冲击 `recentEvents` 这一 slice，缓解见专节。
3. 幂等、可重入；重复性日程（如"chatbot 日会"）正确区分；同一会重复采集靠 `UNIQUE(source, source_id, content_hash)` 去重。
4. 独立开关 + 上限，可一键回退、成本可控。

## 非目标

- **逐字稿不进 content，也不进 raw_json**（已与用户确认）。注意真实 `vc +notes` 的逐字稿**不是内联字段**——返回里只有 `artifacts.transcript_file`（文件元信息），正文由 CLI 下载成单独文件。因此 content 只放 AI 总结结果（摘要 + 待办）；`raw_json` 只存 notes 的 JSON（summary/todos/chapters/keywords/transcript_file 元信息，几 KB），不读入逐字稿正文。逐字稿文件下到临时目录后即删（仅为防止 `vc +notes` 默认写入工作目录 `./minutes/`）。
- **不采没有智能纪要的会**（已与用户确认）。`display_info` 不含"智能纪要"的会议直接跳过，省 `vc +notes` 调用，且无内容可进 context。
- 不改 attention / triage prompt（纪要复用现有 `recentEvents` 渲染）。
- 不改 `RawSignal` 类型契约、不改 kind 枚举、不新增表 / 迁移。
- 不补"开了会但飞书未生成纪要"的兜底（无纪要即无 context 内容，符合非目标）。

## 数据流改造概览

```
─── 发现入口（本方案改造点）────────────────────────────────────────
   旧:  minutes +search --participant-ids me        (覆盖窄、字段错)   ✗ 废弃
   新:  getMyOpenId()
          │
          ▼
        vc +search --participant-ids <open_id> --start <iso>          (新增, 全分页)
          │   items[]{ id, display_info, meta_data }
          ▼
        parseMeetingSearchItem(display_info)                          (纯函数, 可单测)
          │   → { meetingId, title, organizer, hasMinutes }
          ▼
        filter(hasMinutes) + 去重 + per-tick cap                      (只留有智能纪要的会)
          │   逐 meetingId（串行，规避限流）
          ▼
        vc +notes --meeting-ids <id> --output-dir <相对路径>
          │   notes[0]{ note_doc_token, verbatim_doc_token, artifacts? }
          ├── 主路径: note_doc_token ──► docs +fetch --doc <token> --api-version v2
          │                              → DocxXML → stripDocxXml → buildContentFromDocText
          └── 兜底: artifacts(录制妙记) ──► buildContent(artifacts)
          ▼
        RawSignal{ source:'minutes', kind:'meeting_artifact', skipTriage } (契约不变)
─── 以下机制不变（但 recentEvents 时序语义见专节）──────────────────────
        scheduler.tick → tryInsertEvent (events, UNIQUE 去重)
          → insertMinimalEventContextUnit (kind='event' ContextUnit, skipTriage)
          → GlobalContextPacket.recentEvents → attentionPrompt → attention_items
                         ▲ 按 updatedAt(入库时间) 过滤 24h + cap 20，显示 occurredAt
```

## 已接受的限制（按"接受 + 注释标注"处理）

1. **`display_info` 字符串解析脆弱**：`vc +search` 不返回结构化 title/organizer，只有多行 `display_info`。title/organizer 用启发式解析（首行 = title，正则抓"组织者："，含"智能纪要"=hasMinutes）；解析失败留空，不阻塞——权威 title/time 以 `vc +notes` 的 `create_time` / `minute_token` 为准。
2. **`hasMinutes` 漏判风险**：若某会有纪要但 `display_info` 未带"智能纪要"字样，会被跳过。实测 61/85 命中稳定；可用 `MEETING_ARTIFACT_ONLY_WITH_MINUTES=false` 关闭该过滤兜底（代价：对无纪要会议多打 `vc +notes`，返回 `note.error` 后跳过）。
3. **分页上限**：`vc +search` 翻页设 `searchMaxPages`（默认 10 页 × 30 = 300 场）硬上限，防极端用户失控。超限以 `log()` 标注被截断的场数，不静默。
4. **API 限流**：高频连调 `vc +notes` 实测偶发限流。notes 调用串行 + `maxPerTick`（默认 50）封顶；失败项 soft-fail 跳过，下 tick 重试。
5. **外部会议**：`[外部]` 会议正常采集（已能读到 artifacts），scope 仍归 `work`。

## 实现步骤

文件：[apps/server/src/collectors/meetingArtifactCollector.ts](../apps/server/src/collectors/meetingArtifactCollector.ts)（重写 discovery + notes 解析 + 文档读取 + content 构建）

> **以最终实现为准**：下面 §1–§7 是原始设计骨架；实测后内容来源以 **note_doc_token → `docs +fetch` 文档**为主路径（见上方"关键实测"），`artifacts` 退为兜底。实际导出的纯函数为：
> `parseMeetingSearchItem`（解析 vc +search）、`stripDocxXml`（DocxXML → 纯文本，cite 还原姓名/去 whiteboard）、`buildContentFromDocText`（主路径，去免责声明/尾部噪声、保留换行、`MEETING_TEXT_CAP=2000`、识别"待办"段）、`buildContent`（artifacts 兜底）。IO 函数：`discoverViaVcSearch` / `fetchVcNotes` / `fetchNoteDocText` / `cleanupTmpDir`。
> 实测一轮（lookback=7）：discovered=22 → emitted=6/6 全部来自文档、6/6 识别待办、平均 content ~1500 字。

### 1. 类型按真实 schema 重写

```ts
// vc +search 返回
type VcSearchResp = {
  ok?: boolean;
  data?: {
    items?: Array<{ id?: string; display_info?: string; meta_data?: { app_link?: string } }>;
    has_more?: boolean;
    page_token?: string;
  };
};

// vc +notes 返回（真实）
type VcNotesResp = {
  ok?: boolean;
  data?: {
    notes?: Array<{
      minute_token?: string;
      meeting_id?: string;
      create_time?: string;       // "2026-06-03 20:22"
      creator_id?: string;        // open_id
      error?: unknown;            // 单条失败时存在
      artifacts?: {
        summary?: { content?: string };
        todos?: Array<{ content?: string }>;
        chapters?: Array<{ title?: string; summary_content?: string; start_ms?: string }>;
        keywords?: string[] | string;
        transcript_file?: unknown;
      };
    }>;
  };
};
```

删除：`MinutesSearchResp` / `MinuteMeta` / `MinuteGetResp` / `VcNotesItem(旧)` / `fetchMinuteMeta` / `discoverViaMinutesSearch`。

### 2. 新增纯 helper `parseMeetingSearchItem()`（可单测）

> **可测性约定**（仿 MVP24）：spawn lark-cli 的函数不单测；把 `display_info` 解析这类纯逻辑抽成**导出纯函数**，由 `mvp25-meeting-artifact.test.ts` 直接测。

```ts
// MVP25: 从 vc +search 的一个 item 解析出会议元信息。
// display_info 形如：
//   "对一下工具问题的视频会议\n云文档：智能纪要：xxx\n今天 20:16 | 组织者：刘昕明 | ID: 162 330 681"
// 纯函数：无 IO，便于单测。
export function parseMeetingSearchItem(item: {
  id?: string;
  display_info?: string;
}): { meetingId: string; title: string; organizer?: string; hasMinutes: boolean } | null {
  if (!item.id) return null;
  const info = item.display_info ?? '';
  const lines = info.split('\n').map((s) => s.trim()).filter(Boolean);
  const title = lines[0] ?? '';
  const organizer = (info.match(/组织者[：:]\s*([^|｜\n]+)/) ?? [])[1]?.trim();
  const hasMinutes = /智能纪要/.test(info);
  return { meetingId: item.id, title, organizer, hasMinutes };
}
```

### 3. 新发现入口 `discoverViaVcSearch()`（IO 包装，薄，不单测）

```ts
// MVP25: minutes +search 只覆盖"我拥有/被分享"的妙记（实测 5/30天）。改用
// vc +search 按参会人枚举我参与的所有会议（实测 85/30天），display_info 标注智能纪要。
async function discoverViaVcSearch(
  myOpenId: string,
  sinceIso: string
): Promise<Array<{ meetingId: string; title: string; organizer?: string }>> {
  const out: ReturnType<typeof parseMeetingSearchItem>[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < config.meetingArtifactSearchMaxPages; page++) {
    const args = [
      'vc', '+search', '--participant-ids', myOpenId,
      '--start', sinceIso, '--page-size', '30', '--format', 'json',
    ];
    if (pageToken) args.push('--page-token', pageToken);
    const resp = await runLarkCliJson<VcSearchResp>(args);
    for (const it of resp?.data?.items ?? []) {
      const parsed = parseMeetingSearchItem(it);
      if (parsed) out.push(parsed);
    }
    if (!resp?.data?.has_more || !resp.data.page_token) break;
    pageToken = resp.data.page_token;
  }
  // 去重 by meetingId + 只留有智能纪要的会
  const seen = new Set<string>();
  const result: Array<{ meetingId: string; title: string; organizer?: string }> = [];
  for (const p of out) {
    if (!p) continue;
    if (config.meetingArtifactOnlyWithMinutes && !p.hasMinutes) continue;
    if (seen.has(p.meetingId)) continue;
    seen.add(p.meetingId);
    result.push({ meetingId: p.meetingId, title: p.title, organizer: p.organizer });
  }
  return result;
}
```

### 4. 重写 `fetchVcNotes(meetingId)` —— 按真实 artifacts schema

```ts
async function fetchVcNotes(meetingId: string): Promise<VcNotesResp['data']['notes'][0] | null> {
  try {
    // 注意：--output-dir 只接受 cwd 内的相对路径（实测拒绝绝对路径/os.tmpdir）。
    // vc +notes 的进度行走 stderr，stdout 是纯 JSON，runLarkCliJson 可直接解析。
    const resp = await runLarkCliJson<VcNotesResp>([
      'vc', '+notes', '--meeting-ids', meetingId,
      '--output-dir', MINUTES_TMP_DIR,        // 相对目录常量，如 './.cache/meeting-minutes'
      '--overwrite', '--format', 'json',
    ]);
    const note = resp?.data?.notes?.[0];
    if (!note || note.error || !note.artifacts) return null;   // 无纪要/失败 → 跳过
    return note;
  } catch (err) {
    console.warn(`[meetingArtifact] vc +notes failed for ${meetingId}:`,
      err instanceof Error ? err.message : String(err));
    return null;
  }
}
```

### 5. 重写 `buildContent(artifacts, fallbackTitle)` —— 只放总结结果，逐字稿不进

```ts
// MVP25: content 只放 AI 总结结果（摘要 + 待办 + 章节脉络）。逐字稿不进 content（已确认）。
function buildContent(
  note: VcNote | null,
  fallbackTitle: string
): { text: string; hasActionItems: boolean } {
  const a = note?.artifacts;
  if (!a) return { text: fallbackTitle, hasActionItems: false };
  const lines: string[] = [];

  const summary = a.summary?.content?.trim();
  if (summary) lines.push(`【会议摘要】\n${sanitizeExcerpt(summary)}`);

  const todos = Array.isArray(a.todos) ? a.todos : [];
  if (todos.length) {
    lines.push('【待办】');
    for (const t of todos.slice(0, 10)) {
      const c = sanitizeExcerpt(t.content ?? '');
      if (c) lines.push(`- ${c}`);
    }
  }

  // 章节脉络替代旧的 decisions（真实 schema 无 decisions 字段）
  const chapters = Array.isArray(a.chapters) ? a.chapters : [];
  if (!summary && chapters.length) {           // 仅在无 summary 时用章节兜底
    lines.push('【章节脉络】');
    for (const c of chapters.slice(0, 8)) {
      const t = sanitizeExcerpt(c.title ?? c.summary_content ?? '');
      if (t) lines.push(`- ${t}`);
    }
  }

  if (lines.length === 0) lines.push(fallbackTitle);   // 逐字稿不再作兜底
  return { text: lines.join('\n'), hasActionItems: todos.length > 0 };
}
```

> **逐字稿处理**：`vc +notes --output-dir <tmp>` 会把逐字稿落成单独文件（不在 JSON 返回里）。本方案**不读取该文件**——既不进 content 也不进 raw_json。仅在 collect 末尾清理临时目录，避免堆积 / 污染工作目录。`raw_json` 由 notes 的 JSON（含 `transcript_file` 元信息，非正文）构成，体积仅几 KB，`truncateRawForCap` 256KB 退化为安全兜底而非逐字稿专用机制。

### 6. `collect()` 主流程

```ts
async collect(): Promise<RawSignal[]> {
  if (!config.meetingArtifactEnabled) return [];
  const t0 = Date.now();
  const myOpenId = await getMyOpenId().catch(() => '');
  if (!myOpenId) {
    console.warn('[meetingArtifact] getMyOpenId failed, skip this tick');
    return [];
  }
  const sinceIso = new Date(Date.now() - config.meetingArtifactLookbackDays * 86400_000).toISOString();
  const discovered = await discoverViaVcSearch(myOpenId, sinceIso);
  const targets = discovered.slice(0, config.meetingArtifactMaxPerTick);

  const signals: RawSignal[] = [];
  for (const d of targets) {                          // 串行，规避限流
    const note = await fetchVcNotes(d.meetingId);
    if (!note) continue;
    const { text, hasActionItems } = buildContent(note, d.title);
    const ownerIsMe = !!note.creator_id && note.creator_id === myOpenId;
    const occurredAt = note.create_time
      ? new Date(note.create_time.replace(' ', 'T') + '+08:00').toISOString()
      : new Date().toISOString();
    const minuteToken = note.minute_token ?? '';
    const contentHash = contentHashFor([d.meetingId, note.create_time, text.length, text.slice(0, 200)]);
    // sourceId 以 meeting 维度（发现入口是会议）
    signals.push({
      source: 'minutes',
      sourceId: `meeting:${d.meetingId}`,
      kind: 'meeting_artifact',
      occurredAt,
      title: d.title || `会议纪要 ${d.meetingId.slice(-6)}`,
      text,
      actor: d.organizer,
      url: minuteToken ? `https://www.feishu.cn/minutes/${minuteToken}` : undefined,
      raw: truncateRawForCap({ note, discovery: d }, config.meetingArtifactRawCapBytes).raw,
      contentHash,
      entities: buildEntities(d, note),            // meeting + organizer person
      contextMergeHint: `meeting_artifact:${d.meetingId}`,
      scope: 'work',
      actionability: 'record',
      semanticTags: {
        signal_kind: 'meeting_artifact',
        meeting_id: d.meetingId,
        minute_token: minuteToken,
        has_action_items: hasActionItems,
        owner_is_me: ownerIsMe,
      },
      skipTriage: true,
    });
  }
  console.log('[mvp25] meetingArtifact stats', JSON.stringify({
    discovered: discovered.length, targeted: targets.length,
    emitted: signals.length, elapsedMs: Date.now() - t0,
  }));
  // collect 末尾：清理 vc +notes 下载的逐字稿临时目录（不入库）
  return signals;
}
```

> **实现注意**：
> - **`buildEntities(d, note)`** 是待新增的小 helper：返回 `[{type:'meeting', name:d.meetingId, role:'about'}]`，并在 `d.organizer` 非空时补 `{type:'person', name:d.organizer, role:'organizer'}`。
> - 逐字稿临时目录用**相对路径**常量 `MINUTES_TMP_DIR`（`vc +notes --output-dir` 实测拒绝绝对路径）；`import fs from 'node:fs'` 在 collect 末尾 `fs.rmSync(MINUTES_TMP_DIR, {recursive:true, force:true})` 清理。
> - **`getMyOpenId()` 已实测可用**但有坑：`lark-cli auth status` 返回的 `userOpenId` 字段为 `undefined`，真实值在 `identities.user.openId`；`util/identity.ts:parseMyIdentity` 已用 `userOpenId ?? identities.user.openId` 兜底，故能正确拿到 `ou_...`。直接复用、勿自行只读 `userOpenId`。

### 7. 配置 / 开关

文件：[apps/server/src/config.ts](../apps/server/src/config.ts)

```diff
- meetingArtifactLookbackDays: envInt('MEETING_ARTIFACT_LOOKBACK_DAYS', 3),
+ // MVP25: 稳态用 7 天——既能补上"距上次成功采集之间开过的会"，又把回填洪峰
+ //   控制在小范围（见 §recentEvents 时序语义与首次回填）。一次性回填历史可临时调大。
+ meetingArtifactLookbackDays: envInt('MEETING_ARTIFACT_LOOKBACK_DAYS', 7),
+ // MVP25: vc +search 分页上限（30/页），防极端用户失控
+ meetingArtifactSearchMaxPages: envInt('MEETING_ARTIFACT_SEARCH_MAX_PAGES', 10),
+ // MVP25: 仅采 display_info 标注"智能纪要"的会议（已确认）
+ meetingArtifactOnlyWithMinutes: envBool('MEETING_ARTIFACT_ONLY_WITH_MINUTES', true),
```

文件：[apps/server/.env.example](../apps/server/.env.example) 同步追加：

```bash
# MVP25 会议智能纪要：vc +search 按参会人枚举 + vc +notes 取 artifacts
# 稳态 7 天；一次性回填历史可临时调大（如 30），回填后改回 7
MEETING_ARTIFACT_LOOKBACK_DAYS=7
MEETING_ARTIFACT_SEARCH_MAX_PAGES=10
MEETING_ARTIFACT_ONLY_WITH_MINUTES=true
```

## recentEvents 时序语义与首次回填

> 这是本方案唯一会"波及下游"的点。collector 不改 `recentEvents` 的代码，但灌入数据的时间分布会触发它的既有行为，需正视。

**实测的下游事实**（`agentContextAssembler.ts:909-916` + `attentionPrompt.ts:452`）：

```ts
const recentEvents = allActive
  .filter(u => u.kind === 'event')
  .filter(u => now - new Date(u.updatedAt).getTime() <= 24h)   // ← 按 updatedAt(入库时间) 过滤
  .slice(0, 20);                                               // ← cap 20
// 渲染时：parts.push(`@${formatTime(u.time.occurredAt)}`)      // ← 显示 occurredAt(会议真实时间)
// block 标题：「近 24h 的事件（按时间倒序）」
```

三者叠加产生两个问题：

1. **首次回填洪峰**：首次启用时一次性把 lookback 窗口内（如 30 天）的会议全部入库，全部 `updatedAt≈now` → 全部通过 24h 过滤 → 最多 `maxPerTick`(50) 条挤进 cap=20 的 `recentEvents`，把真正近期的 IM / 文档事件挤出去。
2. **时序错位**：一个 30 天前开的会，因 `updatedAt` 是今天而通过"近 24h"过滤，却以 `occurredAt`（30 天前）渲染——LLM 在"近 24h 事件"标题下看到 30 天前的时间戳，时效判断（P1=今天的会议）被干扰。

**为什么会自愈**：稳态下每 tick 重新 `vc +search` 命中的同一批会议，因 `sourceId+contentHash` 不变被 `UNIQUE` 拦截、**不再 insert，`updatedAt` 冻结在首次入库时刻**。所以洪峰是**一次性**的：~24h 后这批回填单元因 `updatedAt` 老化自然退出 `recentEvents`，只剩此后新开的会。

**缓解策略（本方案采用）**：

- **稳态 `lookbackDays=7`**（非 30）：稳态每 tick 只搜近 7 天，绝大多数已入库去重，仅新开的会产生 fresh insert，洪峰可忽略。7 天足以覆盖"距上次成功采集间开过的会"。
- **一次性回填**：需要补历史时，临时设 `LOOKBACK_DAYS=30` 跑 1–2 轮（注意 `maxPerTick=50 < 61`，要 2 轮才取全），回填后改回 7。明确接受这一次性 24h 洪峰。
- **时序错位**接受为已知限制：`occurredAt` 显示是**真实的**，LLM 能从时间戳看出会议非当日；"近 24h"标题为近似标签。若后续要彻底消除，需让会议纪要 unit 的 `updatedAt` 取 `occurredAt`（属下游小改动，超出本方案范围，单列后续项）。

## 兼容性 / 回滚

- **数据库 schema 不变**：复用 `events` / `context_units`。`sourceId` 从 `minute:<token>` 改为 `meeting:<meetingId>` —— 因旧实现从未写入任何行（实测 `events` 表 `source='minutes'` 为 0），无历史数据冲突。
- **重复性日程**：每场是不同 `meetingId` → 各自一条 ContextUnit（每天会内容不同，符合预期）。
- **同一会重复采集**：`sourceId + contentHash` 不变 → `UNIQUE(source, source_id, content_hash)` 拦截，幂等。
- **回滚**：`MEETING_ARTIFACT_COLLECTOR_ENABLED=false` + restart，立即停止。或 `git revert` collector 文件即恢复（下游无改动）。

## 下游消费者盘点

- 产出 kind 仍是 `meeting_artifact`、`skipTriage:true`，与 MVP11.1 契约一致；无新增 kind、无 dispatch 改动。
- `entities`：会议 → `type:'meeting'`；organizer → `type:'person'`（进 Work-Map，与其它 collector 同人逻辑一致）。
- attention：纪要进 `recentEvents`，`attentionPrompt` 已支持渲染并要求 `[S#]` 引用 —— 待办带 DDL ≤24h 可升 P0/P1，决定关联现有 commitment 可升优先级（MVP11.1 设计意图，本方案首次真正喂入数据）。

## 验证

### 单元测试

新建 `apps/server/test/mvp25-meeting-artifact.test.ts`（`node:test` + `.test.ts`，**不 mock lark-cli spawn**，只测导出纯函数）。运行：`npx tsx --test apps/server/test/mvp25-meeting-artifact.test.ts`。

- `parseMeetingSearchItem`：
  - 标准多行 `display_info` → 正确解析 title / organizer / `hasMinutes=true`。
  - 无"智能纪要"字样 → `hasMinutes=false`。
  - 缺 `id` → 返回 null。
  - 组织者用全角"："与半角":"两种分隔。
- `stripDocxXml`（主路径解析）：
  - `<cite user-name="X">` → 姓名；`<whiteboard>` 去除；`<li>` → `- `；块级标签 → 换行；无残留 `<tag>`。
- `buildContentFromDocText`（主路径）：
  - 保留换行、`content.length > 120`（验证未被 sanitizeExcerpt 的 120 截断）；含【总结】【待办】文本。
  - 去除 AI 免责声明 / "会议最佳表现成员" / "相关链接" 尾部噪声。
  - 长数字脱敏；空文本 → `fallbackTitle`。
- `buildContent`（artifacts 兜底）：
  - 有 `summary.content` + `todos` → 含【会议摘要】【待办】，`hasActionItems=true`。
  - 仅 `chapters`（无 summary）→ 走【章节脉络】兜底。
  - 全空 / null → 返回 `fallbackTitle`，且**不含逐字稿**。

实测：`tests 12 / pass 12`。

### 端到端回放

1. **一次性回填验证**：临时设 `MEETING_ARTIFACT_LOOKBACK_DAYS=30`，重启 server。
2. `POST /api/collectors/run-once {name:'meeting_artifact'}`。
3. 断言：
   - 首轮 `SELECT COUNT(*) FROM events WHERE source='minutes'` ≤ `maxPerTick`(50)；因近30天有纪要会议 ~61 > 50，**需第 2 轮 run-once 才补到 ~61**（验证 cap 行为）。
   - 抽一条 ContextUnit：`content` 含【会议摘要】【待办】，**不含逐字稿全文**；`raw_json` 不含逐字稿正文（只有 `transcript_file` 元信息）。
   - 临时目录无残留逐字稿文件（collect 末尾已清理）。
   - 触发一次 attention tick → `recentEvents` 含会议纪要 → 出现引用该会 `[S#]` 的 `attention_items`。
4. **幂等**：连跑两次 `run-once`（同一 lookback），第二次 `newEvents=0`，已存单元 `updatedAt` 不变（验证洪峰一次性）。
5. **稳态验证**：改回 `LOOKBACK_DAYS=7` 重启；确认每 tick 仅新开的会产生 `newEvents`，`recentEvents` 不再被历史会议刷屏。

### 观测指标（上线后 7 天）

- 每 tick：`vc +search` 翻页数（≤ `searchMaxPages`）+ 命中有纪要会议数（≤ `maxPerTick`）的 `vc +notes` 调用。
- 会议纪要 signal 进入 `recentEvents` 的占比、被 attention 引用率。
- collector tick 平均耗时（新增 per-meeting `vc +notes`，串行 + cap 约束）。

## 已知风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| 会议量大 → `vc +notes` 调用暴涨 | tick 变慢 / Lark 配额 | `maxPerTick=50` 上限 + `searchMaxPages` 翻页上限 + 串行调用 |
| `display_info` 格式变更 | title/organizer/hasMinutes 解析失效 | 纯函数防御解析、解析失败留空不阻塞；`onlyWithMinutes=false` 可绕过 hasMinutes 依赖 |
| `vc +notes` 限流 | 部分会议本轮缺失 | soft-fail 跳过 + 下 tick 重试；幂等保证不丢 |
| `hasMinutes` 漏判 | 个别有纪要会被跳过 | 实测命中稳定；可关 `onlyWithMinutes` 兜底 |
| raw_json 体积 | events 表变大 | 逐字稿正文不入库（仅 transcript_file 元信息）；`truncateRawForCap` 256KB 兜底；临时逐字稿文件用完即删 |
| 首次回填洪峰冲击 recentEvents | 老会冒充近期、挤占 cap 20（详见专节） | 稳态 lookback 收窄至 7 天；首次大窗口回填视为一次性、24h 内自愈 |
| 隐私边界（外部会议纪要进 LLM） | 外部会议内容进 context | 用户主动诉求；`MEETING_ARTIFACT_COLLECTOR_ENABLED` 可一键关闭 |

## 工作量估计

| 任务 | 估计 |
|------|------|
| 类型重写 + `parseMeetingSearchItem` + `discoverViaVcSearch` | 0.25 day |
| `fetchVcNotes` + `buildContent` 重写 + `collect` 主流程 | 0.25 day |
| config / .env.example | 0.1 day |
| 单元测试 + 端到端回放 | 0.4 day |
| **合计** | **~1 day** |
