# MVP PRD：AI is ON — 持续运行的 AI 伙伴系统

> 版本：v0.1 MVP
> 日期：2026-05-17
> 作者：昕明儿 + Cola

---

## 1. 产品定义

### 1.1 背景与问题

当前 AI 产品的范式是"AI is OFF"——用户不说话，AI 就不存在。每次交互是独立的快照，上下文不累积，关系不生长。

**核心矛盾：** 用户的时间和注意力是稀缺资源，但现有 AI 工具要求用户主动发起、主动查找、主动判断。AI 帮你做事，但不帮你省心。

### 1.2 产品愿景

**"AI is ON"** — AI 是一种持续存在的状态，不是一个被调用的工具。

```
用户感受到的不是"我在用 AI"，而是"AI 一直在"。
事情总是准备好了，问题总是提前解决了，你的时间总是被保护着。
```

### 1.3 MVP 目标

验证一个核心假设：

> **Context 自动流动 + Agent 自动处理 + 只推重要的 → 用户觉得"省心"而非"被打扰"。**

MVP 不是一个完整产品。MVP 是一条完整的链路：数据流入 → 自动处理 → 推卡片 → 用户决策。

### 1.4 目标用户

MVP 阶段只有一个用户：**昕明儿自己**。

- AI 产品从业者，每天使用 AI 约 12 小时
- 使用飞书作为日常工作平台（日历、文档、消息、任务）
- 偏好并发异步工作流，不打断进行中的任务
- 对系统内部运作有强烈好奇心，需要拆开看机制

### 1.5 MVP 范围

**做：**
- 一个持续运行的 Context 采集 + Agent 处理系统
- 接入飞书日历作为第一个数据源
- 一个极简前端（对话框 + 卡片流）
- 一套 Intent 记录机制
- 一个类 Caring 的后台分析机制

**不做：**
- 多用户支持
- 企业权限/Boundary 系统
- 多数据源同时接入（MVP 只接日历）
- 移动端 App
- 自定义 Agent 编排

### 1.6 成功标准

| 指标 | 目标 | 说明 |
|------|------|------|
| 链路跑通 | 100% | 日历变更 → Agent 处理 → 推卡片 → 用户看到 |
| 推送准确率 | >70% | 推给用户的卡片中，用户觉得有用的占比 |
| 打扰率 | <20% | 用户觉得"不该推"的卡片占比 |
| 响应延迟 | <30s | 从日历变更到卡片推送到用户的时间 |

---

## 2. 系统架构

### 2.1 架构总览

```
┌─────────────────────────────────────────────────────────┐
│                    用户触达层                             │
│  ┌─────────────┐  ┌─────────────┐                      │
│  │  对话框     │  │  卡片流     │                      │
│  │  (用户输入) │  │  (系统推送) │                      │
│  └──────┬──────┘  └──────▲──────┘                      │
│         │                │                               │
└─────────┼────────────────┼───────────────────────────────┘
          │                │
┌─────────┼────────────────┼───────────────────────────────┐
│  处理层 │                │                               │
│         ▼                │                               │
│  ┌──────────────────────────────────────────────┐       │
│  │              Agent Runtime                    │       │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐   │       │
│  │  │ Ctx      │  │ Intent   │  │ Caring   │   │       │
│  │  │ Processor│  │ Recorder │  │ Analyzer │   │       │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘   │       │
│  │       └──────────────┼──────────────┘         │       │
│  │                      ▼                        │       │
│  │              ┌──────────────┐                 │       │
│  │              │ Decision     │                 │       │
│  │              │ Engine       │                 │       │
│  │              └──────┬───────┘                 │       │
│  └─────────────────────┼─────────────────────────┘       │
│                        │                                 │
└────────────────────────┼─────────────────────────────────┘
                         │
┌────────────────────────┼─────────────────────────────────┐
│  底层                  ▼                                 │
│  ┌──────────────────────────────────────────────┐       │
│  │              Context Store                    │       │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐   │       │
│  │  │ Profile  │  │ Intent   │  │ Event    │   │       │
│  │  │ (记忆)   │  │ (意图)   │  │ Log      │   │       │
│  │  └──────────┘  └──────────┘  └──────────┘   │       │
│  └──────────────────────────────────────────────┘       │
│                                                          │
│  ┌──────────────────────────────────────────────┐       │
│  │              Data Sources (飞书)              │       │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐   │       │
│  │  │ Calendar │  │ Docs     │  │ Messages │   │       │
│  │  │ (MVP)    │  │ (Phase2) │  │ (Phase2) │   │       │
│  │  └──────────┘  └──────────┘  └──────────┘   │       │
│  └──────────────────────────────────────────────┘       │
│                                                          │
│  ┌──────────────────────────────────────────────┐       │
│  │         Claude Code Runtime (基座)            │       │
│  │  Agent Loop / 子 Agent / 工具系统 / MCP       │       │
│  └──────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────┘
```

