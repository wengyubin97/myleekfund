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
async function loadLeekConfig() {
  // 配置读写走主进程 IPC（userData/config.json，打包后 asar 内不可写）
  try {
    const cfg = await ipcRenderer.invoke('config-load');
    return {
      stocks: cfg.stocks || [],
      groups: cfg.groups || [],
      groupStocks: cfg.groupStocks || [],
    };
  } catch (err) {
    console.error('读取配置失败：', err.message);
    return { stocks: [], groups: [], groupStocks: [] };
  }
}

let cfg = { stocks: [], groups: [], groupStocks: [] };
loadLeekConfig().then((c) => {
  cfg = c;
  tick();
});

// 应用版本（打包时由 scripts/bump-version.js 生成，源码运行则无）
let appVersion = '';
try {
  appVersion = (JSON.parse(fs.readFileSync(path.join(__dirname, 'build-version.json'), 'utf8')) || {}).version || '';
} catch (err) {
  appVersion = '';
}

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
      bw: !!s.bw,
      sparkW: s.sparkW || 80,
      sparkZoom: s.sparkZoom || 1,
    };
  } catch (err) {
    console.error('读取界面状态失败：', err.message);
    return { collapsed: {}, groupSort: false, stockSort: false, sparkW: 80, sparkZoom: 1 };
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
  // 行情走主进程 IPC（renderer XHR 受 CORS 限制，qt.gtimg.cn 会 Network Error）
  const buf = await ipcRenderer.invoke('fetch-quotes', codes);
  const data = JSON.parse(decode(Buffer.from(buf), 'GBK'));
  return codes.map((code) => {
    const arr = data[code.toLowerCase()];
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
  // 不过滤空分组（新建的空分组也需要显示，方便用户添加股票）
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
    html += `<div class="group-row group-header" data-idx="${i}" data-name="${g.name}"><span class="gmarker">${collapsed ? '▸' : '▾'}</span><span class="gname">${g.name}(${g.members.length})</span><span class="gavg ${clsOf(avg)}">${sign(avg)}${avg.toFixed(2)}%</span><span class="pin ${uiState.pinned.includes(g.name) ? 'pinned' : ''}" title="置顶/取消置顶">📌</span><span class="rename" title="重命名分组">✏️</span><span class="del" title="删除分组">×</span></div>`;
    if (!collapsed) {
      html += g.members
        .map(
          (m) =>
            `<div class="stock-row" title="${m.name}" data-code="${m.code}" data-name="${m.name}" data-group="${g.name}"><span class="sname">${formatName(m.name)}</span><canvas class="spark" data-code="${m.code}"></canvas><span class="sprice flat">${m.price.toFixed(2)}</span><span class="spct ${clsOf(m.percent)}">${sign(m.percent)}${m.percent.toFixed(2)}%</span><span class="del" title="从分组移除">×</span></div>`
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
            `<div class="stock-row" title="${m.name}" data-code="${m.code}" data-name="${m.name}"><span class="sname">${formatName(m.name)}</span><canvas class="spark" data-code="${m.code}"></canvas><span class="sprice flat">${m.price.toFixed(2)}</span><span class="spct ${clsOf(m.percent)}">${sign(m.percent)}${m.percent.toFixed(2)}%</span><span class="del" title="删除股票">×</span></div>`
        )
        .join('');
    }
  }
  if (!quotes.length) {
    html = `<div class="group-row">无自选股（点击 +股 添加股票）</div>`;
  }
  listEl.innerHTML = html;

  // 绘制分时缩略图（从 minuteMap 取数，无数据则留空）
  listEl.querySelectorAll('canvas.spark').forEach((cv) => {
    drawSpark(cv, minuteMap.get(cv.dataset.code));
  });

  const d = new Date();
  const pad = (n) => (n < 10 ? `0${n}` : n);
  document.getElementById('updated').textContent = `${appVersion ? `v${appVersion} · ` : ''}更新 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 分时缩略图数据缓存：code -> { prevClose, points }
const minuteMap = new Map();
function updateMinuteMap(rawMap) {
  for (const code of Object.keys(rawMap)) {
    const body = rawMap[code];
    const stock = body && body.data && body.data[code];
    const list = (stock && stock.data && stock.data.data) || [];
    const qt = (stock && stock.qt && stock.qt[code]) || [];
    const prevClose = parseFloat(qt[4]);
    const points = [];
    list.forEach((line) => {
      const parts = String(line).split(/\s+/);
      if (parts.length >= 2) {
        const price = parseFloat(parts[1]);
        if (!isNaN(price)) points.push({ time: parts[0], price });
      }
    });
    if (!isNaN(prevClose) && prevClose > 0 && points.length) {
      minuteMap.set(code, { prevClose, points });
    }
  }
}

/** 绘制单只股票的分时缩略图（0轴上方黄、下方蓝；缩放=水平窗口，高度随缩放自适应） */
function drawSpark(canvas, record) {
  const cw = uiState.sparkW;
  const zoom = uiState.sparkZoom;
  // 高度随缩放自适应（放大时变高，便于看细节）
  const ch = Math.max(16, Math.min(80, Math.round(22 * zoom)));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (!record || !record.points || record.points.length < 2) return;

  const { prevClose, points } = record;
  // 缩放：只显示最右边区间（如 100 点放大 10x → 显示 [90,100]）
  const windowN = Math.max(10, Math.round(points.length / zoom));
  const pts = points.slice(points.length - windowN);
  const padL = 2;
  const padR = 2;
  const padT = 2;
  const padB = 2;
  const pcts = pts.map((p) => (p.price / prevClose - 1) * 100);
  const maxAbs = Math.max(...pcts.map((v) => Math.abs(v)), 0.3);
  const chartW = cw - padL - padR;
  const chartH = ch - padT - padB;
  const midY = padT + chartH / 2;
  const scale = chartH / 2 / maxAbs;
  const toX = (i) => padL + (i / Math.max(pts.length - 1, 1)) * chartW;
  const toY = (pct) => midY - pct * scale;

  // 零轴虚线
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(padL, midY);
  ctx.lineTo(cw - padR, midY);
  ctx.stroke();
  ctx.setLineDash([]);

  // 折线：0轴上方黄、下方蓝（clip 两次绘制，跨越处自动在轴处分色）
  const strokeLine = () => {
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(pcts[0]));
    for (let i = 1; i < pcts.length; i++) {
      ctx.lineTo(toX(i), toY(pcts[i]));
    }
    ctx.stroke();
  };
  ctx.lineWidth = 1.2;
  ctx.save();
  ctx.strokeStyle = '#f0c828';
  ctx.beginPath();
  ctx.rect(padL, 0, cw - padL - padR, midY);
  ctx.clip();
  strokeLine();
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = '#6fb1ff';
  ctx.beginPath();
  ctx.rect(padL, midY, cw - padL - padR, ch - midY);
  ctx.clip();
  strokeLine();
  ctx.restore();
}

/** 只返回展开分组（可见）股票的代码，用于分时缩略图拉取，折叠分组不请求 */
function visibleStockCodes() {
  const visible = new Set();
  cfg.groups.forEach((gname, gi) => {
    if (uiState.collapsed[gname]) return;
    (cfg.groupStocks[gi] || []).forEach((c) => visible.add(c));
  });
  if (!uiState.collapsed['__rest__']) {
    const grouped = new Set(cfg.groupStocks.flat());
    cfg.stocks.forEach((c) => {
      if (!grouped.has(c)) visible.add(c);
    });
  }
  return [...visible];
}

async function tick() {
  const codes = [...new Set([...cfg.stocks, ...cfg.groupStocks.flat()])];
  if (!codes.length) {
    render([]);
    return;
  }
  try {
    // 行情全量拉取；分时缩略图只拉取展开分组的股票
    const [quotes, minuteRaw] = await Promise.all([
      fetchQuotes(codes),
      ipcRenderer.invoke('fetch-minute', visibleStockCodes()).catch(() => ({})),
    ]);
    updateMinuteMap(minuteRaw || {});
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
  const renameBtn = e.target.closest('.rename');
  if (renameBtn) {
    const groupRow = renameBtn.closest('.group-header');
    if (groupRow && groupRow.dataset.name) {
      openAddPanel('renameGroup', '输入新的分组名称，回车确认', groupRow.dataset.name, groupRow.dataset.name);
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
    obj.stocks = (obj.stocks || []).filter((c) => c !== code);
    obj.groupStocks = (obj.groupStocks || []).map((arr) =>
      (arr || []).filter((c) => c !== code)
    );
  }).then(() => tick());
}

function removeStockFromGroup(code, groupName) {
  writeLeekConfig((obj) => {
    const groups = obj.groups || [];
    const gi = groups.indexOf(groupName);
    if (gi < 0) return;
    const arrs = obj.groupStocks || [];
    arrs[gi] = (arrs[gi] || []).filter((c) => c !== code);
  }).then(() => tick());
}

function deleteGroup(name) {
  writeLeekConfig((obj) => {
    const groups = obj.groups || [];
    const gi = groups.indexOf(name);
    if (gi < 0) return;
    const arrs = obj.groupStocks || [];
    const codes = arrs[gi] || [];
    const inOtherGroups = new Set();
    arrs.forEach((arr, i) => {
      if (i !== gi) (arr || []).forEach((c) => inOtherGroups.add(c));
    });
    codes.forEach((c) => {
      if (!inOtherGroups.has(c)) {
        obj.stocks = (obj.stocks || []).filter((s) => s !== c);
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

// 滚轮：图表视图下缩放时间周期（分时缩到最近 N 分钟 / K线缩到最近 N 根，上滚放大/下滚缩小）
document.addEventListener('wheel', (e) => {
  if (!chartCode) return;
  const delta = e.deltaY > 0 ? 10 : -10;
  if (chartMode === 'minute') {
    minuteCount = Math.min(minuteMax, Math.max(10, minuteCount + delta));
    minuteOffset = Math.min(minuteOffset, Math.max(0, minuteMax - minuteCount));
  } else {
    klineCount = Math.min(klineMax, Math.max(10, klineCount + delta));
    klineOffset = Math.min(klineOffset, Math.max(0, klineMax - klineCount));
  }
  drawChart();
}, { passive: true });

// ---- 配置增删改（走主进程 IPC 写 userData/config.json，串行队列防并发写） ----
async function readConfigObj() {
  return await ipcRenderer.invoke('config-load');
}
let writeQueue = Promise.resolve();
function writeLeekConfig(mutator) {
  writeQueue = writeQueue.then(async () => {
    const obj = await readConfigObj();
    mutator(obj);
    await ipcRenderer.invoke('config-write', obj);
    cfg.stocks = obj.stocks || [];
    cfg.groups = obj.groups || [];
    cfg.groupStocks = obj.groupStocks || [];
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

function openAddPanel(mode, placeholder, targetGroup, initialValue) {
  addMode = mode;
  addTargetGroup = targetGroup || null;
  addInput.placeholder = placeholder;
  addInput.value = initialValue || '';
  addResults.innerHTML = '';
  addPanel.style.display = 'block';
  addInput.focus();
  if (initialValue) addInput.select();
}
function closeAddPanel() {
  addPanel.style.display = 'none';
  addInput.value = '';
  addResults.innerHTML = '';
}

const ALLOWED_MARKETS = new Set(['sh', 'sz', 'bj', 'hk']);
async function searchStocks(keyword) {
  // 搜索走主进程 IPC（renderer 的 XHR 受 CORS 限制，proxy.finance.qq.com 会 Network Error）
  const stockArr = await ipcRenderer.invoke('search-stocks', keyword);
  return stockArr
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
  if (addMode === 'group' || addMode === 'renameGroup') return;
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
      const groups = obj.groups || [];
      if (!groups.includes(name)) {
        groups.push(name);
        obj.groups = groups;
        const arrs = obj.groupStocks || [];
        arrs.push([]);
        obj.groupStocks = arrs;
      }
    }).then(() => {
      closeAddPanel();
      tick();
    });
  } else if (e.key === 'Enter' && addMode === 'renameGroup') {
    const newName = addInput.value.trim();
    const oldName = addTargetGroup;
    if (!newName || !oldName || newName === oldName) return;
    writeLeekConfig((obj) => {
      const groups = obj.groups || [];
      const gi = groups.indexOf(oldName);
      if (gi < 0) return;
      groups[gi] = newName;
      obj.groups = groups;
      // 同步折叠/置顶状态里的旧组名引用
      if (uiState.collapsed[oldName] !== undefined) {
        uiState.collapsed[newName] = uiState.collapsed[oldName];
        delete uiState.collapsed[oldName];
      }
      const pi = uiState.pinned.indexOf(oldName);
      if (pi >= 0) uiState.pinned[pi] = newName;
      saveUIState();
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
      const groups = obj.groups || [];
      const gi = groups.indexOf(groupName);
      if (gi < 0) return;
      const arrs = obj.groupStocks || [];
      const arr = arrs[gi] || [];
      if (!arr.includes(code)) {
        arrs[gi] = [...arr, code];
        obj.groupStocks = arrs;
      }
      const stocks = obj.stocks || [];
      if (!stocks.includes(code)) {
        stocks.push(code);
        obj.stocks = stocks;
      }
    }).then(() => {
      closeAddPanel();
      tick();
    });
    return;
  }
  writeLeekConfig((obj) => {
    const stocks = obj.stocks || [];
    if (!stocks.includes(code)) {
      stocks.push(code);
      obj.stocks = stocks;
    }
  }).then(() => {
    closeAddPanel();
    tick();
  });
});

// ---- 标题栏按钮：添加股票 / 添加分组 ----
document.getElementById('btnAddStock').addEventListener('click', () => openAddPanel('stock', '输入股票名称/代码搜索'));
document.getElementById('btnAddGroup').addEventListener('click', () => openAddPanel('group', '输入分组名称，回车创建'));

// 黑白/彩色模式切换（整窗灰度）
const btnBw = document.getElementById('btnBw');
function syncBw() {
  document.body.classList.toggle('bw', uiState.bw);
  btnBw.classList.toggle('active', uiState.bw);
}
btnBw.addEventListener('click', () => {
  uiState.bw = !uiState.bw;
  saveUIState();
  syncBw();
});
syncBw();

// ---- 分时缩略图设置面板（宽/缩放；高度随缩放自适应） ----
const sparkSettingsEl = document.getElementById('sparkSettings');
function syncSparkSettings() {
  document.getElementById('sparkW').value = uiState.sparkW;
  document.getElementById('sparkZoom').value = uiState.sparkZoom;
  document.getElementById('sparkWV').textContent = uiState.sparkW;
  document.getElementById('sparkZV').textContent = uiState.sparkZoom.toFixed(1);
}
document.getElementById('btnSparkSet').addEventListener('click', () => {
  sparkSettingsEl.style.display = sparkSettingsEl.style.display === 'block' ? 'none' : 'block';
  syncSparkSettings();
});
[['sparkW', 'sparkWV'], ['sparkZoom', 'sparkZV']].forEach(([key, labelId]) => {
  document.getElementById(key).addEventListener('input', (e) => {
    uiState[key] = key === 'sparkZoom' ? Number(e.target.value) : parseInt(e.target.value, 10);
    document.getElementById(labelId).textContent = key === 'sparkZoom' ? uiState[key].toFixed(1) : uiState[key];
    saveUIState();
    if (lastQuotes) render(lastQuotes);
  });
});

// ---- 图表视图（分时/日K/周K/月K） ----
const chartView = document.getElementById('chartView');
const chartCanvas = document.getElementById('chartCanvas');
const chartTitleEl = document.getElementById('chartTitle');
const chartLegendEl = document.getElementById('chartLegend');
const chartInfoEl = document.getElementById('chartInfo');
let chartCode = null;
let chartName = '';
let chartMode = 'minute';
let klineCount = 220; // K线默认显示根数（最新 N 根）
let klineMax = 220; // 当前数据最大根数
let minuteCount = 0; // 分时显示点数（0=全部），滚轮缩放
let minuteMax = 0; // 分时当前数据总点数
let minuteOffset = 0; // 分时平移：距最新数据的偏移点数（0=最新）
let klineOffset = 0; // K线平移：距最新数据的偏移根数（0=最新）
let dragState = null; // 拖拽平移状态 { startX, minuteOffset, klineOffset }
let lastChartData = null; // 最近一次拉取的图表数据（供十字坐标重绘）
let lastGeom = null; // 最近一次绘制用到的几何信息（toX/toY/坐标域等）
let chartHover = null; // { x, y } 鼠标位置（画布 CSS 像素）
const chartCache = new Map(); // `${code}:${mode}` -> { time, data }

const KLINE_QUERY = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=';
const MKLINE_QUERY = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/mkline?param=';
const MINUTE_K_PERIODS = new Set(['m1', 'm5', 'm15', 'm60', 'm120']);
const C_UP = '#f0c828'; // 涨=黄
const C_DOWN = '#6fb1ff'; // 跌=蓝
const C_AVG = '#e8e8e8'; // 均价线=白（与涨色区分）
const C_GRID = 'rgba(255,255,255,0.10)';
const C_TEXT = '#b8b8b8';
const C_MA5 = '#ff9f43';
const C_MA10 = '#4dd0e1';
const C_MA20 = '#c88fff';

async function fetchChartData(code, mode) {
  const key = `${code}:${mode}`;
  const cached = chartCache.get(key);
  // 缓存保鲜：分时 5s、1分钟K 15s、5/15分钟K 30s、其余 60s
  const ttl =
    mode === 'minute' ? POLL_INTERVAL :
    mode === 'm1' ? 15000 :
    mode === 'm5' || mode === 'm15' ? 30000 : 60000;
  if (cached && Date.now() - cached.time < ttl) {
    return cached.data;
  }
  let data = null;
  if (mode === 'minute') {
    // 分时走主进程 IPC（web.ifzq.gtimg.cn 的 minute 端点已下线返回 501，主进程用 ifzq.gtimg.cn）
    const raw = await ipcRenderer.invoke('fetch-minute', [code]);
    const body = raw[code];
    const stock = body && body.data && body.data[code];
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
  } else if (MINUTE_K_PERIODS.has(mode)) {
    // 分钟K线走 mkline 端点（最多 320 根）
    const resp = await axios.get(`${MKLINE_QUERY}${code},${mode},,320`, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
    });
    const stock = resp.data && resp.data.data && resp.data.data[code];
    const rows = (stock && (stock[mode] || stock[`qfq${mode}`])) || [];
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

function drawMinute(ctx, w, h, data, total, prevVol) {
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

  // 分时量柱（差分，黄涨蓝跌）
  const volBase = h - 18;
  const vols = [];
  let prev = prevVol || 0;
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

  chartLegendEl.textContent = `显示 ${points.length}/${total} · 昨收 ${prevClose}  现价 ${points[points.length - 1].price.toFixed(2)}  ${lastPct >= 0 ? '+' : ''}${lastPct.toFixed(2)}%`;

  lastGeom = {
    mode: 'minute',
    n: points.length,
    padL,
    padR,
    padT,
    chartH,
    toX,
    valueOfY: (y) => (midY - y) / scale,
    infoLines: (i) => {
      const p = points[i];
      const pct = (p.price / prevClose - 1) * 100;
      const t = p.time;
      const v = vols[i] || 0;
      const fmt = (x) => (x >= 10000 ? `${(x / 10000).toFixed(1)}万` : String(x));
      return [
        `${t.slice(0, 2)}:${t.slice(2, 4)}  价 ${p.price.toFixed(2)}  ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`,
        `量 ${fmt(v)}`,
      ];
    },
  };
}

function drawKline(ctx, w, h, bars, mode, total) {
  const padL = 10;
  const padR = 10;
  const padT = 10;
  const volH = Math.round(h * 0.16);
  const chartH = h - padT - volH - 24;
  const n = bars.length;
  if (!n) return;
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

  // 时间轴：均匀取 5 个标签（分钟K显示时分，日/周/月K显示日期）
  ctx.fillStyle = C_TEXT;
  const xLabel = (d) =>
    MINUTE_K_PERIODS.has(mode) ? `${d.slice(8, 10)}:${d.slice(10, 12)}` : d.slice(2);
  [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1].forEach((i) => {
    ctx.fillText(xLabel(bars[i].date), toX(i) - 12, h - 6);
  });

  // 图例：最新一根 OHLC + 显示根数
  const last = bars[n - 1];
  const pct = n > 1 ? (last.close / bars[n - 2].close - 1) * 100 : 0;
  chartLegendEl.textContent = `显示 ${bars.length}/${total} 根 · 开 ${last.open.toFixed(2)} 高 ${last.high.toFixed(2)} 低 ${last.low.toFixed(2)} 收 ${last.close.toFixed(2)}  ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;

  lastGeom = {
    mode,
    n: bars.length,
    padL,
    padR,
    padT,
    chartH,
    toX,
    valueOfY: (y) => maxP - ((y - padT) / chartH) * (maxP - minP),
    infoLines: (i) => {
      const b = bars[i];
      const pc = i > 0 ? bars[i - 1].close : b.open;
      const bpct = (b.close / pc - 1) * 100;
      const fmt = (x) => (x >= 10000 ? `${(x / 10000).toFixed(1)}万` : String(x));
      const d = MINUTE_K_PERIODS.has(mode) ? `${b.date.slice(8, 10)}:${b.date.slice(10, 12)}` : b.date;
      return [
        `${d}`,
        `开 ${b.open.toFixed(2)} 高 ${b.high.toFixed(2)}`,
        `低 ${b.low.toFixed(2)} 收 ${b.close.toFixed(2)}  ${bpct >= 0 ? '+' : ''}${bpct.toFixed(2)}%`,
        `量 ${fmt(b.volume)}`,
      ];
    },
  };
}

/** 十字坐标轴（跟随鼠标，吸附最近的点，左侧标价 + 底部坐标栏显示数据） */
function drawCrosshair(ctx, w, h) {
  const g = lastGeom;
  if (!g || !chartHover) {
    chartInfoEl.textContent = '';
    return;
  }
  let i;
  if (g.mode === 'minute') {
    i = Math.round(((chartHover.x - g.padL) / Math.max(w - g.padL - g.padR, 1)) * (g.n - 1));
  } else {
    const bw = (w - g.padL - g.padR) / g.n;
    i = Math.floor((chartHover.x - g.padL) / Math.max(bw, 1));
  }
  i = Math.max(0, Math.min(g.n - 1, i));
  const cx = g.toX(i);
  const yTop = g.padT;
  const yBot = g.padT + g.chartH;
  const cy = Math.min(Math.max(chartHover.y, yTop), yBot);

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(cx, yTop);
  ctx.lineTo(cx, yBot);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(g.padL, cy);
  ctx.lineTo(w - g.padR, cy);
  ctx.stroke();
  ctx.restore();

  // 左侧价格标注（在坐标留白区，不遮挡图像）
  const price = g.valueOfY(cy);
  const label = g.mode === 'minute' ? `${price >= 0 ? '+' : ''}${price.toFixed(2)}%` : price.toFixed(2);
  const lw = label.length * 7;
  ctx.fillStyle = 'rgba(16,16,20,0.85)';
  ctx.fillRect(0, cy - 7, lw + 8, 14);
  ctx.fillStyle = '#e8e8e8';
  ctx.fillText(label, 4, cy + 3);

  // 底部坐标栏显示当前点数据
  chartInfoEl.textContent = g.infoLines(i).join(' ');
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
    lastChartData = null;
    const { ctx, w } = setupCanvas();
    ctx.fillStyle = C_TEXT;
    ctx.fillText('数据拉取失败', 10, 20);
    return;
  }
  if (chartCode !== code || chartMode !== mode) return;
  if (!data || (mode === 'minute' && (!data.points || !data.points.length)) || (mode !== 'minute' && !data.length)) {
    lastChartData = null;
    const { ctx, w } = setupCanvas();
    ctx.fillStyle = C_TEXT;
    ctx.fillText('暂无数据', 10, 20);
    return;
  }
  lastChartData = data;
  renderChart();
}

