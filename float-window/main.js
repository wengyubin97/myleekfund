const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, globalShortcut } = require('electron');

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

// 右键菜单（renderer 传入类型与屏幕坐标）：个股/分组行 → 删除；其余 → 应用菜单
ipcMain.on('context-menu', (_event, info) => {
  if (!win) return;
  let template;
  if (info.type === 'stock') {
    template = [{ label: `删除 ${info.name || info.code}`, click: () => win.webContents.send('delete-stock', info.code) }];
  } else if (info.type === 'group') {
    template = [{ label: `删除分组「${info.name}」`, click: () => win.webContents.send('delete-group', info.name) }];
  } else {
    template = [
      { label: '添加股票', click: () => win.webContents.send('menu-add-stock') },
      { label: '添加分组', click: () => win.webContents.send('menu-add-group') },
      { type: 'separator' },
      { label: '刷新数据', click: () => win.webContents.reload() },
      { label: '开发者工具', click: () => win.webContents.toggleDevTools() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ];
  }
  Menu.buildFromTemplate(template).popup({
    window: win,
    x: Math.round(info.x),
    y: Math.round(info.y),
  });
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
