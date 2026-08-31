const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

let win = null;
let tray = null;

// 托盘图标：32x32 绿色圆点（内嵌 base64，勿改）
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA50lEQVR4nO1XwQ2DMAzMnzVYgBn88AoskD2yRz5+ZpCuwwQ8WkU6JBQ1CQWCqYQlfyDkLj7HNsY89k9Gwj0JjyTsSNiTcIB7PIvv+hbAAwBeJDyT8DvjM9bEtcNZ4Bab5kBzHr+xR4A7nGTaAb74hD26PQRcJdxbPe7hfgW3B0/+LRLb5EDC7dF8S07UExOhPxt88bIUuOctTr+OQr5OoJCckXilhBy1wl+XASW1NQFfIhAuIBBuTUBdAvUkVL+GuoXoAhnqXVG9GRntdpxIoTOQmDuMZCsiOkNpQkJvLE+I6PyYPNbSPvy1iJ1JOJZdAAAAAElFTkSuQmCC';

function createWindow() {
  win = new BrowserWindow({
    width: 300,
    height: 460,
    minWidth: 220,
    minHeight: 200,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');

  // 右键菜单（窗口级：刷新/开发者工具/退出）
  win.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: '刷新数据', click: () => win.webContents.reload() },
      { label: '开发者工具', click: () => win.webContents.toggleDevTools() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]).popup({ window: win });
  });

  win.on('closed', () => {
    win = null;
  });
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
    tray.setToolTip('韭菜悬浮窗');
    tray.on('click', toggleWindow);
    tray.on('right-click', () => {
      tray.popUpContextMenu(
        Menu.buildFromTemplate([
          { label: '显示/隐藏悬浮窗', click: toggleWindow },
          { type: 'separator' },
          { label: '退出', click: () => app.quit() },
        ])
      );
    });
  } catch (err) {
    console.error('托盘创建失败：', err.message);
  }
}

ipcMain.on('win-close', () => app.quit());
ipcMain.on('win-hide', () => win && win.hide());
ipcMain.on('win-opacity', (_event, value) => {
  if (win && typeof value === 'number') {
    win.setOpacity(Math.max(0.15, Math.min(1, value)));
  }
});

// 股票搜索（走主进程 Node http，绕过 renderer 的 CORS 限制）
const searchAxios = require('axios');
ipcMain.handle('search-stocks', async (_event, keyword) => {
  const resp = await searchAxios.get('https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get', {
    params: { q: keyword },
    timeout: 8000,
  });
  return (resp.data && resp.data.data && resp.data.data.stock) || [];
});

// ---- 配置读写：存到 userData/config.json（打包后 app.asar 内不可写） ----
function configFile() {
  return path.join(app.getPath('userData'), 'config.json');
}
function migrateConfig() {
  const file = configFile();
  if (fs.existsSync(file)) return;
  // 1) 开发模式：迁移 float-window/config.json
  const devFile = path.join(__dirname, 'config.json');
  if (fs.existsSync(devFile)) {
    try {
      fs.copyFileSync(devFile, file);
      console.log('已迁移本地 config.json 到 userData');
      return;
    } catch (err) {
      console.error('迁移本地配置失败：', err.message);
    }
  }
  // 2) 首次启动：从 VSCode settings.json 导入
  try {
    const vsFile = path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json');
    const raw = fs.readFileSync(vsFile, 'utf8');
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const cfg = JSON.parse(stripped);
    const data = {
      stocks: cfg['leek-fund.stocks'] || [],
      groups: cfg['leek-fund.stockGroups'] || [],
      groupStocks: cfg['leek-fund.stockGroupStocks'] || [],
    };
    if (data.stocks.length || data.groups.length) {
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
      console.log('已从 VSCode settings.json 导入配置');
    }
  } catch (err) {
    // 无 VSCode 配置则保持空配置
  }
}
ipcMain.handle('config-load', () => {
  migrateConfig();
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch (err) {
    return { stocks: [], groups: [], groupStocks: [] };
  }
});
ipcMain.handle('config-write', (_event, obj) => {
  migrateConfig();
  fs.writeFileSync(configFile(), JSON.stringify(obj, null, 2), 'utf8');
  return true;
});

// 腾讯行情（走主进程 Node http，绕过 renderer 的 CORS/Network Error）
ipcMain.handle('fetch-quotes', async (_event, codes) => {
  const resp = await searchAxios.get('http://qt.gtimg.cn/q=', {
    responseType: 'arraybuffer',
    params: { q: codes.join(','), fmt: 'json' },
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
    family: 4, // 强制 IPv4（本机 DNS 仅返回 IPv6 导致 getaddrinfo 失败）
  });
  return resp.data; // Buffer
});

// 分时数据（每只股一次请求，并发拉取；供列表缩略图）
ipcMain.handle('fetch-minute', async (_event, codes) => {
  const result = {};
  let idx = 0;
  const worker = async () => {
    while (idx < codes.length) {
      const code = codes[idx++];
      try {
        // 用 ifzq.gtimg.cn（web.ifzq.gtimg.cn 的 minute 端点已下线返回 501）
        const resp = await searchAxios.get('https://ifzq.gtimg.cn/appstock/app/minute/query?code=' + code, {
          timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
        });
        result[code] = resp.data;
      } catch (err) {
        // 单只失败跳过，不影响其它
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, codes.length) }, worker));
  return result;
});

app.whenReady().then(() => {
  createWindow();
  createTray();

  // 全局快捷键 Alt+Q：显示/隐藏切换
  if (!globalShortcut.register('Alt+Q', toggleWindow)) {
    console.error('全局快捷键 Alt+Q 注册失败（可能被其他程序占用）');
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
