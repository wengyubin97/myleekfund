import axios from 'axios';
import * as zlib from 'zlib';
import { MarkdownString } from 'vscode';
import { LeekTreeItem } from '../shared/leekTreeItem';

const MINUTE_QUERY = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=';
const CACHE_TTL = 30000; // 分钟数据缓存 30 秒
const RENDER_TTL = 30000; // 渲染图缓存 30 秒
const FETCH_CONCURRENCY = 6; // 分钟数据请求并发数
const FAST_MOVE_THRESHOLD = 0.15; // %/分钟，低于此速度的线段画灰色
const FULL_SAT_SPEED = 0.6; // %/分钟，达到该速度时颜色完全饱和
const COLOR_GRAY: [number, number, number] = [150, 150, 150];
const COLOR_UP: [number, number, number] = [240, 82, 82];
const COLOR_DOWN: [number, number, number] = [64, 175, 84];
const COLOR_AVG: [number, number, number] = [240, 200, 40]; // 均价线（黄）
const VOLUME_AREA_H = 26; // 分时量柱区域高度（px）

export type TrendSignal = {
  level: 'extreme' | 'fast';
  direction: 'up' | 'down';
} | null;

/** 时间字符串（HHMM）转分钟数 */
function minuteOf(time: string): number {
  const h = parseInt(time.slice(0, 2), 10);
  const m = parseInt(time.slice(2, 4), 10);
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
}

/** 根据曲线最后一段的速度/方向判定信号（时间缺口不判定） */
export function getCurveSignal(curve: Array<CurvePoint>): TrendSignal {
  if (curve.length < 2) {
    return null;
  }
  const prev = curve[curve.length - 2];
  const last = curve[curve.length - 1];
  if (minuteOf(last.time) - minuteOf(prev.time) > 1) {
    return null;
  }
  const diffPct = last.pct - prev.pct;
  const speed = Math.abs(diffPct);
  if (speed < FAST_MOVE_THRESHOLD) {
    return null;
  }
  const direction = diffPct > 0 ? 'up' : 'down';
  const level = speed >= FULL_SAT_SPEED ? 'extreme' : 'fast';
  return { level, direction };
}

/** 信号的中文提示文案 */
export function signalLabel(signal: TrendSignal): string {
  if (!signal) {
    return '';
  }
  if (signal.level === 'extreme') {
    return signal.direction === 'up' ? '⚡ 极速拉升' : '⚡ 极速下杀';
  }
  return signal.direction === 'up' ? '⚠ 快速拉升' : '⚠ 快速下杀';
}

const signalCache = new Map<string, { time: number; signal: TrendSignal }>();

async function getSignalFor(codes: Array<string>): Promise<TrendSignal> {
  const key = codes.join(',');
  const now = Date.now();
  const cached = signalCache.get(key);
  if (cached && now - cached.time < RENDER_TTL) {
    return cached.signal;
  }
  const records = await getMinuteRecords(codes);
  const curve = buildEqualWeightCurve(records);
  const signal = getCurveSignal(curve);
  signalCache.set(key, { time: now, signal });
  return signal;
}

export const getStockSignal = (code: string): Promise<TrendSignal> => getSignalFor([code]);

/**
 * 个股最近 1 分钟涨跌幅（%）：分钟线最后两根差分（盘中最后一根滚动刷新）。
 * 复用 getMinuteRecords 的 30 秒缓存；时间缺口或无数据时返回 null。
 */
export async function getStockGain1m(code: string): Promise<number | null> {
  if (!isMinuteSupported(code)) {
    return null;
  }
  const records = await getMinuteRecords([code]);
  const curve = buildEqualWeightCurve(records);
  if (curve.length < 2) {
    return null;
  }
  const prev = curve[curve.length - 2];
  const last = curve[curve.length - 1];
  if (minuteOf(last.time) - minuteOf(prev.time) > 1) {
    return null;
  }
  return last.pct - prev.pct;
}

export const getGroupSignal = (codes: Array<string>): Promise<TrendSignal> =>
  getSignalFor(codes);

export interface MinuteRecord {
  code: string;
  prevClose: number;
  points: Array<MinutePoint>;
}

