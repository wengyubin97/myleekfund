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
      pinned: s.pinned || [],
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
  // 置顶分组恒在首位（按置顶顺序），其余分组可排序
  const pinned = groups.filter((g) => uiState.pinned.includes(g.name));
  const nonPinned = groups.filter((g) => !uiState.pinned.includes(g.name));
  if (uiState.groupSort) {
    const avgOf = (g) => g.members.reduce((s, m) => s + m.percent, 0) / g.members.length;
    nonPinned.sort((a, b) => avgOf(b) - avgOf(a));
  }
  groups = [...pinned, ...nonPinned];
  if (uiState.stockSort) {
    groups.forEach((g) => g.members.sort((a, b) => b.percent - a.percent));
  }
  currentGroups = groups;
  groups.forEach((g, i) => {
    const avg = g.members.reduce((s, m) => s + m.percent, 0) / g.members.length;
    const collapsed = !!uiState.collapsed[g.name];
    html += `<div class="group-row group-header" data-idx="${i}" data-name="${g.name}"><span class="gmarker">${collapsed ? '▸' : '▾'}</span><span class="gname">${g.name}(${g.members.length})</span><span class="gavg ${clsOf(avg)}">${sign(avg)}${avg.toFixed(2)}%</span><span class="pin ${uiState.pinned.includes(g.name) ? 'pinned' : ''}" title="置顶/取消置顶">📌</span><span class="del" title="删除分组">×</span></div>`;
    if (!collapsed) {
      html += g.members
        .map(
          (m) =>
            `<div class="stock-row" title="${m.name}" data-code="${m.code}" data-name="${m.name}" data-group="${g.name}"><span class="sname">${formatName(m.name)}</span><span class="sprice flat">${m.price.toFixed(2)}</span><span class="spct ${clsOf(m.percent)}">${sign(m.percent)}${m.percent.toFixed(2)}%</span><span class="del" title="从分组移除">×</span></div>`
        )
        .join('');
      html += `<div class="add-stock-row" data-name="${g.name}">➕ 添加股票到此分组</div>`;
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
            `<div class="stock-row" title="${m.name}" data-code="${m.code}" data-name="${m.name}"><span class="sname">${formatName(m.name)}</span><span class="sprice flat">${m.price.toFixed(2)}</span><span class="spct ${clsOf(m.percent)}">${sign(m.percent)}${m.percent.toFixed(2)}%</span><span class="del" title="删除股票">×</span></div>`
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

// 列表点击：组内「添加股票到此分组」/ 置顶 / × 删除（确认条）/ 分组标题折叠
document.getElementById('list').addEventListener('click', (e) => {
  const addRow = e.target.closest('.add-stock-row');
  if (addRow) {
    const name = addRow.dataset.name;
    if (name) openAddPanel('addToGroup', `搜索添加到「${name}」`, name);
    return;
  }
  const pinBtn = e.target.closest('.pin');
  if (pinBtn) {
    const groupRow = pinBtn.closest('.group-header');
    if (groupRow && groupRow.dataset.name) {
      const name = groupRow.dataset.name;
      const i = uiState.pinned.indexOf(name);
      if (i >= 0) uiState.pinned.splice(i, 1);
      else uiState.pinned.push(name);
      saveUIState();
      if (lastQuotes) render(lastQuotes);
    }
    return;
  }
  const del = e.target.closest('.del');
  if (del) {
    const stockRow = del.closest('.stock-row');
    if (stockRow) {
      const group = stockRow.dataset.group;
      if (group) {
        showConfirm('stock-in-group', stockRow.dataset.code, stockRow.dataset.name, group);
      } else {
        showConfirm('stock', stockRow.dataset.code, stockRow.dataset.name);
      }
      return;
    }
    const groupRow = del.closest('.group-header');
    if (groupRow && groupRow.dataset.name) {
      showConfirm('group', null, groupRow.dataset.name);
      return;
    }
    return;
  }
  const stockRow = e.target.closest('.stock-row');
  if (stockRow) {
    openChart(stockRow.dataset.code, stockRow.dataset.name);
    return;
  }
  const row = e.target.closest('.group-header');
  if (!row) return;
  const idx = Number(row.dataset.idx);
  const key = idx >= currentGroups.length ? '__rest__' : currentGroups[idx].name;
  uiState.collapsed[key] = !uiState.collapsed[key];
  saveUIState();
  if (lastQuotes) render(lastQuotes);
});

// 删除确认条
const confirmBar = document.getElementById('confirmBar');
const confirmText = document.getElementById('confirmText');
let pendingDelete = null; // { type: 'stock'|'stock-in-group'|'group', code?, name?, group? }
function showConfirm(type, code, name, group) {
  pendingDelete = { type, code, name, group };
  if (type === 'group') {
    confirmText.textContent = `删除分组「${name}」？（组内不再属于其他组的股票将一并删除）`;
  } else if (type === 'stock-in-group') {
    confirmText.textContent = `从「${group}」移除 ${name}（${code}）？`;
  } else {
    confirmText.textContent = `删除 ${name}（${code}）？`;
  }
  confirmBar.style.display = 'flex';
}
function hideConfirm() {
  pendingDelete = null;
  confirmBar.style.display = 'none';
}
document.getElementById('confirmYes').addEventListener('click', () => {
  const p = pendingDelete;
  if (!p) return;
  hideConfirm();
  if (p.type === 'stock') {
    deleteStock(p.code);
  } else if (p.type === 'stock-in-group') {
    removeStockFromGroup(p.code, p.group);
  } else {
    deleteGroup(p.name);
  }
});
document.getElementById('confirmNo').addEventListener('click', hideConfirm);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (chartCode) {
      closeChart();
    } else {
      hideConfirm();
    }
  }
});

