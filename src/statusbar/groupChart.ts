import axios from 'axios';
import * as zlib from 'zlib';
import { MarkdownString } from 'vscode';
import { LeekTreeItem } from '../shared/leekTreeItem';

const MINUTE_QUERY = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=';
const CACHE_TTL = 30000; // 分钟数据缓存 30 秒
const RENDER_TTL = 30000; // 渲染图缓存 30 秒
const FETCH_CONCURRENCY = 6; // 分钟数据请求并发数

export interface MinuteRecord {
  code: string;
  prevClose: number;
  points: Array<{ time: string; price: number }>;
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
  const points: Array<{ time: string; price: number }> = [];
  list.forEach((line) => {
    const parts = String(line).split(/\s+/);
    if (parts.length >= 2) {
      const price = parseFloat(parts[1]);
      if (!isNaN(price)) {
        points.push({ time: parts[0], price });
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
  color: [number, number, number]
) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    setPixel(rgba, width, height, x, y, color, 255);
    setPixel(rgba, width, height, x, y + 1, color, 255);
    setPixel(rgba, width, height, x, y - 1, color, 255);
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
export function renderChartPng(curve: Array<CurvePoint>, width = 420, height = 170): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  if (!curve.length) {
    return encodePng(width, height, rgba);
  }

  const padding = 8;
  const leftPad = 74; // 左侧留出 MAX/MIN/零轴标注空间
  const chartW = width - leftPad - padding;
  const chartH = height - padding * 2;
  const midY = padding + chartH / 2;
  const pcts = curve.map((point) => point.pct);
  const maxAbs = Math.max(...pcts.map((value) => Math.abs(value)), 0.5);
  const scale = chartH / 2 / maxAbs;
  const lastPct = pcts[pcts.length - 1];
  const color: [number, number, number] = lastPct >= 0 ? [240, 82, 82] : [64, 175, 84];

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
  const toX = (index: number) => leftPad + (index / Math.max(N - 1, 1)) * chartW;
  const toY = (pct: number) => Math.round(midY - pct * scale);

  if (N === 1) {
    drawDot(rgba, width, height, Math.round(toX(0)), toY(pcts[0]), color);
    return encodePng(width, height, rgba);
  }

  // 折线
  for (let i = 0; i < N - 1; i++) {
    drawLine(
      rgba,
      width,
      height,
      Math.round(toX(i)),
      toY(pcts[i]),
      Math.round(toX(i + 1)),
      toY(pcts[i + 1]),
      color
    );
  }

  // 当前点
  drawDot(rgba, width, height, Math.round(toX(N - 1)), toY(lastPct), color);

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
  const png = renderChartPng(curve);
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
    // 移除旧的分时图，避免重复追加
    base = base.replace(/\n+!\[分时图\]\(data:image\/png;base64,[^)]+\)/g, '').trim();
    item.tooltip = new MarkdownString(`${base}\n\n![分时图](${cached.uri})`);
  });
}