function renderChart() {
  if (!chartCode || !lastChartData) return;
  const { ctx, w, h } = setupCanvas();
  const mode = chartMode;
  const data = lastChartData;
  // 数据与当前周期类型不匹配（切换/打开期间的陈旧数据）→ 不绘制，避免崩溃
  if (mode === 'minute') {
    if (!data.points || !data.points.length) return;
  } else {
    if (!Array.isArray(data) || !data.length) return;
  }
  if (mode === 'minute') {
    minuteMax = data.points.length;
    if (minuteCount === 0 || minuteCount > minuteMax) minuteCount = minuteMax;
    minuteOffset = Math.min(minuteOffset, Math.max(0, minuteMax - minuteCount));
    const end = data.points.length - minuteOffset;
    const start = Math.max(0, end - minuteCount);
    const prevVol = start > 0 ? data.points[start - 1].volume || 0 : 0;
    const visible = data.points.slice(start, end);
    drawMinute(ctx, w, h, { prevClose: data.prevClose, points: visible }, data.points.length, prevVol);
  } else {
    klineMax = data.length;
    if (klineCount > klineMax) klineCount = klineMax;
    klineOffset = Math.min(klineOffset, Math.max(0, klineMax - klineCount));
    const end = data.length - klineOffset;
    const start = Math.max(0, end - klineCount);
    drawKline(ctx, w, h, data.slice(start, end), mode, data.length);
  }
  drawCrosshair(ctx, w, h);
}