function deleteStock(code) {
  writeLeekConfig((obj) => {
    obj['leek-fund.stocks'] = (obj['leek-fund.stocks'] || []).filter((c) => c !== code);
    obj['leek-fund.stockGroupStocks'] = (obj['leek-fund.stockGroupStocks'] || []).map((arr) =>
      (arr || []).filter((c) => c !== code)
    );
  }).then(() => tick());
}

function removeStockFromGroup(code, groupName) {
  writeLeekConfig((obj) => {
    const groups = obj['leek-fund.stockGroups'] || [];
    const gi = groups.indexOf(groupName);
    if (gi < 0) return;
    const arrs = obj['leek-fund.stockGroupStocks'] || [];
    arrs[gi] = (arrs[gi] || []).filter((c) => c !== code);
  }).then(() => tick());
}

function deleteGroup(name) {
  writeLeekConfig((obj) => {
    const groups = obj['leek-fund.stockGroups'] || [];
    const gi = groups.indexOf(name);
    if (gi < 0) return;
    const arrs = obj['leek-fund.stockGroupStocks'] || [];
    const codes = arrs[gi] || [];
    const inOtherGroups = new Set();
    arrs.forEach((arr, i) => {
      if (i !== gi) (arr || []).forEach((c) => inOtherGroups.add(c));
    });
    codes.forEach((c) => {
      if (!inOtherGroups.has(c)) {
        obj['leek-fund.stocks'] = (obj['leek-fund.stocks'] || []).filter((s) => s !== c);
      }
    });
    groups.splice(gi, 1);
    arrs.splice(gi, 1);
    delete uiState.collapsed[name];
    saveUIState();
  }).then(() => tick());
}

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

// 透明度：底部滑杆（滚轮不再参与，列表内滚轮为原生滚动）
document.getElementById('opacitySlider').addEventListener('input', (e) => {
  ipcRenderer.send('win-opacity', Number(e.target.value) / 100);
});

// 滚轮：K线图视图下缩放时间周期（上滚放大/下滚缩小，始终显示最新 N 根）
document.addEventListener('wheel', (e) => {
  if (!chartCode || chartMode === 'minute') return;
  const delta = e.deltaY > 0 ? 10 : -10;
  klineCount = Math.min(klineMax, Math.max(10, klineCount + delta));
  drawChart();
}, { passive: true });

// ---- settings.json 增删改（只动 leek-fund 键，串行队列防并发写） ----
function settingsPath() {
  return path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json');
}
function readSettingsObj() {
  const raw = fs.readFileSync(settingsPath(), 'utf8');
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return JSON.parse(stripped);
}
let writeQueue = Promise.resolve();
function writeLeekConfig(mutator) {
  writeQueue = writeQueue.then(() => {
    const obj = readSettingsObj();
    mutator(obj);
    fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2), 'utf8');
    cfg.stocks = obj['leek-fund.stocks'] || [];
    cfg.groups = obj['leek-fund.stockGroups'] || [];
    cfg.groupStocks = obj['leek-fund.stockGroupStocks'] || [];
  });
  return writeQueue;
}

