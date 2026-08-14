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