### 2.2 核心数据流

#### 流 1：Context 自动流入（用户不参与）

```
飞书日历事件变更
  → 事件监听器捕获（webhook / 轮询）
  → 标准化为 Context Event
  → 写入 Event Log
  → 触发 Context Processor（Agent）
  → Agent 判断：重要 / 不重要
    ├── 重要 → 生成卡片 → 推送给用户
    └── 不重要 → 存入记忆，不打扰
```

#### 流 2：用户主动交互

```
用户看到卡片 → 回复"准备一下"
  → Intent Recorder 记录意图
  → Agent 执行深入任务（准备会议材料等）
  → 结果推卡片给用户
```

#### 流 3：Caring 后台分析

```
每隔一段时间 / 每次对话结束后
  → Caring Analyzer 读取最近的 Context + Intent + 对话
  → 分析用户状态
  → 决定：写便签 / 设闹钟 / 什么都不做
  → 便签注入下次交互的上下文
```

#### 流 4：Intent 沉淀

```
用户每次交互（回复卡片 / 主动对话 / 选择）
  → Intent Recorder 提取意图
  → 分类：即时 / 短期 / 长期 / 习惯
  → 写入 Intent Store
  → 下次 Agent 处理时读取，作为决策依据
```

### 2.3 技术栈

| 层级 | 技术选型 | 理由 |
|------|---------|------|
| **Agent 基座** | Claude Code 源码改造 | 成熟的 Agent Loop + 子 Agent + 工具系统 |
| **数据源** | lark-cli（飞书 Open API） | 已配置好，覆盖日历/文档/消息/任务/邮件 |
| **Context Store** | SQLite（MVP） | 单用户场景，轻量够用，后续可迁移 PostgreSQL |
| **向量检索** | Qdrant（本地部署） | 记忆语义检索，本地部署，数据不外流 |
| **LLM** | Claude API（先跑通） → 后续换 DeepSeek/Qwen | MVP 先用最强模型验证效果，再考虑成本优化 |
| **前端** | Electron + React（类 Cola） | 对话框 + 卡片流，桌面端，通知能力 |
| **事件监听** | 飞书 Webhook / 定时轮询 | MVP 先用轮询（每 5 分钟），Phase2 换 webhook |

### 2.4 部署架构

```
本地开发环境（MVP）：
├── Claude Code Runtime（本地进程）
├── lark-cli（本地 CLI，调飞书 API）
├── SQLite（本地文件，~/.ai-on/data/context.db）
├── Qdrant（Docker 容器，本地运行）
├── Electron 前端（本地桌面应用）
└── Claude API（云端，推理用）

后续生产环境：
├── Claude Code Runtime（云端服务器）
├── lark-cli（云端，多用户 token 管理）
├── PostgreSQL + Qdrant（云端）
├── Web 前端（浏览器访问）
└── LLM API（云端）
```

---

## 3. 核心模块详细设计

### 3.1 Context Engine（上下文引擎）

**职责：** 采集、标准化、存储所有用户相关的数据流。

#### 3.1.1 Context Event 格式

```json
{
  "id": "evt_20260517_001",
  "source": "feishu_calendar",
  "type": "event_updated",
  "timestamp": "2026-05-17T10:30:00+08:00",
  "payload": {
    "event_id": "cal_evt_xxx",
    "title": "产品评审会",
    "start_time": "2026-05-17T14:00:00+08:00",
    "end_time": "2026-05-17T15:00:00+08:00",
    "attendees": ["张三", "李四"],
    "location": "3楼会议室A",
    "change_type": "time_changed",
    "previous_value": "2026-05-17T15:00:00+08:00"
  },
  "metadata": {
    "raw_response": { ... },
    "lark_cli_command": "lark calendar get --event-id cal_evt_xxx"
  }
}
```