export interface MinutePoint {
  time: string;
  price: number;
  volume?: number;
  amount?: number;
}

export interface CurvePoint {
  time: string;
  pct: number;
}

/** 解析腾讯分钟线接口的单只股票响应 */
export function parseMinuteResponse(code: string, body: any): MinuteRecord | null {
  const stock = body?.data?.[code];
  const list: Array<string> = stock?.data?.data || [];
  const qtArr: Array<any> = stock?.qt?.[code] || [];
  const prevClose = parseFloat(qtArr[4]);
  const points: Array<MinutePoint> = [];
  list.forEach((line) => {
    const parts = String(line).split(/\s+/);
    if (parts.length >= 2) {
      const price = parseFloat(parts[1]);
      if (!isNaN(price)) {
        points.push({
          time: parts[0],
          price,
          volume: parseFloat(parts[2]) || undefined,
          amount: parseFloat(parts[3]) || undefined,
        });
      }
    }
  });
  if (!isNaN(prevClose) && prevClose > 0 && points.length) {
    return { code, prevClose, points };
  }
  return null;
}

let minuteCache: { key: string; data: Map<string, MinuteRecord>; time: number } | null = null;
const renderedUriCache = new Map<string, { time: number; uri: string | null }>();

/** 是否有分时数据接口（A股/港股/美股） */
export function isMinuteSupported(code: string): boolean {
  return /^(sh|sz|bj|hk|usr_)/.test(code);
}

/** 内部代码转腾讯分钟线接口代码（美股 usr_xxx -> usXXX） */
export function toMinuteQueryCode(code: string): string {
  if (/^usr_/.test(code)) {
    return 'us' + code.substring(4).toUpperCase();
  }
  return code;
}