// ---- 添加面板（添加股票/添加分组共用输入行） ----
const addPanel = document.getElementById('addPanel');
const addInput = document.getElementById('addInput');
const addResults = document.getElementById('addResults');
let addMode = 'stock'; // 'stock' | 'group' | 'addToGroup'
let addTargetGroup = null; // addToGroup 模式的目标分组
let searchTimer = null;

function openAddPanel(mode, placeholder, targetGroup) {
  addMode = mode;
  addTargetGroup = targetGroup || null;
  addInput.placeholder = placeholder;
  addInput.value = '';
  addResults.innerHTML = '';
  addPanel.style.display = 'block';
  addInput.focus();
}
function closeAddPanel() {
  addPanel.style.display = 'none';
  addInput.value = '';
  addResults.innerHTML = '';
}

const SEARCH_URL = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get';
const ALLOWED_MARKETS = new Set(['sh', 'sz', 'bj', 'hk']);
async function searchStocks(keyword) {
  const resp = await axios.get(SEARCH_URL, { params: { q: keyword }, timeout: 5000 });
  return (resp.data && resp.data.data && resp.data.data.stock || [])
    .map((a) => ({
      // smartbox 的 a[1] 是裸代码（如 601288），必须拼上市场前缀（如 sh601288）才能用于行情接口
      code: String(a[0]).toLowerCase() + String(a[1]).toLowerCase(),
      name: a[2],
      market: String(a[0]).toLowerCase(),
    }))
    .filter((s) => ALLOWED_MARKETS.has(s.market));
}

function renderSearchResults(items) {
  if (!items.length) {
    addResults.innerHTML = '<div class="add-hint">无匹配结果</div>';
    return;
  }
  addResults.innerHTML = items
    .map(
      (s) =>
        `<div class="add-result" data-code="${s.code}"><span>${s.name}</span><span class="rcode">${s.code}</span></div>`
    )
    .join('');
}

addInput.addEventListener('input', () => {
  if (addMode === 'group') return;
  const keyword = addInput.value.trim();
  clearTimeout(searchTimer);
  if (!keyword) {
    addResults.innerHTML = '';
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const items = await searchStocks(keyword);
      renderSearchResults(items.slice(0, 8));
    } catch (err) {
      addResults.innerHTML = '<div class="add-hint">搜索失败</div>';
    }
  }, 300);
});

addInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAddPanel();
  } else if (e.key === 'Enter' && addMode === 'group') {
    const name = addInput.value.trim();
    if (!name) return;
    writeLeekConfig((obj) => {
      const groups = obj['leek-fund.stockGroups'] || [];
      if (!groups.includes(name)) {
        groups.push(name);
        obj['leek-fund.stockGroups'] = groups;
        const arrs = obj['leek-fund.stockGroupStocks'] || [];
        arrs.push([]);
        obj['leek-fund.stockGroupStocks'] = arrs;
      }
    }).then(() => {
      closeAddPanel();
      tick();
    });
  }
});

addResults.addEventListener('click', (e) => {
  const item = e.target.closest('.add-result');
  if (!item || !item.dataset.code) return;
  const code = item.dataset.code;
  if (addMode === 'addToGroup') {
    const groupName = addTargetGroup;
    writeLeekConfig((obj) => {
      const groups = obj['leek-fund.stockGroups'] || [];
      const gi = groups.indexOf(groupName);
      if (gi < 0) return;
      const arrs = obj['leek-fund.stockGroupStocks'] || [];
      const arr = arrs[gi] || [];
      if (!arr.includes(code)) {
        arrs[gi] = [...arr, code];
        obj['leek-fund.stockGroupStocks'] = arrs;
      }
      const stocks = obj['leek-fund.stocks'] || [];
      if (!stocks.includes(code)) {
        stocks.push(code);
        obj['leek-fund.stocks'] = stocks;
      }
    }).then(() => {
      closeAddPanel();
      tick();
    });
    return;
  }
  writeLeekConfig((obj) => {
    const stocks = obj['leek-fund.stocks'] || [];
    if (!stocks.includes(code)) {
      stocks.push(code);
      obj['leek-fund.stocks'] = stocks;
    }
  }).then(() => {
    closeAddPanel();
    tick();
  });
});