#### 3.1.2 数据源接入（飞书日历）

```
采集方式（MVP 用轮询，Phase2 用 webhook）：

轮询模式：
  ├── 每 5 分钟执行一次
  ├── lark calendar +agenda --from now --to +2h
  ├── 对比上次轮询结果，diff 出变更
  ├── 每个变更生成一个 Context Event
  └── 写入 Event Log

变更类型：
  ├── event_created   → 新日程
  ├── event_updated   → 日程修改（时间/地点/参会人）
  ├── event_cancelled → 日程取消
  └── event_reminder  → 即将开始的提醒
```

#### 3.1.3 Context Store 数据模型

```sql
-- 事件日志（原始 context 流）
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,       -- feishu_calendar / feishu_doc / ...
  type TEXT NOT NULL,         -- event_created / event_updated / ...
  timestamp DATETIME NOT NULL,
  payload JSON NOT NULL,
  processed BOOLEAN DEFAULT FALSE,
  importance TEXT,             -- high / medium / low / ignore
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 用户记忆
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,          -- profile / preference / context
  content TEXT NOT NULL,
  source_event_id TEXT,        -- 来源于哪个事件
  confidence TEXT,             -- stated / inferred
  valid_from DATETIME,
  valid_until DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 用户意图
CREATE TABLE intents (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,      -- immediate / short_term / long_term / habit
  description TEXT NOT NULL,
  trigger_event_id TEXT,       -- 触发来源
  status TEXT DEFAULT 'active', -- active / fulfilled / expired
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 便签（caring notes）
CREATE TABLE caring_notes (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,       -- 给 Agent 的提示
  trigger TEXT,                -- 触发原因
  active BOOLEAN DEFAULT TRUE,
  expires_at DATETIME,         -- 过期时间（可选）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 3.2 Context Processor（上下文处理器）

**职责：** 对流入的 Context Event 进行自动处理，判断重要性，决定行动。

#### 3.2.1 处理流程

```
Context Event 进入
    ↓
Step 1: 重要性判断（规则 + LLM）
    ↓
Step 2: 关联记忆检索（向量检索相关记忆）
    ↓
Step 3: 意图关联（是否有相关 intent？）
    ↓
Step 4: 行动决策
    ├── ignore   → 不做任何事
    ├── record   → 只记录到记忆，不推卡片
    ├── notify   → 推卡片通知用户
    └── act      → 自动执行 + 推结果卡片
```

#### 3.2.2 重要性判断规则

```yaml
importance_rules:
  # 高重要性：直接推卡片
  high:
    - 日程在 1 小时内开始
    - 日程被取消且用户是组织者
    - 日程时间被改且用户是参会人
    - 日程标题包含关键词（评审、面试、汇报、客户）

  # 中重要性：记录 + 可能推卡片
  medium:
    - 明天的日程（早上推一次）
    - 新创建的日程（用户是参会人）
    - 日程地点变更

  # 低重要性：只记录
  low:
    - 日程描述更新
    - 参会人列表变更（非核心人员）
    - 用户自己创建的日程

  # 忽略
  ignore:
    - 系统自动生成的日程
    - 已结束的日程变更
```

#### 3.2.3 Agent 处理 Prompt

```yaml
context_processor_prompt: |
  你是一个持续运行的 AI 伙伴。你的职责是帮用户管理日程。
  
  ## 当前事件
  {event_json}
  
  ## 用户相关记忆
  {relevant_memories}
  
  ## 用户活跃意图
  {active_intents}
  
  ## 任务
  1. 判断这个事件对用户的重要程度（high/medium/low/ignore）
  2. 如果重要，生成一张卡片推送给用户
  3. 提取任何值得记住的信息，更新记忆
  4. 如果事件关联到用户的某个意图，执行该意图
  
  ## 卡片格式
  如果需要推卡片，输出 JSON：
  {
    "importance": "high",
    "card": {
      "title": "日程变更提醒",
      "summary": "产品评审会时间从15:00改到14:00，提前了1小时",
      "detail": "时间：14:00-15:00\n地点：3楼会议室A\n参会人：张三、李四",
      "actions": [
        {"label": "知道了", "type": "acknowledge"},
        {"label": "帮我准备材料", "type": "deep_dive"},
        {"label": "以后日程变更不用提醒我", "type": "rule_learn"}
      ]
    },
    "memory_updates": [
      {
        "type": "context",
        "content": "产品评审会通常在3楼会议室A举行",
        "confidence": "inferred"
      }
    ]
  }
  
  ## 规则
  - 推卡片的唯一标准：用户看到这张卡片时会觉得有用
  - 宁可漏推，不要错推。打扰比遗漏更糟糕
  - 卡片标题不超过 15 字，摘要不超过 50 字
  - 每张卡片至少有一个"不做任何事"的选项
