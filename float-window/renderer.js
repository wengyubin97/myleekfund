const { ipcRenderer } = require('electron');
const axios = require('axios');
const { decode } = require('iconv-lite');
const fs = require('fs');
const path = require('path');

const QUOTE_URL = 'https://qt.gtimg.cn/q=';
const POLL_INTERVAL = 5000; // 行情轮询 5 秒
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

// 界面状态（折叠分组/排序开关），localStorage 持久化
const uiState = loadUIState();
function loadUIState() {
  try {
    const s = JSON.parse(localStorage.getItem('leekFloatUi') || '{}');
    return {
      collapsed: s.collapsed || {},
      groupSort: !!s.groupSort,
      stockSort: !!s.stockSort,
    };
  } catch (err) {
    console.error('读取界面状态失败：', err.message);
    return { collapsed: {}, groupSort: false, stockSort: false };
  }
}
function saveUIState() {
  try {
    localStorage.setItem('leekFloatUi', JSON.stringify(uiState));
  } catch (err) {
    console.error('保存界面状态失败：', err.message);
  }
}

// 涨跌速采样基准缓存
let lastQuotes = null; // 最近一次行情，供折叠/排序触发重渲染
let currentGroups = []; // 最近一次渲染的分组列表（data-idx 索引用）

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
    };
  }).filter(Boolean);
}

function render(quotes) {
  const listEl = document.getElementById('list');

  lastQuotes = quotes;

  // 个股列表（按分组；支持折叠与排序）
  const grouped = new Set();
  let html = '';
  let groups = cfg.groups.map((gname, gi) => ({
    name: gname,
    members: quotes.filter((q) => (cfg.groupStocks[gi] || []).includes(q.code)),
  }));
  groups = groups.filter((g) => g.members.length);
  groups.forEach((g) => g.members.forEach((m) => grouped.add(m.code)));
  if (uiState.groupSort) {
    const avgOf = (g) => g.members.reduce((s, m) => s + m.percent, 0) / g.members.length;
    groups.sort((a, b) => avgOf(b) - avgOf(a));
  }
  if (uiState.stockSort) {
    groups.forEach((g) => g.members.sort((a, b) => b.percent - a.percent));
  }
  currentGroups = groups;
  groups.forEach((g, i) => {
    const avg = g.members.reduce((s, m) => s + m.percent, 0) / g.members.length;
    const collapsed = !!uiState.collapsed[g.name];
    html += `<div class="group-row group-header" data-idx="${i}"><span class="gmarker">${collapsed ? '▸' : '▾'}</span><span class="gname">${g.name}(${g.members.length})</span><span class="gavg ${clsOf(avg)}">${sign(avg)}${avg.toFixed(2)}%</span></div>`;
    if (!collapsed) {
      html += g.members
        .map(
          (m) =>
            `<div class="stock-row" title="${m.name}"><span class="sname">${formatName(m.name)}</span><span class="sprice flat">${m.price.toFixed(2)}</span><span class="spct ${clsOf(m.percent)}">${sign(m.percent)}${m.percent.toFixed(2)}%</span></div>`
        )
        .join('');
    }
  });
  // 未分组个股（恒在底部，不参与分组排序）
  const rest = quotes.filter((q) => !grouped.has(q.code));
  if (rest.length) {
    const collapsed = !!uiState.collapsed['__rest__'];
    html += `<div class="group-row group-header" data-idx="${groups.length}"><span class="gmarker">${collapsed ? '▸' : '▾'}</span><span class="gname">全部(${rest.length})</span><span class="gavg"></span></div>`;
    if (!collapsed) {
      const restSorted = uiState.stockSort ? rest.slice().sort((a, b) => b.percent - a.percent) : rest;
      html += restSorted
        .map(
          (m) =>
            `<div class="stock-row" title="${m.name}"><span class="sname">${formatName(m.name)}</span><span class="sprice flat">${m.price.toFixed(2)}</span><span class="spct ${clsOf(m.percent)}">${sign(m.percent)}${m.percent.toFixed(2)}%</span></div>`
        )
        .join('');
    }
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

// 分组标题点击：折叠/展开
document.getElementById('list').addEventListener('click', (e) => {
  const row = e.target.closest('.group-header');
  if (!row) return;
  const idx = Number(row.dataset.idx);
  const key = idx >= currentGroups.length ? '__rest__' : currentGroups[idx].name;
  uiState.collapsed[key] = !uiState.collapsed[key];
  saveUIState();
  if (lastQuotes) render(lastQuotes);
});

// 排序开关：分组（平均涨跌幅）/个股（涨跌幅），默认顺序 ↔ 降序
const btnGroupSort = document.getElementById('btnGroupSort');
const btnStockSort = document.getElementById('btnStockSort');
function syncSortButtons() {
  btnGroupSort.classList.toggle('active', uiState.groupSort);
  btnStockSort.classList.toggle('active', uiState.stockSort);
}
function toggleSort(key) {
  uiState[key] = !uiState[key];
  saveUIState();
  syncSortButtons();
  if (lastQuotes) render(lastQuotes);
}
btnGroupSort.addEventListener('click', () => toggleSort('groupSort'));
btnStockSort.addEventListener('click', () => toggleSort('stockSort'));
syncSortButtons();

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
