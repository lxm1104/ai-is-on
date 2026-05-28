/**
 * MVP21 S1 §3.1 — Context layer classifier.
 *
 * 纯函数，无副作用、不落表。把任一 ContextUnit 分到 6 个 layer 之一 + 6/7 种 source。
 * S1 阶段：只用于 packet 装配时挂 `_layerHint`、attention prompt 行尾输出 `[src=...]`、
 * ContextPanel debug 显示。**不影响**现有 filter / score / 排序逻辑。
 *
 * 详见 docs/MVP21-Context语义分层与结构层收拢技术方案.md §3.2。
 */
import type { ContextUnit } from './ContextUnit.js';

export type ContextLayer =
  | 'identity_fact'      // 用户身份 / 角色 / 关系 / 长期偏好；半年级稳定
  | 'project_intent'     // 项目元信息 / 长期目标 / 权威文档；季度级稳定
  | 'dynamic_signal'     // 当下事件 / 临期 commitment / 当前 uncertainty / action_result；周级
  | 'pending_inference'  // 系统推断、待用户确权（suggestion 等）
  | 'derived_signal'     // 系统从其它 layer 算出的派生关联（entity_edges 等）
  | 'output';            // LLM 最终输出（attention_item / agent_run.output）

export type ContextSource =
  | 'work_map_seed'    // workMapWriter 写入，mergeHint 以 'work_map:' 开头
  | 'triage'           // triage enrichment (origin.kind='event' 且 unit.kind != 'event')
  | 'collector'        // collector 直写最小 event unit (origin.kind='event' 且 unit.kind='event')
  | 'agent_run'        // agent handler 写入 (origin.kind='agent_run')
  | 'card_action'      // 卡片动作触发的写入 (origin.kind='card_action')
  | 'manual'           // 用户在 UI 或 chat 中创建 (origin.kind='manual' | 'chat')
  | 'system_feedback'  // 非 work_map 的 system 路径（如 workMapMutator 写 attention_feedback）
  | 'inducer'          // 后台 inducer 写入（如有）
  | 'unknown';         // 兜底，不应在生产环境出现

export type ContextLayerHint = {
  layer: ContextLayer;
  source: ContextSource;
  /** 用户/权威系统直接断言；false = 系统推断 */
  asserted: boolean;
  /** 用户在 UI 上能直接改写；false = 系统派生或锁定 */
  voluntary: boolean;
};

/**
 * 把 ContextUnit 分类到 layer + source。完全基于 unit 的内在字段（mergeKey、origin、kind），
 * 不查 DB、不依赖外部状态。O(1)。
 *
 * 优先级：
 *   1. mergeKey 以 'work_map:' 开头 → 走 work_map_seed 分支（MVP7 起此前缀被直接当 mergeKey 存）
 *   2. 否则按 origin.kind 路由
 */
export function classifyContextUnit(u: ContextUnit): ContextLayerHint {
  const mk = u.mergeKey ?? '';

  // ---- 1) work_map:* mergeKey 前缀：按 sub-prefix 分到 identity / intent / dynamic ----
  if (mk.startsWith('work_map:')) {
    if (
      mk.startsWith('work_map:role:') ||
      mk.startsWith('work_map:responsibility:') ||
      mk.startsWith('work_map:relationship:') ||
      mk.startsWith('work_map:preference:')
    ) {
      return { layer: 'identity_fact', source: 'work_map_seed', asserted: true, voluntary: true };
    }
    if (mk.startsWith('work_map:goal:')) {
      return { layer: 'project_intent', source: 'work_map_seed', asserted: true, voluntary: true };
    }
    if (mk.startsWith('work_map:commitment:') || mk.startsWith('work_map:risk:')) {
      // 流速 dynamic，但 source='work_map_seed' + asserted=true 让消费方区分
      return { layer: 'dynamic_signal', source: 'work_map_seed', asserted: true, voluntary: true };
    }
    // 未知 work_map:* 子前缀（防 schema 漂移）：当 identity_fact 兜底，最不破坏
    return { layer: 'identity_fact', source: 'work_map_seed', asserted: true, voluntary: true };
  }

  // ---- 2) 非 work_map：按 origin.kind 路由 ----
  const origin = u.origin.kind;
  switch (origin) {
    case 'event':
      // collector 直写最小 event unit (kind='event') vs triage enrichment 写的语义 unit
      // (contextStore.insertMinimalEventContextUnit + triageQueue.ts:230 都用 origin.kind='event')
      if (u.kind === 'event') {
        return { layer: 'dynamic_signal', source: 'collector', asserted: false, voluntary: false };
      }
      return { layer: 'dynamic_signal', source: 'triage', asserted: false, voluntary: false };

    case 'agent_run':
      // caringAgent / cards/contextProjection 等写入
      return { layer: 'dynamic_signal', source: 'agent_run', asserted: false, voluntary: false };

    case 'card_action':
      // larkTaskService / actionItems 路径：用户点了卡片按钮触发写入，本质是用户断言
      return { layer: 'dynamic_signal', source: 'card_action', asserted: true, voluntary: true };

    case 'manual':
    case 'chat':
      // manualEvent 或聊天上下文中的写入。preference / relationship 视作身份层。
      if (u.kind === 'preference' || u.kind === 'relationship') {
        return { layer: 'identity_fact', source: 'manual', asserted: true, voluntary: true };
      }
      return { layer: 'dynamic_signal', source: 'manual', asserted: true, voluntary: true };

    case 'system':
      // 已知场景：workMapMutator 写 origin.kind='system' + refId='attention_feedback'
      // （走到这里说明 mergeKey 不以 'work_map:' 开头）
      return { layer: 'dynamic_signal', source: 'system_feedback', asserted: true, voluntary: false };

    default:
      // ContextOriginKind 未来扩枚举的兜底
      return { layer: 'dynamic_signal', source: 'unknown', asserted: false, voluntary: false };
  }
}
