const { app, BrowserWindow, ipcMain, Menu } = require('electron');

let win = null;

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

  // 右键菜单
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

ipcMain.on('win-close', () => app.quit());
ipcMain.on('win-minimize', () => win && win.minimize());
ipcMain.on('win-opacity', (_event, value) => {
  if (win && typeof value === 'number') {
    win.setOpacity(Math.max(0.15, Math.min(1, value)));
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