```

### 3.3 Intent System（意图系统）

**职责：** 记录、分类、管理用户的各种意图，供 Agent 决策时参考。

#### 3.3.1 意图分类

```yaml
intent_categories:
  immediate:
    description: "用户刚刚说的、现在就要做的事"
    example: "帮我准备下午评审会的材料"
    lifecycle: 执行完即归档
    
  short_term:
    description: "用户近期要完成的事（几小时到几天）"
    example: "这周要完成 PRD"
    lifecycle: 完成或过期后归档
    
  long_term:
    description: "用户持续关注的方向"
    example: "正在设计 AI is ON 产品"
    lifecycle: 持续存在，定期更新
    
  habit:
    description: "用户的行为模式和偏好"
    example: "不喜欢早上被打扰"
    lifecycle: 持续存在，通过观察更新
```

#### 3.3.2 意图提取 Prompt

```yaml
intent_extraction_prompt: |
  从以下用户交互中提取意图。
  
  ## 用户交互
  {interaction_text}
  
  ## 已有意图
  {existing_intents}
  
  ## 任务
  1. 判断是否有新的意图
  2. 判断已有意图是否有更新（完成/变更/过期）
  3. 为每个意图分配类别（immediate/short_term/long_term/habit）
  
  ## 输出格式
  {
    "new_intents": [
      {
        "category": "short_term",
        "description": "这周完成 MVP PRD",
        "deadline": "2026-05-23"
      }
    ],
    "intent_updates": [
      {
        "intent_id": "intent_xxx",
        "status": "fulfilled",
        "reason": "用户确认 PRD 已完成"
      }
    ]
  }
```

#### 3.3.3 意图如何影响 Agent 决策

```
Agent 处理新 Context Event 时：

1. 检索是否有相关 intent
   → 日历有"产品评审会" → 匹配到 intent"这周完成 PRD"
   → 关联度：高

2. 根据关联度决定行动
   → 高关联 + 高重要性 → 自动执行 + 推结果
   → 高关联 + 中重要性 → 推卡片询问要不要帮忙
   → 低关联 → 只记录

3. 执行后更新 intent
   → "准备会议材料" intent 标记为 fulfilled
```

### 3.4 Caring System（关怀系统）

**职责：** 后台持续分析用户状态，在合适的时候让系统主动关心用户。

#### 3.4.1 触发时机

```
触发条件（任一满足）：
├── 用户结束一次对话后（异步触发）
├── 连续 3 小时无交互但有 context 流入（说明用户在忙别的）
├── 检测到时间敏感事件（deadline 临近）
└── 定时触发（每天一次，早上 9:00）
```

#### 3.4.2 Caring Prompt

```yaml
caring_prompt: |
  你是 AI 伙伴的"心"。用户不知道你的存在，但你让系统变得有温度。
  
  ## 当前时间
  {current_time}
  
  ## 最近的 Context Events
  {recent_events}
  
  ## 用户记忆
  {user_memory}
  
  ## 最近的对话
  {recent_conversations}
  
  ## 活跃意图
  {active_intents}
  
  ## 任务
  感受用户的状态，决定是否需要行动。
  
  ### 便签（caring_note）
  问自己：我能帮用户减轻什么负担？
  - 有具体答案 → 写便签
  - 只是"关心一下" → 不写
  
  便签格式：一到两句话。先说用户的状态，再说系统可以怎么做。
  
  ### 闹钟（scheduled_action）
  有没有一个具体的时间点，系统在那时候主动出现能帮上忙？
  - 有 → 设闹钟
  - 没有 → 不设
  
  ### 输出格式
  {
    "user_state": "用户下午连续开会3小时，接下来还有2个会",
    "caring_note": "用户下午密集开会，最后一个会结束后可以推一张今日会议总结卡片",
    "scheduled_action": {
      "time": "2026-05-17T17:30:00+08:00",
      "action": "生成今日会议纪要汇总，推卡片给用户"
    },
    "intent_suggestions": [
      {
        "category": "long_term",
        "description": "用户近期会议密集，可能需要会议效率优化"
      }
    ]
  }