// ---- 标题栏按钮：添加股票 / 添加分组 ----
document.getElementById('btnAddStock').addEventListener('click', () => openAddPanel('stock', '输入股票名称/代码搜索'));
document.getElementById('btnAddGroup').addEventListener('click', () => openAddPanel('group', '输入分组名称，回车创建'));

// ---- 图表视图（分时/日K/周K/月K） ----
const chartView = document.getElementById('chartView');
const chartCanvas = document.getElementById('chartCanvas');
const chartTitleEl = document.getElementById('chartTitle');
const chartLegendEl = document.getElementById('chartLegend');
let chartCode = null;
let chartName = '';
let chartMode = 'minute';
let klineCount = 220; // K线默认显示根数（最新 N 根）
let klineMax = 220; // 当前数据最大根数
const chartCache = new Map(); // `${code}:${mode}` -> { time, data }

const MINUTE_QUERY = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=';
const KLINE_QUERY = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=';
const CHART_CACHE_TTL = 30000;
const C_UP = '#ff8a87';
const C_DOWN = '#7fd6a4';
const C_AVG = '#f0c828';
const C_GRID = 'rgba(255,255,255,0.10)';
const C_TEXT = '#b8b8b8';
const C_MA5 = '#ffd166';
const C_MA10 = '#6fb1ff';
const C_MA20 = '#c88fff';

async function fetchChartData(code, mode) {
  const key = `${code}:${mode}`;
  const cached = chartCache.get(key);
  if (cached && Date.now() - cached.time < CHART_CACHE_TTL) {
    return cached.data;
  }
  let data = null;
  if (mode === 'minute') {
    const resp = await axios.get(MINUTE_QUERY + code, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
    });
    const stock = resp.data && resp.data.data && resp.data.data[code];
    const list = (stock && stock.data && stock.data.data) || [];
    const qt = (stock && stock.qt && stock.qt[code]) || [];
    const prevClose = parseFloat(qt[4]);
    const points = [];
    list.forEach((line) => {
      const parts = String(line).split(/\s+/);
      if (parts.length >= 2) {
        const price = parseFloat(parts[1]);
        if (!isNaN(price)) {
          points.push({
            time: parts[0],
            price,
            volume: parseFloat(parts[2]) || 0,
            amount: parseFloat(parts[3]) || 0,
          });
        }
      }
    });
    data = { prevClose, points };
  } else {
    const resp = await axios.get(`${KLINE_QUERY}${code},${mode},,,320,qfq`, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
    });
    const stock = resp.data && resp.data.data && resp.data.data[code];
    const rows = (stock && (stock[`qfq${mode}`] || stock[mode])) || [];
    data = rows
      .map((r) => ({
        date: r[0],
        open: parseFloat(r[1]),
        close: parseFloat(r[2]),
        high: parseFloat(r[3]),
        low: parseFloat(r[4]),
        volume: parseFloat(r[5]) || 0,
      }))
      .filter((k) => !isNaN(k.close) && k.close > 0);
  }
  chartCache.set(key, { time: Date.now(), data });
  return data;
}

function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = chartCanvas.getBoundingClientRect();
  chartCanvas.width = Math.max(1, Math.round(rect.width * dpr));
  chartCanvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = chartCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.font = '10px "Microsoft YaHei", sans-serif';
  return { ctx, w: rect.width, h: rect.height };
}

/** 分时均价线系数：腾讯分钟成交额/量为累计值，均价=累计额/累计量（A股量单位为手需除100） */
function calcLotFactor(points) {
  const last = points[points.length - 1];
  if (!last || !last.volume || !last.amount) return 0;
  const raw = last.amount / last.volume;
  if (Math.abs(raw / last.price - 1) <= 0.3) return 1;
  if (Math.abs(raw / 100 / last.price - 1) <= 0.3) return 100;
  return 0;
}

