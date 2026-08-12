/* 交易破位风控：纯判定逻辑（尾盘检查用），不含数据拉取 */

export interface BreakInput {
  close: number; // 当日收盘（尾盘检查时用实时价）
  open: number;
  low: number;
  volume: number; // 当日成交量（手）
  ma5: number; // 含当日收盘的 5 日均线
  avgVol5: number; // 过去 5 个交易日平均成交量（手，不含当日）
}

export type BreakDecision = 'HOLD' | 'SELL_NOW' | 'OBSERVE';

export interface BreakMetrics {
  volRatio: number; // 量比 = 当日量 / 过去5日均量
  body: number; // K线实体 = |收-开| / 开
  breakRatio: number; // 偏离度 = (MA5-收)/MA5，正值
}

export interface BreakResult {
  decision: BreakDecision;
  reason: string;
  metrics: BreakMetrics;
}

/** 第二步 + 第三步：单日破位判定（严格按 SOP 顺序） */
export function evaluateBreak(input: BreakInput): BreakResult {
  const { close, open, volume, ma5, avgVol5 } = input;
  const volRatio = avgVol5 > 0 ? volume / avgVol5 : 0;
  const body = open > 0 ? Math.abs(close - open) / open : 0;
  const breakRatio = ma5 > 0 ? Math.max(0, (ma5 - close) / ma5) : 0;
  const metrics: BreakMetrics = { volRatio, body, breakRatio };

  const pct = (value: number) => `${(value * 100).toFixed(2)}%`;

  // 第二步：收盘价 >= MA5 → HOLD，终止流程
  if (close >= ma5) {
    return {
      decision: 'HOLD',
      reason: `收盘 ${close} >= MA5 ${ma5.toFixed(2)}，趋势正常，继续持有`,
      metrics,
    };
  }

  // 第三步 场景A：🔴 红色警报（严重破位）
  if (volRatio > 1.2 && (body > 0.03 || breakRatio > 0.02)) {
    return {
      decision: 'SELL_NOW',
      reason: `放量破位：量比 ${volRatio.toFixed(2)} > 1.2 且 ${
        body > 0.03 ? `实体 ${pct(body)} > 3%` : `偏离 MA5 ${pct(breakRatio)} > 2%`
      }，资金承接出现问题，逻辑证伪`,
      metrics,
    };
  }

  // 第三步 场景B：🟡 黄色警报（轻度破位，启动三天观察期）
  if (volRatio <= 1.2 && body <= 0.03 && breakRatio <= 0.02) {
    return {
      decision: 'OBSERVE',
      reason: `轻度破位：量比 ${volRatio.toFixed(2)}、实体 ${pct(body)}、偏离 ${pct(
        breakRatio
      )} 均未超限，逻辑未坏，启动三天观察期（止损底线 = 今日最低 ${input.low}）`,
      metrics,
    };
  }

  // 未覆盖组合（如缩量大阴线）：破位幅度超限但无量比配合 → 保守卖出
  return {
    decision: 'SELL_NOW',
    reason: `破位幅度超限：实体 ${pct(body)} / 偏离 ${pct(
      breakRatio
    )}（量比 ${volRatio.toFixed(2)}），有效破位特征，保守卖出`,
    metrics,
  };
}

export interface BreakWatchState {
  code: string;
  name: string;
  startDate: string; // 触发观察日期 YYYYMMDD
  stopLoss: number; // 止损底线 = 触发日最低价
  lastDate: string; // 上次检查日期
  days: number; // 已观察天数
}

/**
 * 第四步：观察期连续处理。
 * 每次尾盘检查时对处于观察期的股票调用，推进天数并判定。
 */
export function advanceWatch(
  state: BreakWatchState,
  input: BreakInput,
  today: string
): { decision: BreakDecision; reason: string; nextState: BreakWatchState } {
  // 与上次检查同日则不重复推进（同日内多次调用幂等）
  const isNewDay = today !== state.lastDate;
  const days = isNewDay ? state.days + 1 : state.days;
  const nextState: BreakWatchState = { ...state, lastDate: today, days };

  if (input.close >= input.ma5) {
    return {
      decision: 'HOLD',
      reason: `观察第 ${days} 天：收盘 ${input.close} 重新站上 MA5 ${input.ma5.toFixed(2)}，判定为真洗盘，解除警报`,
      nextState: { ...nextState, days: 0 },
    };
  }
  if (input.low < state.stopLoss) {
    return {
      decision: 'SELL_NOW',
      reason: `观察第 ${days} 天：最低价 ${input.low} 跌破止损底线 ${state.stopLoss}，破位加深，提前止损`,
      nextState,
    };
  }
  if (days >= 3) {
    return {
      decision: 'SELL_NOW',
      reason: `观察期已满 3 天，收盘 ${input.close} 仍低于 MA5 ${input.ma5.toFixed(
        2
      )}，有效破位，尾盘必须卖出`,
      nextState,
    };
  }
  return {
    decision: 'OBSERVE',
    reason: `观察第 ${days} 天（起始 ${state.startDate}）：未跌破止损底线 ${state.stopLoss}，继续观察`,
    nextState,
  };
}
