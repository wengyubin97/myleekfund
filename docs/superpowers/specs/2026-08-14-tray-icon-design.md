# 悬浮窗系统托盘角标（显示/隐藏入口）设计

日期：2026-08-14
状态：已批准（用户确认）

## 背景与问题

悬浮窗 `BrowserWindow` 设置了 `skipTaskbar: true`，窗口不占任务栏。标题栏「—」按钮调用 `win.minimize()` 后，窗口没有任何入口可以恢复，只能重启应用。用户需要简单的「打开/隐藏」入口。

## 目标

- 系统托盘（时钟旁）常驻图标，作为悬浮窗的显示/隐藏入口
- 隐藏后的窗口可一键恢复，且不占任务栏

## 方案

### 1. `main.js`

- 引入 `Tray`、`nativeImage`。
- 用内嵌 base64 PNG（32×32 绿色圆点，无新增资源文件）创建托盘图标：
  `tray = new Tray(nativeImage.createFromDataURL(ICON_DATA_URL))`，`tray.setToolTip('韭菜悬浮窗')`。
  `tray` 为模块级全局变量，防止被 GC 回收导致托盘消失。
- 托盘交互：
  - 左键点击 `tray.on('click')` → 切换：窗口可见则 `win.hide()`，否则 `win.show(); win.focus()`。
  - 右键 `tray.on('right-click')` → `Menu`：显示/隐藏（同上切换）、退出（`app.quit()`）。
- IPC 改名：`win-minimize` → `win-hide`，处理改为 `win.hide()`（不再 minimize，避免无入口恢复）。
- `win-close`（✕）语义不变：`app.quit()`。

### 2. `renderer.js`

- `btnMin` 点击改为发送 `win-hide`。

### 3. `index.html`

- 「—」按钮 `title` 改为「隐藏到托盘」。

## 数据流

标题栏「—」→ IPC `win-hide` → `win.hide()`；托盘左键/菜单 → `win.show()/hide()` 切换。

## 错误处理

- 托盘创建失败（极不可能）不影响窗口本身：`new Tray` 抛错时用 try/catch 包裹并 `console.error`。

## 测试

- 无自动化测试框架（Electron 渲染层）。手动验证清单：
  1. 启动后托盘出现绿色图标
  2. 点「—」窗口隐藏，托盘左键点击恢复
  3. 托盘右键菜单「显示/隐藏」「退出」可用
  4. ✕ 仍为退出
  5. 悬浮窗列表滚动/透明度功能不受影响