function drawMinute(ctx, w, h, data) {
  const { prevClose, points } = data;
  const padL = 10;
  const padR = 10;
  const padT = 10;
  const volH = Math.round(h * 0.18);
  const chartH = h - padT - volH - 22;
  const midY = padT + chartH / 2;
  const pcts = points.map((p) => (p.price / prevClose - 1) * 100);
  const maxAbs = Math.max(...pcts.map((v) => Math.abs(v)), 0.5);
  const scale = chartH / 2 / maxAbs;
  const toX = (i) => padL + (i / Math.max(points.length - 1, 1)) * (w - padL - padR);
  const toY = (pct) => midY - pct * scale;

  ctx.strokeStyle = C_GRID;
  ctx.lineWidth = 1;
  [midY, midY - chartH / 4, midY + chartH / 4].forEach((y) => {
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  });

  // 均价线（黄色）
  const lotFactor = calcLotFactor(points);
  if (lotFactor) {
    ctx.strokeStyle = C_AVG;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    points.forEach((p, i) => {
      if (!p.volume || !p.amount) return;
      const avgPct = (p.amount / p.volume / lotFactor / prevClose - 1) * 100;
      if (!started) {
        ctx.moveTo(toX(i), toY(avgPct));
        started = true;
      } else {
        ctx.lineTo(toX(i), toY(avgPct));
      }
    });
    ctx.stroke();
  }

  // 价格折线（按段涨跌着色）
  ctx.lineWidth = 1.4;
  for (let i = 0; i < points.length - 1; i++) {
    ctx.strokeStyle = pcts[i + 1] >= pcts[i] ? C_UP : C_DOWN;
    ctx.beginPath();
    ctx.moveTo(toX(i), toY(pcts[i]));
    ctx.lineTo(toX(i + 1), toY(pcts[i + 1]));
    ctx.stroke();
  }
  const lastPct = pcts[pcts.length - 1];
  ctx.fillStyle = lastPct >= 0 ? C_UP : C_DOWN;
  ctx.beginPath();
  ctx.arc(toX(points.length - 1), toY(lastPct), 2.2, 0, Math.PI * 2);
  ctx.fill();

  // 左侧标注 MAX/MIN/0
  ctx.fillStyle = C_TEXT;
  const maxPct = Math.max(...pcts);
  const minPct = Math.min(...pcts);
  ctx.fillText(`MAX ${maxPct >= 0 ? '+' : ''}${maxPct.toFixed(2)}%`, padL, Math.max(8, toY(maxPct) - 4));
  ctx.fillText(`MIN ${minPct >= 0 ? '+' : ''}${minPct.toFixed(2)}%`, padL, Math.min(h - volH - 12, toY(minPct) + 10));
  ctx.fillText('0', padL, Math.min(h - volH - 12, midY + 10));

  // 分时量柱（差分，红涨绿跌）
  const volBase = h - 18;
  const vols = [];
  let prev = 0;
  points.forEach((p) => {
    const v = p.volume - prev;
    prev = p.volume;
    vols.push(Math.max(v, 0));
  });
  const volMax = Math.max(...vols, 1);
  points.forEach((p, i) => {
    if (vols[i] <= 0) return;
    const barH = Math.max(1, (vols[i] / volMax) * volH);
    ctx.fillStyle = i === 0 ? (pcts[i] >= 0 ? C_UP : C_DOWN) : (pcts[i] >= pcts[i - 1] ? C_UP : C_DOWN);
    ctx.globalAlpha = 0.75;
    ctx.fillRect(toX(i) - 0.5, volBase - barH, 2, barH);
    ctx.globalAlpha = 1;
  });

  // 时间轴：首/中/末
  ctx.fillStyle = C_TEXT;
  const mid = Math.floor(points.length / 2);
  [0, mid, points.length - 1].forEach((i) => {
    const t = points[i].time;
    ctx.fillText(`${t.slice(0, 2)}:${t.slice(2, 4)}`, toX(i) - 12, h - 6);
  });

  chartLegendEl.textContent = `昨收 ${prevClose}  现价 ${points[points.length - 1].price.toFixed(2)}  ${lastPct >= 0 ? '+' : ''}${lastPct.toFixed(2)}%`;
}