```

#### 3.4.3 便签生命周期

```
便签状态：
├── active    → 生效中，注入到 Agent 上下文
├── consumed  → 已被使用（Agent 根据便签执行了行动）
├── expired   → 已过期（超过有效期或被新便签替代）
└── superseded → 被更新的便签替代

更新规则：
├── 新便签与旧便签同主题 → 替代旧便签
├── 新便签与旧便签不同主题 → 共存
├── 旧便签超过 24 小时 → 自动过期
└── 同时最多 3 个 active 便签，超出则淘汰最旧的
```

### 3.5 Decision Engine（决策引擎）

**职责：** 综合所有信息，决定 Agent 的最终行动。

#### 3.5.1 决策输入

```
决策引擎的输入：
├── Context Event（当前事件）
├── Importance Level（重要性评估）
├── Relevant Memories（相关记忆）
├── Active Intents（活跃意图）
├── Caring Notes（关怀便签）
├── Trust Level（信任等级，MVP 阶段固定为 L1）
└── User Rules（用户设定的规则，如"日程变更不用提醒"）
```

#### 3.5.2 决策输出

```yaml
decision_types:
  ignore:
    description: "不做任何事"
    example: "系统日程更新，不重要"
    
  record:
    description: "只记录到记忆，不推卡片"
    example: "用户创建了一个下周的日程，记录下来"
    
  notify:
    description: "推卡片通知用户"
    example: "日程变更，推卡片告知"
    
  act:
    description: "自动执行 + 推结果卡片"
    example: "1小时后有会，自动准备材料，推卡片"
    
  ask:
    description: "推卡片询问用户要不要帮忙"
    example: "看到明天有评审会，问要不要准备材料"
```

#### 3.5.3 决策规则优先级

```
优先级从高到低：
1. 用户显式规则（"日程变更不用提醒"）→ 直接遵守
2. 时间敏感性（1小时内开始的会）→ 直接推
3. 意图关联（关联到活跃意图）→ 优先处理
4. 重要性评估 → 按等级处理
5. Caring 便签 → 参考但不强制
6. 默认策略 → 中重要性推卡片，低重要性记录
```

---

## 4. 前端交互设计

### 4.1 设计原则

```
极简。一个界面，两个区域。
├── 卡片流（上方/主区域）：系统推送的卡片，按时间倒序
└── 对话框（下方）：用户输入的地方
```

### 4.2 界面布局

```
┌──────────────────────────────────────┐
│  AI is ON                    ◉ 在线  │
├──────────────────────────────────────┤
│                                      │
│  ┌──────────────────────────────┐   │
│  │ 📅 日程变更                   │   │
│  │ 产品评审会时间从15:00改到14:00│   │
│  │                              │   │
│  │ 时间：14:00-15:00            │   │
│  │ 地点：3楼会议室A              │   │
│  │ 参会人：张三、李四            │   │
│  │                              │   │
│  │ [知道了] [帮我准备] [不用提醒] │   │
│  └──────────────────────────────┘   │
│                                      │
│  ┌──────────────────────────────┐   │
│  │ 🤖 我帮你准备了会议材料       │   │
│  │ • 评审会议程（从文档提取）     │   │
│  │ • 上次会议待办（3项已完成）    │   │
│  │ • 相关 PRD 文档链接           │   │
│  │                              │   │
│  │ [查看详细] [发送给我]         │   │
│  └──────────────────────────────┘   │
│                                      │
│  ┌──────────────────────────────┐   │
│  │ 💬 下午好，今天还有3个会。     │   │
│  │ 第一个在14:00，材料已经备好。  │   │
│  └──────────────────────────────┘   │
│                                      │
├──────────────────────────────────────┤
│  ┌──────────────────────────────┐   │
│  │ 输入消息...          [发送]  │   │
│  └──────────────────────────────┘   │
└──────────────────────────────────────┘
```

### 4.3 卡片类型

```yaml
card_types:
  info:
    description: "纯信息通知"
    actions: ["知道了"]
    example: "日程变更提醒"
    
  question:
    description: "询问用户要不要帮忙"
    actions: ["好的", "不需要", "以后不用问"]
    example: "要帮你准备会议材料吗？"
    
  result:
    description: "展示 Agent 执行结果"
    actions: ["查看详细", "发送给我"]
    example: "会议材料准备好了"
    
  summary:
    description: "汇总信息"
    actions: ["查看详情"]
    example: "今日日程概览"
    
  caring:
    description: "关怀类信息"
    actions: ["好的", "谢谢"]
    example: "今天会议比较多，注意休息"
