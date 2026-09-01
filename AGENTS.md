# AGENTS.md

## 这是什么

- 仓库 = 韭菜悬浮窗（Electron 桌面悬浮窗，A股/港股实时行情）。VSCode 插件代码已全部删除，只保留悬浮窗。
- 项目实际在 **`float-window/`** 子目录（git repo 根 = `leek-fund/`）。所有命令从 `float-window/` 里执行。
- 纯 JS（main.js + renderer.js/index.html），无构建步骤。改动只需 `git commit` + 重启应用（`npm start`）；重建 exe 仅在用户要求时。

## 运行

- `npm start`（float-window/ 内）。`node_modules` 已安装。

## 关键架构（本会话踩过的坑，务必遵守）

- **所有网络请求必须走主进程 IPC**。Electron renderer 的 XHR 受 CORS/同源限制：`qt.gtimg.cn` 报 Network Error、`proxy.finance.qq.com`（smartbox 搜索）报 Network Error、`hq.sinajs.cn` 报 403。main.js 注册 `ipcMain.handle('search-stocks')`/`('fetch-quotes')`/`('fetch-minute')`，renderer 用 `ipcRenderer.invoke`。**新增任何网络请求都照此模式。**
- **腾讯行情必须用 HTTP 且强制 IPv4**：`fetch-quotes` 用 `http://qt.gtimg.cn/q=`（HTTPS 经本机 Clash 代理报 SSL `WRONG_VERSION_NUMBER`），加 `family: 4`（本机 DNS 对 qt.gtimg.cn 只返回 IPv6）。**分时数据用 `ifzq.gtimg.cn`**（`web.ifzq.gtimg.cn` 的 minute 端点已下线返回 501）。响应 GBK，用 `iconv-lite` 解码。分时分钟量/额为累计值，需取差分。
- **配置存主进程 userData**：`configFile() = app.getPath('userData')/config.json`。dev 模式在 `%APPDATA%\leek-fund-float`，打包版在 `%APPDATA%\韭菜悬浮窗`（app.name 与 productName 不同导致目录不同）。打包版代码在只读的 `resources/app.asar`，**绝不能写 `__dirname`**。`migrateConfig()` 首次启动自动从 VSCode settings.json / 旧配置导入。
- **UI 状态**（折叠/置顶/排序/黑白/缩略图宽高缩放）存 localStorage。
- 涨跌配色是**黄=涨 `#f0c828`、蓝=跌 `#6fb1ff`**（不是红绿，用户明确要求），UI 强调色用黄；删除按钮/确认条保留红色（危险语义）。

## 打包 / 版本

- `npm run pack`：`prepack` 钩子（`scripts/bump-version.js`）自动递增 patch 版本并写 `build-version.json`（renderer 读它显示 `vX.Y.Z`）。产物 `dist/leek-float-X.Y.Z.exe`（portable 单文件）。
- **feature（minor）版本更新**：手动改 `package.json` 版本为 `0.X.0` 并写 `build-version.json`，然后直接跑 `./node_modules/.bin/electron-builder --win portable`（绕过 prepack 自增，否则会 +1 patch）。
- 打包前必须设镜像环境变量（否则从 GitHub 下载 electron/nsis 失败）：
  ```powershell
  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
  npm run pack
  ```
- 配置里 `signAndEditExecutable: false`——本机无管理员权限，winCodeSign 解压需要符号链接权限会失败；代价是 exe 用默认图标（托盘图标不受影响）。

## 约定

- 悬浮窗功能清单（写进「?」帮助面板，改动时同步）：+股/+组 增删、分组置顶/重命名/折叠、组/股排序、分时缩略图（0轴上黄下蓝，⚙调宽高缩放）、点击个股开图表（分时/分钟K/日周月K、滚轮缩放、拖拽平移、十字坐标）、透明度滑杆、黑白模式、Alt+Q 显示隐藏、托盘、右键菜单。
- Commit style：conventional commits（`feat:`/`fix:`/`docs:`/`chore:` + 中文描述），照 `git log` 写。
- **Git 网络**：github.com 直连不通。全局代理 `http.proxy`/`https.proxy = http://127.0.0.1:7890`（Clash），fetch/push 走代理即可。
- 用户实际配置在 `%APPDATA%\leek-fund-float\config.json`（dev 版当前在用）。