/** 拉取多只股票的分钟数据（含昨收，用于归一化） */
export async function fetchMinuteData(codes: Array<string>): Promise<Map<string, MinuteRecord>> {
  const supported = codes.filter(isMinuteSupported);
  const map = new Map<string, MinuteRecord>();
  if (!supported.length) {
    return map;
  }
  const now = Date.now();
  if (minuteCache && minuteCache.key === supported.join(',') && now - minuteCache.time < CACHE_TTL) {
    return minuteCache.data;
  }

  let index = 0;
  const worker = async () => {
    while (index < supported.length) {
      const code = supported[index++];
      try {
        const queryCode = toMinuteQueryCode(code);
        const resp = await axios.get(`${MINUTE_QUERY}${queryCode}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            Referer: 'https://gu.qq.com/',
          },
          timeout: 8000,
        });
        const body: any = resp.data;
        const record = parseMinuteResponse(queryCode, body);
        if (record) {
          map.set(code, { ...record, code });
        }
      } catch (err) {
        console.error(`fetch minute data failed: ${code}`, err);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, supported.length) }, () => worker())
  );

  minuteCache = { key: supported.join(','), data: map, time: Date.now() };
  return map;
}

/** 按分钟对齐，计算组内股票的等权平均涨跌幅曲线 */
export function buildEqualWeightCurve(records: Array<MinuteRecord>): Array<CurvePoint> {
  if (!records.length) {
    return [];
  }
  const timeMap = new Map<string, Array<number>>();
  records.forEach((record) => {
    record.points.forEach((point) => {
      const pct = (point.price / record.prevClose - 1) * 100;
      const arr = timeMap.get(point.time) || [];
      arr.push(pct);
      timeMap.set(point.time, arr);
    });
  });
  const times = Array.from(timeMap.keys()).sort();
  return times.map((time) => {
    const arr = timeMap.get(time) || [];
    const avg = arr.reduce((sum, value) => sum + value, 0) / arr.length;
    return { time, pct: avg };
  });
}

/** 计算等权均价线：各成分股先算累计均价（VWAP）涨跌幅，再按分钟等权平均 */
export function buildEqualWeightAvgPriceCurve(records: Array<MinuteRecord>): Array<CurvePoint> {
  if (!records.length) {
    return [];
  }
  const timeMap = new Map<string, Array<number>>();
  records.forEach((record) => {
    // 仅支持含成交额数据的品种（A股/港股）；指数等价格与成交额口径不一致时跳过
    const lastPoint = record.points[record.points.length - 1];
    if (
      !lastPoint ||
      lastPoint.price <= 0 ||
      lastPoint.volume == null ||
      lastPoint.amount == null ||
      lastPoint.volume <= 0 ||
      lastPoint.amount <= 0
    ) {
      return;
    }
    // 腾讯分钟数据的成交额/成交量是累计值：均价 = 累计成交额 / 累计成交量
    // 自动识别成交量单位：A股为“手”（1手=100股），均价需再除以 100
    const rawVwap = lastPoint.amount / lastPoint.volume;
    const lotFactor =
      Math.abs(rawVwap / lastPoint.price - 1) <= 0.3
        ? 1
        : Math.abs(rawVwap / 100 / lastPoint.price - 1) <= 0.3
        ? 100
        : 0;
    if (lotFactor === 0) {
      return;
    }
    record.points.forEach((point) => {
      if (point.volume && point.amount && record.prevClose > 0) {
        const avgPrice = point.amount / point.volume / lotFactor;
        const pct = (avgPrice / record.prevClose - 1) * 100;
        const arr = timeMap.get(point.time) || [];
        arr.push(pct);
        timeMap.set(point.time, arr);
      }
    });
  });
  const times = Array.from(timeMap.keys()).sort();
  return times.map((time) => {
    const arr = timeMap.get(time) || [];
    const avg = arr.reduce((sum, value) => sum + value, 0) / arr.length;
    return { time, pct: avg };
  });
}

/** 计算每分钟成交量（累计量的差分，跨成分股求和），用于分时量柱 */
export function buildVolumeMap(records: Array<MinuteRecord>): Map<string, number> {
  const map = new Map<string, number>();
  records.forEach((record) => {
    let prev = 0;
    record.points.forEach((point) => {
      const cum = point.volume || 0;
      const minuteVol = cum - prev;
      prev = cum;
      if (minuteVol > 0) {
        map.set(point.time, (map.get(point.time) || 0) + minuteVol);
      }
    });
  });
  return map;
}

/** 最新一根分时量对比上一根及前几根均值（MA5/MA10，不含当前）；数据不足两根时返回 null */
export function getLatestVolumeCompare(
  records: Array<MinuteRecord>
): { cur: number; prev: number; ma5: number | null; ma10: number | null } | null {
  const map = buildVolumeMap(records);
  const times = Array.from(map.keys()).sort();
  if (times.length < 2) {
    return null;
  }
  const cur = map.get(times[times.length - 1]) || 0;
  const prev = map.get(times[times.length - 2]) || 0;
  if (prev <= 0) {
    return null;
  }
  const prevVols = times.slice(0, -1).map((t) => map.get(t) || 0); // 不含当前
  const avgOf = (n: number): number | null => {
    const slice = prevVols.slice(-n);
    return slice.length < n ? null : slice.reduce((s, v) => s + v, 0) / n;
  };
  return { cur, prev, ma5: avgOf(5), ma10: avgOf(10) };
}

/* ---------- 最小 PNG 编码器（RGBA，zlib 压缩） ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 折线图绘制 ---------- */

function setPixel(
  rgba: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  color: [number, number, number],
  alpha: number
) {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return;
  }
  const offset = (y * width + x) * 4;
  rgba[offset] = color[0];
  rgba[offset + 1] = color[1];
  rgba[offset + 2] = color[2];
  rgba[offset + 3] = alpha;
}

function drawDot(
  rgba: Buffer,
  width: number,
  height: number,
  cx: number,
  cy: number,
  color: [number, number, number],
  radius = 3
) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) {
        setPixel(rgba, width, height, cx + dx, cy + dy, color, 255);
      }
    }
  }
}

/** 画连续线段（按步长插值，保证曲线不出现断点） */
function drawLine(
  rgba: Buffer,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: [number, number, number],
  thickness = 3
) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  const half = Math.floor(thickness / 2);
  const low = -half;
  const high = thickness - half - 1;
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    for (let d = low; d <= high; d++) {
      setPixel(rgba, width, height, x, y + d, color, 255);
    }
  }
}

/* ---------- 5x7 位图字体（数字、符号、MAX/MIN） ---------- */

const FONT_5X7: Record<string, Array<string>> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '00110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '00110', '00110'],
  '%': ['11001', '11001', '00010', '00100', '01000', '10011', '10011'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  S: ['01110', '10001', '10000', '01110', '00001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
};

const FONT_W = 6; // 字符宽度（5 点 + 1 间距）
const FONT_H = 7;

function drawText(
  rgba: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  text: string,
  color: [number, number, number]
) {
  let cx = x;
  for (const ch of text) {
    const glyph = FONT_5X7[ch];
    if (glyph) {
      for (let row = 0; row < FONT_H; row++) {
        const line = glyph[row];
        for (let col = 0; col < 5; col++) {
          if (line[col] === '1') {
            setPixel(rgba, width, height, cx + col, y + row, color, 255);
          }
        }
      }
    }
    cx += FONT_W;
  }
}

function fillRect(
  rgba: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: [number, number, number],
  alpha: number
) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      setPixel(rgba, width, height, xx, yy, color, alpha);
    }
  }
}

/** 绘制带半透明底色的文字标签 */
function drawLabel(
  rgba: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  text: string,
  color: [number, number, number]
) {
  const w = text.length * FONT_W;
  fillRect(rgba, width, height, x - 2, y - 1, w + 4, FONT_H + 2, [16, 16, 16], 200);
  drawText(rgba, width, height, x, y, text, color);
}

/** 渲染等权分时曲线为 PNG（透明背景） */
export function renderChartPng(
  curve: Array<CurvePoint>,
  width = 420,
  height = 170,
  avgCurve?: Array<CurvePoint>,
  volumes?: Map<string, number>
): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  if (!curve.length) {
    return encodePng(width, height, rgba);
  }

  const padding = 8;
  const leftPad = 74; // 左侧留出 MAX/MIN/零轴标注空间
  const chartW = width - leftPad - padding;
  // 底部预留 VOLUME_AREA_H 画分时量柱
  const chartH = height - padding * 2 - VOLUME_AREA_H;
  const midY = padding + chartH / 2;
  const pcts = curve.map((point) => point.pct);
  const avgPcts = avgCurve ? avgCurve.map((point) => point.pct) : [];
  const maxAbs = Math.max(
    ...pcts.map((value) => Math.abs(value)),
    ...avgPcts.map((value) => Math.abs(value)),
    0.5
  );
  const scale = chartH / 2 / maxAbs;
  const lastPct = pcts[pcts.length - 1];
  const dotColor: [number, number, number] = lastPct >= 0 ? COLOR_UP : COLOR_DOWN;

  // 网格线 + 零轴
  const gridColor: [number, number, number] = [255, 255, 255];
  for (let x = 2; x < width - padding; x++) {
    if (x % 2 === 0) {
      setPixel(rgba, width, height, x, Math.round(midY), gridColor, 70);
    }
  }
  const halfY = Math.round(midY - chartH / 4);
  const quarterY = Math.round(midY + chartH / 4);
  for (let x = leftPad; x < width - padding; x++) {
    setPixel(rgba, width, height, x, halfY, gridColor, 25);
    setPixel(rgba, width, height, x, quarterY, gridColor, 25);
  }

  const N = curve.length;
  const toX = (index: number, count = N) =>
    leftPad + (index / Math.max(count - 1, 1)) * chartW;
  const toY = (pct: number) => Math.round(midY - pct * scale);

  if (N === 1) {
    drawDot(rgba, width, height, Math.round(toX(0)), toY(pcts[0]), dotColor);
    return encodePng(width, height, rgba);
  }

  // 均价线（黄，绘制在价格曲线下方）
  if (avgCurve && avgCurve.length >= 2) {
    for (let i = 0; i < avgCurve.length - 1; i++) {
      drawLine(
        rgba,
        width,
        height,
        Math.round(toX(i, avgCurve.length)),
        toY(avgCurve[i].pct),
        Math.round(toX(i + 1, avgCurve.length)),
        toY(avgCurve[i + 1].pct),
        COLOR_AVG,
        2
      );
    }
  }

  // 折线：快速拉升画红、快速下杀画绿、平稳画灰，饱和度体现激烈程度
  for (let i = 0; i < N - 1; i++) {
    const diffPct = pcts[i + 1] - pcts[i];
    const minutes = minuteOf(curve[i + 1].time) - minuteOf(curve[i].time);
    let segmentColor: [number, number, number] = COLOR_GRAY;
    // 时间缺口（如午休）无法衡量分钟级速度，画灰色；否则直接按相邻点变化判定
    if (minutes <= 1) {
      const speed = Math.abs(diffPct);
      if (speed < FAST_MOVE_THRESHOLD) {
        segmentColor = COLOR_GRAY;
      } else {
        const intensity = Math.min(
          1,
          (speed - FAST_MOVE_THRESHOLD) / (FULL_SAT_SPEED - FAST_MOVE_THRESHOLD)
        );
        const base = diffPct > 0 ? COLOR_UP : COLOR_DOWN;
        segmentColor = [
          Math.round(COLOR_GRAY[0] + (base[0] - COLOR_GRAY[0]) * intensity),
          Math.round(COLOR_GRAY[1] + (base[1] - COLOR_GRAY[1]) * intensity),
          Math.round(COLOR_GRAY[2] + (base[2] - COLOR_GRAY[2]) * intensity),
        ];
      }
    }
    drawLine(
      rgba,
      width,
      height,
      Math.round(toX(i)),
      toY(pcts[i]),
      Math.round(toX(i + 1)),
      toY(pcts[i + 1]),
      segmentColor
    );
  }

  // 当前点
  drawDot(rgba, width, height, Math.round(toX(N - 1)), toY(lastPct), dotColor);

  // 最大值 / 最小值 / 零轴标注
  const maxPct = Math.max(...pcts);
  const minPct = Math.min(...pcts);
  const maxLineY = toY(maxPct);
  const minLineY = toY(minPct);
  // 虚线延伸到左侧数字区，与标注对齐
  for (let x = 2; x < width - padding; x++) {
    if (x % 2 === 0) {
      setPixel(rgba, width, height, x, maxLineY, gridColor, 110);
      setPixel(rgba, width, height, x, minLineY, gridColor, 110);
    }
  }
  const textColor: [number, number, number] = [255, 255, 255];
  const formatPct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  // 数字垂直居中于各自横线，避免越界
  const clampY = (y: number) => Math.max(2, Math.min(height - FONT_H - 2, y));
  const labelOffset = Math.floor(FONT_H / 2);
  drawLabel(
    rgba,
    width,
    height,
    4,
    clampY(maxLineY - labelOffset),
    `MAX ${formatPct(maxPct)}`,
    textColor
  );
  drawLabel(
    rgba,
    width,
    height,
    4,
    clampY(minLineY - labelOffset),
    `MIN ${formatPct(minPct)}`,
    textColor
  );
  drawLabel(rgba, width, height, 4, clampY(Math.round(midY) - labelOffset), '0', textColor);

  // 均价线图例 + 信号徽标（右上角）
  const signal = getCurveSignal(curve);
  const legendText = 'AVG';
  const legendColor: [number, number, number] = COLOR_AVG;
  drawLabel(
    rgba,
    width,
    height,
    width - padding - legendText.length * FONT_W - 6,
    padding,
    legendText,
    legendColor
  );
  if (signal) {
    const badgeText = `${signal.level === 'extreme' ? 'SPIKE' : 'FAST'} ${
      signal.direction === 'up' ? 'UP' : 'DOWN'
    }`;
    const badgeColor: [number, number, number] =
      signal.direction === 'up' ? [255, 96, 96] : [70, 190, 96];
    drawLabel(
      rgba,
      width,
      height,
      width - padding - badgeText.length * FONT_W - 6,
      padding + 20,
      badgeText,
      badgeColor
    );
  }
  // 分时量柱状图（底部）：红=该分钟上涨，绿=该分钟下跌
  if (volumes && volumes.size) {
    const volBottom = height - padding;
    const volMax = Math.max(...Array.from(volumes.values()), 1);
    for (let i = 0; i < N; i++) {
      const vol = volumes.get(curve[i].time) || 0;
      if (vol <= 0) {
        continue;
      }
      const barH = Math.max(1, Math.round((vol / volMax) * VOLUME_AREA_H));
      const up = i === 0 ? pcts[i] >= 0 : pcts[i] >= pcts[i - 1];
      const barColor: [number, number, number] = up ? COLOR_UP : COLOR_DOWN;
      const x = Math.round(toX(i));
      for (let dy = 0; dy <= barH; dy++) {
        setPixel(rgba, width, height, x, volBottom - dy, barColor, 200);
        setPixel(rgba, width, height, x + 1, volBottom - dy, barColor, 200);
      }
    }
  }
  return encodePng(width, height, rgba);
}

/** 获取多只股票的分钟记录（自动过滤不支持的市场，含 30 秒缓存） */
export async function getMinuteRecords(codes: Array<string>): Promise<Array<MinuteRecord>> {
  const supported = codes.filter(isMinuteSupported);
  if (!supported.length) {
    return [];
  }
  const map = await fetchMinuteData(supported);
  return supported
    .map((code) => map.get(code))
    .filter((record): record is MinuteRecord => !!record);
}

/** 把分钟记录渲染成等权分时图 data URI（内嵌 base64 PNG） */
export function renderRecordsToUri(records: Array<MinuteRecord>): string | null {
  if (!records.length) {
    return null;
  }
  const curve = buildEqualWeightCurve(records);
  if (curve.length < 2) {
    return null;
  }
  const avgCurve = buildEqualWeightAvgPriceCurve(records);
  const volumes = buildVolumeMap(records);
  const png = renderChartPng(curve, 420, 170, avgCurve, volumes);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * 生成等权分时图的 data URI。
 * VS Code 悬浮提示会拦截本地/非 https 图片链接，data URI 是可行的方案。
 */
export async function buildGroupChartDataUri(codes: Array<string>): Promise<string | null> {
  const records = await getMinuteRecords(codes);
  return renderRecordsToUri(records);
}

/** 获取单只股票的分时图 data URI（带 30 秒渲染缓存） */
export async function getStockChartDataUri(code: string): Promise<string | null> {
  const now = Date.now();
  const cached = renderedUriCache.get(code);
  if (cached && now - cached.time < RENDER_TTL) {
    return cached.uri;
  }
  const records = await getMinuteRecords([code]);
  const uri = renderRecordsToUri(records);
  renderedUriCache.set(code, { time: now, uri });
  return uri;
}

/** 批量给树节点/列表项的 tooltip 追加分时图（渲染图带 30 秒缓存） */
export async function enrichStockTooltips(items: Array<LeekTreeItem>): Promise<void> {
  if (!items || !items.length) {
    return;
  }
  const codes = Array.from(
    new Set(items.map((item) => item.info.code).filter(isMinuteSupported))
  );
  if (!codes.length) {
    return;
  }
  const now = Date.now();
  const needRender = codes.filter((code) => {
    const cached = renderedUriCache.get(code);
    return !cached || now - cached.time >= RENDER_TTL;
  });
  if (needRender.length) {
    const records = await getMinuteRecords(needRender);
    const recordMap = new Map(records.map((record) => [record.code, record]));
    needRender.forEach((code) => {
      const record = recordMap.get(code);
      renderedUriCache.set(code, {
        time: now,
        uri: record ? renderRecordsToUri([record]) : null,
      });
      signalCache.set(code, {
        time: now,
        signal: record ? getCurveSignal(buildEqualWeightCurve([record])) : null,
      });
    });
  }
  items.forEach((item) => {
    if (!isMinuteSupported(item.info.code)) {
      return;
    }
    const cached = renderedUriCache.get(item.info.code);
    if (!cached || !cached.uri) {
      return;
    }
    const current = item.tooltip;
    let base =
      current instanceof MarkdownString ? current.value : String(current || '');
    // 移除旧的信号文字与分时图，避免重复追加
    base = base
      .replace(/\n+(\*\*[^*]+\*\*)?\n+!\[分时图\]\(data:image\/png;base64,[^)]+\)/g, '')
      .trim();
    const signal = signalCache.get(item.info.code)?.signal || null;
    const parts: Array<string> = [base];
    if (signal) {
      parts.push(`**${signalLabel(signal)}**`);
    }
    parts.push(`![分时图](${cached.uri})`);
    item.tooltip = new MarkdownString(parts.join('\n\n'));
  });
}
