const { ipcRenderer } = require('electron');
const axios = require('axios');
const { decode } = require('iconv-lite');
const fs = require('fs');
const path = require('path');

const QUOTE_URL = 'https://qt.gtimg.cn/q=';
const POLL_INTERVAL = 5000; // 行情轮询 5 秒
const SPEED_INTERVAL_MS = 10000; // 涨跌速采样窗口 10 秒
const SURGE_THRESHOLD = 0.5; // %/分钟
const UP_COLOR_CLS = 'up';
const DOWN_COLOR_CLS = 'down';

/** 读 VSCode settings.json（容忍 JSONC 注释） */
function loadLeekConfig() {
  const file = path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const cfg = JSON.parse(stripped);
    return {
      stocks: cfg['leek-fund.stocks'] || [],
      groups: cfg['leek-fund.stockGroups'] || [],
      groupStocks: cfg['leek-fund.stockGroupStocks'] || [],
    };
  } catch (err) {
    console.error('读取 settings.json 失败：', err.message);
    return { stocks: [], groups: [], groupStocks: [] };
  }
}

const cfg = loadLeekConfig();

// 涨跌速采样基准缓存
const speedBase = new Map(); // code -> { price, time }

function formatName(name) {
  if (!name) return '--';
  return name.length > 4 ? name.slice(0, 4) : name;
}

function sign(value) {
  return value >= 0 ? '+' : '';
}

function clsOf(percent) {
  if (percent > 0) return UP_COLOR_CLS;
  if (percent < 0) return DOWN_COLOR_CLS;
  return 'flat';
}

async function fetchQuotes(codes) {
  const resp = await axios.get(QUOTE_URL, {
    responseType: 'arraybuffer',
    params: { q: codes.join(','), fmt: 'json' },
    transformResponse: [(data) => {
      // Electron 的 XHR adapter 返回 ArrayBuffer（无 .length），iconv-lite 解码前需转 Buffer
      const buf = data instanceof ArrayBuffer ? Buffer.from(data) : data;
      return JSON.parse(decode(buf, 'GBK'));
    }],
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
  });
  return codes.map((code) => {
    const arr = resp.data[code.toLowerCase()];
    if (!arr) return null;
    const price = parseFloat(arr[3]);
    const yestclose = parseFloat(arr[4]);
    const percent = yestclose > 0 ? ((price / yestclose - 1) * 100) : 0;
    return {
      code: code.toLowerCase(),
      name: arr[1],
      price,
      percent,
      low: parseFloat(arr[34]),
    };
  }).filter(Boolean);
}

/** 计算 10s 涨跌速（%/分钟，归一化） */
function calcSpeed(code, price, now) {
  const base = speedBase.get(code);
  speedBase.set(code, { price, time: now });
  if (!base) return 0;
  const elapsed = (now - base.time) / 1000;
  if (elapsed < 8 || elapsed > 60) return 0;
  const diffPct = (price / base.price - 1) * 100;
  return (diffPct * 60) / elapsed;
}

function render(quotes) {
  const upEl = document.getElementById('upName');
  const upValEl = document.getElementById('upVal');
  const downEl = document.getElementById('downName');
  const downValEl = document.getElementById('downVal');
  const listEl = document.getElementById('list');

  // 涨跌速榜：取涨速最快 / 跌速最快（恒常显示）
  const withSpeed = quotes.map((q) => ({ ...q, speed: calcSpeed(q.code, q.price, Date.now()) }));
  const upBest = withSpeed.slice().sort((a, b) => b.speed - a.speed)[0];
  const downBest = withSpeed.slice().sort((a, b) => a.speed - b.speed)[0];
  if (upBest) {
    upEl.textContent = formatName(upBest.name);
    upValEl.textContent = `${sign(upBest.speed)}${Number(upBest.speed.toFixed(1))}%`;
  }
  if (downBest) {
    downEl.textContent = formatName(downBest.name);
    downValEl.textContent = `${sign(downBest.speed)}${Number(downBest.speed.toFixed(1))}%`;
  }

  // 个股列表（按分组）
  const grouped = new Set();
  let html = '';
  cfg.groups.forEach((gname, gi) => {
    const codes = cfg.groupStocks[gi] || [];
    const members = quotes.filter((q) => codes.includes(q.code));
    if (!members.length) return;
    members.forEach((m) => grouped.add(m.code));
    const avg = members.reduce((s, m) => s + m.percent, 0) / members.length;
    html += `<div class="group-row"><span class="gname">${gname}(${members.length})</span><span class="gavg ${clsOf(avg)}">${sign(avg)}${avg.toFixed(2)}%</span></div>`;
    html += members
      .map(
        (m) =>
          `<div class="stock-row" title="${m.name}"><span class="sname">${formatName(m.name)}</span><span class="sprice flat">${m.price.toFixed(2)}</span><span class="spct ${clsOf(m.percent)}">${sign(m.percent)}${m.percent.toFixed(2)}%</span></div>`
      )
      .join('');
  });
  // 未分组个股
  const rest = quotes.filter((q) => !grouped.has(q.code));
  if (rest.length) {
    html += `<div class="group-row"><span class="gname">全部(${rest.length})</span><span class="gavg"></span></div>`;
    html += rest
      .map(
        (m) =>
          `<div class="stock-row" title="${m.name}"><span class="sname">${formatName(m.name)}</span><span class="sprice flat">${m.price.toFixed(2)}</span><span class="spct ${clsOf(m.percent)}">${sign(m.percent)}${m.percent.toFixed(2)}%</span></div>`
      )
      .join('');
  }
  if (!quotes.length) {
    html = `<div class="group-row">无自选股（请在 VSCode settings.json 配置 leek-fund.stocks）</div>`;
  }
  listEl.innerHTML = html;

  const d = new Date();
  const pad = (n) => (n < 10 ? `0${n}` : n);
  document.getElementById('updated').textContent = `更新 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function tick() {
  const codes = [...new Set([...cfg.stocks, ...cfg.groupStocks.flat()])];
  if (!codes.length) {
    render([]);
    return;
  }
  try {
    const quotes = await fetchQuotes(codes);
    render(quotes);
  } catch (err) {
    console.error('行情拉取失败：', err.message);
  }
}

// 事件
document.getElementById('btnClose').addEventListener('click', () => ipcRenderer.send('win-close'));
document.getElementById('btnMin').addEventListener('click', () => ipcRenderer.send('win-hide'));

// 滚轮：列表内滚动（不调透明度），其余区域调透明度
let opacity = 0.92;
document.addEventListener('wheel', (e) => {
  const listEl = document.getElementById('list');
  const overList = e.target instanceof Element && e.target.closest('#list');
  if (overList && listEl.scrollHeight > listEl.clientHeight) return;
  opacity += e.deltaY > 0 ? -0.05 : 0.05;
  opacity = Math.max(0.15, Math.min(1, opacity));
  ipcRenderer.send('win-opacity', opacity);
});

tick();
setInterval(tick, POLL_INTERVAL);
