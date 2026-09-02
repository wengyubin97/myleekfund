# leek-float（韭菜悬浮窗）

Electron 桌面悬浮窗，在屏幕角落实时展示 **A股 / 港股** 行情。透明、置顶、可拖拽，不遮挡工作。

> 数据来自公开免费接口，仅作行情展示，不构成投资建议。

## 功能

- **实时行情**：A股 / 港股，腾讯接口，涨跌黄/蓝配色（非红绿）
- **悬浮窗**：透明背景、始终置顶、可拖拽缩放、底部滑杆调透明度、标题栏「黑白」灰度模式
- **自选股与分组**：添加 / 删除 / 排序 / 置顶，分组管理
- **图表**：分时图、K线（日 / 周 / 月）、分钟K线；个股行内嵌分时缩略图（0轴分色、宽/高/缩放可调）
- **价格预警**：价格穿越均线、均线金叉/死叉、价格穿越阈值，触发系统通知
- **配置导入 / 导出**：窗口右键菜单，原生文件对话框
- **全局快捷键**：`Alt+Q` 或 `Ctrl+Q` 显示/隐藏（托盘 / 窗口右键菜单可切换）

## 安装包

从 [Releases](https://github.com/wengyubin97/leek-float/releases) 下载：

| 平台 | 文件 | 说明 |
|------|------|------|
| Windows x64 | `leek-float-0.2.5.exe` | portable 单文件，无需安装 |
| macOS（Apple Silicon） | `leek-float-0.2.5.dmg` | 拖入「应用程序」即可 |

> macOS 包为本地签名（adhoc）。首次打开若提示"未受信任的开发者"，请右键 → 打开，或在系统设置中允许。

## 开发

```bash
cd float-window
npm install
npm start          # 启动开发版
npm run pack       # Windows portable exe
```

macOS 打包流程（需 ad-hoc 签名，详见 `AGENTS.md`）：`electron-builder --mac dir` → `codesign --force --deep --sign -` → `hdiutil create`。

打包前需设置镜像环境变量 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`（npmmirror），否则从 GitHub 下载 electron 失败。

## 快捷键

- 全局显示/隐藏：**`Alt+Q`**（默认）或 **`Ctrl+Q`**，在托盘图标右键 →「全局快捷键」切换
- `Escape`：关闭图表 / 确认条 / 添加面板
- `Enter`：添加面板中确认新增分组

## 技术细节

- Electron 31，纯 JS（`main.js` + `renderer.js` + `index.html`），无构建步骤
- 行情：腾讯 `qt.gtimg.cn`（GBK 编码，`iconv-lite` 解码）、`ifzq.gtimg.cn`（分时 / K线）
- 所有网络请求走主进程 IPC（renderer 受 CORS 限制），行情强制 IPv4
- 配置存 `userData/config.json`（勿写打包版 asar 内路径）；UI 状态存 localStorage