```

### 4.4 卡片底部的学习按钮

每张卡片底部都有一个隐藏的"规则学习"选项：

```
[以后这类事我自己来]  → 信任度 +1，同类事件以后自动处理
[以后这类事不用提醒]  → 记录规则，同类事件以后忽略
[以后提醒改成每天一次] → 修改提醒频率
```

**这是信任系统的核心交互。** 用户不需要设置页面，每次卡片交互都在自然地教系统。

### 4.5 对话框

```
对话框支持：
├── 自然语言输入："下午的评审会帮我准备一下"
├── 快捷指令："/today" → 今日日程概览
├── 追问："这个会的上次会议纪要呢？"
└── 规则设定："以后周五下午不要推卡片"
```

---

## 5. 飞书集成方案

### 5.1 MVP 数据源：飞书日历

```
接入方式：lark-cli（已配置，OAuth 已授权）

采集命令：
  lark calendar +agenda --from now --to +2h
  → 返回 JSON 格式的日程列表
  → 解析变更，生成 Context Event

事件类型映射：
  飞书日历 API event → Context Event
  ├── organizer → source_user
  ├── summary → title
  ├── start_time / end_time → 时间
  ├── attendees → 参会人
  ├── location → 地点
  └── description → 描述
```

### 5.2 输出渠道：飞书消息

```
推送方式：lark-cli 发送消息

命令：
  lark im send --chat-id {chat_id} --type interactive --content {card_json}

卡片格式：飞书消息卡片（Interactive Card）
  ├── 标题
  ├── 内容（Markdown）
  ├── 按钮（飞书卡片按钮）
  └── 回调（用户点击按钮 → Webhook → Agent 处理）
```

### 5.3 后续数据源（Phase 2+）

```
Phase 2:
├── 飞书文档（文档创建/更新/评论）
├── 飞书消息（聊天记录中的关键信息提取）
└── 飞书任务（任务创建/完成/到期）

Phase 3:
├── 飞书邮件（新邮件摘要）
├── 飞书审批（审批状态变更）
└── 飞书视频会议（会议纪要自动生成）
```

---

## 6. MVP 分期路线图

### Phase 0：基座搭建（1 周）

```
目标：Claude Code 源码能跑通基本 Agent Loop

任务：
├── [ ] Claude Code 源码编译运行
├── [ ] Agent Loop 跑通（输入 → LLM → 工具调用 → 输出）
├── [ ] 替换 LLM Provider 为 Claude API（先不换国产）
├── [ ] 注册 lark-cli 为可用工具
└── [ ] 基本的对话能力验证

验证标准：
  给 Agent 一个任务："查一下我今天有什么日程"
  → Agent 调 lark-cli → 返回日程列表 → 用户看到结果
```

### Phase 1：Context 自动流入（1 周）

```
目标：日历变更能自动触发 Agent 处理

任务：
├── [ ] 日历轮询器（每 5 分钟拉一次日程）
├── [ ] 变更检测（diff 算法，识别新增/修改/取消）
├── [ ] Context Event 生成和存储
├── [ ] Context Processor Agent（重要性判断 + 处理）
├── [ ] 飞书消息卡片推送
└── [ ] SQLite Context Store 初始化

验证标准：
  手动修改一个日历事件
  → 5 分钟内收到飞书消息卡片
  → 卡片内容正确反映变更
```

### Phase 2：Intent + Caring（1 周）

```
目标：系统能记住用户意图，能主动关心

任务：
├── [ ] Intent Recorder（从对话中提取意图）
├── [ ] Intent Store（SQLite 存储）
├── [ ] Intent 关联决策（事件 → 关联意图 → 行动）
├── [ ] Caring Analyzer（对话后分析用户状态）
├── [ ] Caring Note 生成和生命周期管理
├── [ ] 便签注入 Agent 上下文
└── [ ] 规则学习（卡片按钮 → 用户规则）