function drawKline(ctx, w, h, bars, mode, total) {
  const padL = 10;
  const padR = 10;
  const padT = 10;
  const volH = Math.round(h * 0.16);
  const chartH = h - padT - volH - 24;
  const n = bars.length;
  const bw = (w - padL - padR) / n;
  const maxP = Math.max(...bars.map((b) => b.high));
  const minP = Math.min(...bars.map((b) => b.low));
  const toX = (i) => padL + (i + 0.5) * bw;
  const toY = (p) => padT + (1 - (p - minP) / Math.max(maxP - minP, 1e-9)) * chartH;

  ctx.strokeStyle = C_GRID;
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = padT + (g / 4) * chartH;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  // MA5/10/20
  const ma = (len) =>
    bars.map((_, i) => {
      const s = bars.slice(Math.max(0, i - len + 1), i + 1);
      return s.reduce((a, b) => a + b.close, 0) / s.length;
    });
  [[ma(5), C_MA5], [ma(10), C_MA10], [ma(20), C_MA20]].forEach(([line, color]) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    line.forEach((v, i) => {
      if (!isNaN(v)) {
        if (!started) {
          ctx.moveTo(toX(i), toY(v));
          started = true;
        } else {
          ctx.lineTo(toX(i), toY(v));
        }
      }
    });
    ctx.stroke();
  });

  // K线实体 + 影线
  bars.forEach((b, i) => {
    const x = toX(i);
    const up = b.close >= b.open;
    const color = up ? C_UP : C_DOWN;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, toY(b.high));
    ctx.lineTo(x, toY(b.low));
    ctx.stroke();
    const yO = toY(b.open);
    const yC = toY(b.close);
    ctx.fillStyle = color;
    ctx.fillRect(x - Math.max(bw * 0.32, 1), Math.min(yO, yC), Math.max(bw * 0.64, 2), Math.max(Math.abs(yC - yO), 1));
  });

  // 成交量（红涨绿跌）
  const vMax = Math.max(...bars.map((b) => b.volume), 1);
  const volBase = h - 18;
  bars.forEach((b, i) => {
    const barH = Math.max(1, (b.volume / vMax) * volH);
    ctx.fillStyle = b.close >= b.open ? C_UP : C_DOWN;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(toX(i) - Math.max(bw * 0.32, 1), volBase - barH, Math.max(bw * 0.64, 2), barH);
    ctx.globalAlpha = 1;
  });

  // 时间轴：均匀取 5 个日期
  ctx.fillStyle = C_TEXT;
  [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1].forEach((i) => {
    ctx.fillText(bars[i].date.slice(2), toX(i) - 12, h - 6);
  });

  // 图例：最新一根 OHLC + 显示根数
  const last = bars[n - 1];
  const pct = (last.close / bars[n - 2].close - 1) * 100;
  chartLegendEl.textContent = `显示 ${bars.length}/${total} 根 · 开 ${last.open.toFixed(2)} 高 ${last.high.toFixed(2)} 低 ${last.low.toFixed(2)} 收 ${last.close.toFixed(2)}  ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

async function drawChart() {
  const code = chartCode;
  const mode = chartMode;
  if (!code) return;
  let data;
  try {
    data = await fetchChartData(code, mode);
  } catch (err) {
    console.error('图表数据拉取失败：', err.message);
    const { ctx, w } = setupCanvas();
    ctx.fillStyle = C_TEXT;
    ctx.fillText('数据拉取失败', 10, 20);
    return;
  }
  if (chartCode !== code || chartMode !== mode) return;
  const { ctx, w, h } = setupCanvas();
  if (!data || (mode === 'minute' && (!data.points || !data.points.length)) || (mode !== 'minute' && !data.length)) {
    ctx.fillStyle = C_TEXT;
    ctx.fillText('暂无数据', 10, 20);
    return;
  }
  if (mode === 'minute') {
    drawMinute(ctx, w, h, data);
  } else {
    klineMax = data.length;
    if (klineCount > klineMax) klineCount = klineMax;
    drawKline(ctx, w, h, data.slice(-klineCount), mode, data.length);
  }
}

function syncChartTabs() {
  document.querySelectorAll('.chart-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.mode === chartMode);
  });
}

function openChart(code, name) {
  chartCode = code;
  chartName = name;
  chartTitleEl.textContent = `${name} ${code}`;
  chartMode = 'minute';
  syncChartTabs();
  document.getElementById('addPanel').style.display = 'none';
  document.getElementById('confirmBar').style.display = 'none';
  document.getElementById('list').style.display = 'none';
  chartView.classList.add('show');
  drawChart();
}

function closeChart() {
  chartView.classList.remove('show');
  document.getElementById('list').style.display = '';
  chartCode = null;
  if (lastQuotes) render(lastQuotes);
}

document.getElementById('chartBack').addEventListener('click', closeChart);
document.querySelectorAll('.chart-tab').forEach((t) => {
  t.addEventListener('click', () => {
    if (!chartCode) return;
    chartMode = t.dataset.mode;
    syncChartTabs();
    drawChart();
  });
});
window.addEventListener('resize', () => {
  if (chartCode) drawChart();
});

tick();
setInterval(tick, POLL_INTERVAL);
