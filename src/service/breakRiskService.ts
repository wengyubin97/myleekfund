import axios from 'axios';
import StockService from '../explorer/stockService';
import globalState from '../globalState';
import { LeekTreeItem } from '../shared/leekTreeItem';
import { LeekFundConfig } from '../shared/leekConfig';
import {
  BreakInput,
  BreakWatchState,
  advanceWatch,
  evaluateBreak,
} from '../shared/breakRisk';

const KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=';
const KLINE_TTL = 30000;
const WATCH_CONFIG_KEY = 'leek-fund.breakWatch';

export interface DailyBar {
  date: string; // YYYYMMDD
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number; // 手
}

let klineCache: { key: string; data: Map<string, Array<DailyBar>>; time: number } | null = null;

/** 拉取前复权日线（30 秒缓存），仅支持 A股/港股 */
async function fetchDailyKlines(codes: Array<string>): Promise<Map<string, Array<DailyBar>>> {
  const now = Date.now();
  if (klineCache && klineCache.key === codes.join(',') && now - klineCache.time < KLINE_TTL) {
    return klineCache.data;
  }
  const map = new Map<string, Array<DailyBar>>();
  await Promise.all(
    codes.map(async (code) => {
      try {
        const resp = await axios.get(`${KLINE_URL}${code},day,,,20,qfq`, {
          headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
          timeout: 8000,
        });
        const data: any = resp.data?.data?.[code];
        const rows: Array<Array<string>> = data?.qfqday || data?.day || [];
        const bars: Array<DailyBar> = rows
          .map((row) => ({
            date: String(row[0]),
            open: parseFloat(row[1]),
            close: parseFloat(row[2]),
            high: parseFloat(row[3]),
            low: parseFloat(row[4]),
            volume: parseFloat(row[5]),
          }))
          .filter((bar) => !isNaN(bar.close) && bar.close > 0 && !isNaN(bar.volume));
        if (bars.length) {
          map.set(code, bars);
        }
      } catch (err) {
        console.error(`fetch kline failed: ${code}`, err);
      }
    })
  );
  klineCache = { key: codes.join(','), data: map, time: Date.now() };
  return map;
}

/** 计算 MA5（含当日收盘）与 AVG_VOL_5（过去 5 日成交量均值，不含当日） */
function computeTrendInputs(
  bars: Array<DailyBar>,
  today: string,
  close: number,
  volume: number
): { ma5: number; avgVol5: number } {
  const prevBars = bars.filter((bar) => bar.date !== today);
  const tail = prevBars.slice(-5);
  const avgVol5 = tail.reduce((sum, bar) => sum + bar.volume, 0) / Math.max(tail.length, 1);
  // MA5 = 最近 4 根历史收盘 + 当日收盘
  const maCloses = [...tail.slice(-4).map((bar) => bar.close), close];
  const ma5 = maCloses.reduce((sum, value) => sum + value, 0) / maCloses.length;
  return { ma5, avgVol5 };
}

function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** 读取观察期记忆 */
function getWatchStates(): Array<BreakWatchState> {
  return (LeekFundConfig.getConfig(WATCH_CONFIG_KEY) || []) as Array<BreakWatchState>;
}

function saveWatchStates(states: Array<BreakWatchState>) {
  LeekFundConfig.setConfig(WATCH_CONFIG_KEY, states);
}

export interface BreakCheckOutcome {
  code: string;
  name: string;
  decision: string;
  reason: string;
  isWatchStart: boolean; // 本次是否新触发观察期
  days?: number; // 观察期已观察天数（OBSERVE 时）
}

export interface BreakCheckResult {
  outcomes: Array<BreakCheckOutcome>;
  checkedAt: string; // 检查时间 HH:mm
}

/** 对单只自选股执行破位风控检查（含观察期记忆推进） */
export async function checkBreakRiskForStock(
  item: LeekTreeItem,
  today: string = todayStr()
): Promise<BreakCheckOutcome | null> {
  const { code, name, price, open, low, volume } = item.info;
  const close = parseFloat(price || '');
  if (isNaN(close) || close <= 0) {
    return null;
  }
  const openNum = parseFloat(String(open || '0'));
  const lowNum = parseFloat(String(low || '0'));
  const volNum = parseFloat(String(volume || '0'));

  const klines = await fetchDailyKlines([code]);
  const bars = klines.get(code);
  if (!bars || bars.length < 6) {
    return null; // 日线不足（新股/无数据），跳过
  }
  const { ma5, avgVol5 } = computeTrendInputs(bars, today, close, volNum);
  const input: BreakInput = {
    close,
    open: openNum,
    low: lowNum,
    volume: volNum,
    ma5,
    avgVol5,
  };

  // 观察期记忆
  const states = getWatchStates();
  const existing = states.find((state) => state.code === code);
  let outcome: BreakCheckOutcome;
  let isWatchStart = false;

  if (existing && existing.days > 0) {
    const { decision, reason, nextState } = advanceWatch(existing, input, today);
    if (decision !== 'OBSERVE') {
      // 解除（HOLD）或止损（SELL_NOW）→ 移除观察期
      saveWatchStates(states.filter((state) => state.code !== code));
    } else {
      saveWatchStates(
        states.map((state) => (state.code === code ? nextState : state))
      );
    }
    outcome = {
      code,
      name,
      decision,
      reason,
      isWatchStart: false,
      days: decision === 'OBSERVE' ? nextState.days : undefined,
    };
  } else {
    const result = evaluateBreak(input);
    if (result.decision === 'OBSERVE') {
      // 新触发观察期：止损底线 = 当日最低价
      const nextState: BreakWatchState = {
        code,
        name,
        startDate: today,
        stopLoss: lowNum,
        lastDate: today,
        days: 1,
      };
      saveWatchStates([...states.filter((state) => state.code !== code), nextState]);
      isWatchStart = true;
    }
    outcome = {
      code,
      name,
      decision: result.decision,
      reason: result.reason,
      isWatchStart,
      days: result.decision === 'OBSERVE' ? 1 : undefined,
    };
  }
  return outcome;
}

/** 对全部自选股执行检查，返回结果 */
export async function checkBreakRiskAll(stockService: StockService): Promise<BreakCheckResult> {
  const outcomes: Array<BreakCheckOutcome> = [];
  const codes = stockService.stockList.map((item) => item.info.code);
  // 预拉全部日线（一次性批量请求）
  const today = todayStr();
  await fetchDailyKlines(codes);
  await Promise.all(
    stockService.stockList.map(async (item) => {
      try {
        const outcome = await checkBreakRiskForStock(item, today);
        if (outcome) {
          outcomes.push(outcome);
        }
      } catch (err) {
        console.error(`break risk check failed: ${item.info.code}`, err);
      }
    })
  );
  const d = new Date();
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  // 写入全局状态供 Stock 视图追加破位标记
  globalState.breakRiskOutcomes = {};
  outcomes.forEach((o) => {
    globalState.breakRiskOutcomes[o.code] = { decision: o.decision, reason: o.reason, days: o.days };
  });
  return { outcomes, checkedAt: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}