验证标准：
  用户说"下午的评审会帮我准备材料"
  → Intent 被记录（短期意图）
  → 下次日历有评审会相关事件
  → Agent 自动准备材料并推送
```

### Phase 3：前端 + 记忆（1 周）

```
目标：有完整的前端体验，记忆系统工作

任务：
├── [ ] Electron 前端（对话框 + 卡片流）
├── [ ] 卡片渲染（info/question/result/summary/caring）
├── [ ] 卡片交互（按钮点击 → 回调 Agent）
├── [ ] Profile 记忆（自动提取用户身份和状态）
├── [ ] Preferences 记忆（自动提取用户偏好）
├── [ ] 记忆压缩（定期合并精简）
├── [ ] 向量检索（Qdrant，语义搜索记忆）
└── [ ] 对话框自然语言交互

验证标准：
  完整链路跑通：
  日历变更 → Agent 处理 → 推卡片 → 用户交互 → 记忆更新
  连续使用 3 天，系统越来越懂用户
```

### Phase 4：打磨 + 扩展（持续）

```
目标：日常使用，持续优化

任务：
├── [ ] 接入更多数据源（文档、消息、任务）
├── [ ] 会中实时 Agent（会议场景）
├── [ ] 多 Agent 协作（不同场景不同 Agent）
├── [ ] 信任系统完整实现
├── [ ] 性能优化（响应延迟 < 10s）
└── [ ] 从 Claude API 迁移到 DeepSeek/Qwen
```

---

## 7. 技术风险与应对

### 7.1 关键风险

| 风险 | 影响 | 概率 | 应对 |
|------|------|------|------|
| Claude Code 源码改造困难 | 基座不可用 | 中 | 备选方案：用 OpenAI Agents SDK 重写 Agent Loop |
| LLM 推理成本高 | 日常运行费用不可控 | 高 | 先用 Claude API 验证效果，后续换国产模型 |
| 推送不准确 | 用户觉得被打扰 | 中 | MVP 阶段保守推送，宁可漏推；通过卡片反馈持续优化 |
| 飞书 API 限流 | 数据采集不及时 | 低 | 轮询间隔可调，MVP 5 分钟够用 |
| 记忆提取不准确 | 系统理解偏差 | 中 | 前期人工校正，积累数据后优化 prompt |

### 7.2 备选方案

```
如果 Claude Code 源码改造太重：
  → 方案 B：用 OpenAI Agents SDK 从零写 Agent Loop
  → 工作量：约 2-3 天（之前估算过 ~800 行代码）
  → 损失：失去子 Agent 系统和成熟的工具框架
  → 获得：完全可控，无历史包袱

如果 Claude API 成本太高：
  → 方案 B：直接用 DeepSeek API
  → 工作量：几乎为零（OpenAI 兼容格式）
  → 损失：推理质量可能下降
  → 获得：成本降低 10 倍以上

如果推送效果不好：
  → 方案 B：先不做自动推送，改为"每日摘要"
  → 每天早上推一张今日日程概览卡片
  → 降低打扰风险，但失去"实时性"
```

---

## 附录 A：与 Cola 系统的对比

| 维度 | Cola（当前系统） | AI is ON Demo |
|------|-----------------|---------------|
| 触发方式 | 用户说话才响应 | Context 流动自动触发 |
| 记忆 | 手动 + episodes 自动 | 自动提取 + 自动压缩 |
| Caring | 后台子 Agent | 独立 Caring Analyzer |
| 前端 | 桌面对话框 | 对话框 + 卡片流 |
| 数据源 | 无外部数据源 | 飞书日历（MVP） |
| 信任系统 | 无 | 卡片交互渐进学习 |
| 存在状态 | 用户打开才在 | 持续运行 |

## 附录 B：关键术语

| 术语 | 定义 |
|------|------|
| Context | 流动的用户相关数据，不是静态存储 |
| Intent | 用户的意图，分即时/短期/长期/习惯 |
| Caring | 后台分析用户状态的机制 |
| Card | 系统推送给用户的信息卡片 |
| Trust Level | 用户对系统的信任等级，通过交互渐进积累 |
| Context Event | 一条标准化的上下文变更记录 |
| Caring Note | Caring 系统生成的便签，注入 Agent 上下文 |
