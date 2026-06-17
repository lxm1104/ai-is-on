/**
 * MVP58 — 极简进程内"该排查了"信号。叶子模块（零 import），解耦 matterReducer ↔ dispatcher 避免循环依赖。
 *
 * 产生新可排查事项的地方（如 matterReducer 新建 matter）调用 kickInvestigation()；
 * dispatcher 启动时 onInvestigationKick(...) 订阅，收到即近实时派发一次（带去抖+在飞行锁，见 dispatcher）。
 * 这把"每 N 分钟轮询"升级成"新信息一到就立刻查"。
 */
type KickHandler = () => void;

let handler: KickHandler | null = null;

/** dispatcher 注册：收到 kick 就近实时派发。 */
export function onInvestigationKick(h: KickHandler): void {
  handler = h;
}

/** 任何"出现了新需排查事项"的地方调用——立刻触发一次派发（去抖由 handler 内部管）。 */
export function kickInvestigation(): void {
  try {
    handler?.();
  } catch {
    // 派发异常不回压调用方（matter 创建等主流程不受影响）
  }
}