function syncChartTabs() {
  document.getElementById('chartPeriod').value = chartMode;
}

function openChart(code, name) {
  chartCode = code;
  chartName = name;
  chartTitleEl.textContent = `${name} ${code}`;
  chartMode = 'minute';
  minuteOffset = 0;
  klineOffset = 0;
  chartHover = null;
  dragState = null;
  lastChartData = null;
  chartInfoEl.textContent = '';
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
  chartHover = null;
  chartInfoEl.textContent = '';
  if (lastQuotes) render(lastQuotes);
}

document.getElementById('chartBack').addEventListener('click', closeChart);
document.getElementById('chartPeriod').addEventListener('change', (e) => {
  if (!chartCode) return;
  chartMode = e.target.value;
  lastChartData = null;
  drawChart();
});
window.addEventListener('resize', () => {
  if (chartCode) drawChart();
});

// 十字坐标轴 + 拖拽平移：pointerdown 记录起点，拖动按像素换算平移量，松开结束
chartCanvas.addEventListener('pointerdown', (e) => {
  dragState = {
    startX: e.clientX,
    minuteOffset,
    klineOffset,
  };
  chartCanvas.setPointerCapture(e.pointerId);
});
chartCanvas.addEventListener('pointermove', (e) => {
  if (!dragState) {
    const rect = chartCanvas.getBoundingClientRect();
    chartHover = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (lastChartData && chartCode) renderChart();
    return;
  }
  const g = lastGeom;
  if (!g) return;
  const rect = chartCanvas.getBoundingClientRect();
  const chartW = Math.max(rect.width - g.padL - g.padR, 1);
  const pxPerBar = chartW / (g.mode === 'minute' ? Math.max(g.n - 1, 1) : g.n);
  const dx = e.clientX - dragState.startX;
  const delta = Math.round(dx / pxPerBar);
  if (g.mode === 'minute') {
    minuteOffset = Math.max(0, Math.min(Math.max(0, minuteMax - minuteCount), dragState.minuteOffset + delta));
  } else {
    klineOffset = Math.max(0, Math.min(Math.max(0, klineMax - klineCount), dragState.klineOffset + delta));
  }
  if (lastChartData && chartCode) renderChart();
});
const endDrag = (e) => {
  if (!dragState) return;
  dragState = null;
  try {
    chartCanvas.releasePointerCapture(e.pointerId);
  } catch (err) {
    /* ignore */
  }
};
chartCanvas.addEventListener('pointerup', endDrag);
chartCanvas.addEventListener('pointercancel', endDrag);
chartCanvas.addEventListener('pointerleave', () => {
  if (!dragState && chartHover) {
    chartHover = null;
    if (lastChartData && chartCode) renderChart();
  }
});

// 图表打开期间跟随轮询刷新（分时实时更新，K线走缓存重绘）
setInterval(() => {
  if (chartCode) drawChart();
}, POLL_INTERVAL);

setInterval(tick, POLL_INTERVAL);
