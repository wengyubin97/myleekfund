# AGENTS.md

## Where things live

- The workspace root (`myleekfund`) is NOT the project. The VSCode extension lives in **`leek-fund/`** — that is also where the git repo is. Run all commands from `C:\wyb\project\myleekfund\leek-fund`.
- **`leek-fund/float-window/`** is a separate Electron desktop floating window (韭菜悬浮窗): transparent, always-on-top, dragable. Plain JS (main.js + renderer.js/index.html), no build step. `npm install` once, then `npm start` inside it. It has its own `node_modules` (gitignored), is excluded from the vsix (`.vscodeignore`), and is **NOT in the git flow's tsc/vsce pipeline** — float-window changes need only `git commit` + restart the app (rebuild the exe only when the user asks).

## What this is

Personal fork (`wengyubin97/myleekfund`) of the leek-fund VSCode extension (韭菜盒子, v3.24.0). User only cares about A股/港股 watchlist; the fork adds custom status bar (signal colors, no flashing), stock groups, intraday chart tooltips, tail-session 破位风控 (breakout risk control), and an Electron desktop floating window that is now **standalone** (works without VSCode).

## VSCode extension custom features (keep intact)

- **状态栏**：个股紧凑格式 `名称 价格 涨跌幅`（整条涨跌色；快速拉升/下杀时信号色红/绿，静态不闪烁——`setBarFlash`）；分组按平均涨幅排序。急涨急跌（surge 涨速条）已移除，不要再加回。
- **破位风控**：每个交易日 14:55~15:00 自动检查全部自选股（调度在 `src/extension.ts`，实现 `src/service/breakRiskService.ts` + 纯判定 `src/shared/breakRisk.ts`）。数据：腾讯 `fqkline` 日线算 MA5/AVG_VOL_5（30s 缓存）+ 实时行情当日开/收/低/量。判定按用户 SOP：收盘<MA5 时 量比/实体/偏离 超标 → SELL_NOW，均未超 → OBSERVE 三天观察期（止损底线=触发日最低价）。结果写入 `globalState.breakRiskOutcomes`，Stock 视图个股行尾追加 `🔴SELL`/`🟡观察N`，分组行追加计数（`stockProvider.getGroupRiskSuffix`）。观察期持久化在配置 `leek-fund.breakWatch`（勿手改）。手动命令 `leek-fund.breakRiskCheck`。
- **分组**：侧边栏分组按平均涨跌幅降序；分组内常驻「➕ 添加股票到此分组」行（`contextValue: stockGroupAdd`，需在右键菜单 when 里排除）；标题栏「收起全部分组」用 VSCode 生成的 `workbench.actions.treeView.leekFundView.stock.collapseAll` 命令，不能用 provider 返回 Collapsed + refresh（VSCode 会记住展开状态）。
- **tooltip**：个股/分组悬停显示自渲染分时图 PNG（`groupChart.ts` 最小 PNG 编码器 + data URI，纯 markdown 不依赖 HTML；`MarkdownString.supportHtml` 颜色方案已回退废弃，勿复用）。

## Extension build/deploy workflow (VSCode extension changes only)

用户明确要求：改完扩展代码立即 `git commit` → 重新编译 → 打包安装，不要等指示。用户运行安装版 `giscafer.leek-fund-3.24.0`，不是 F5：

```
git commit                                              # 提交改动
./node_modules/.bin/tsc -p ./                           # 重新编译到 out/
./node_modules/.bin/vsce package --yarn -o ./           # 打包（内部再跑一次 compile）
code --install-extension ./leek-fund-3.24.0.vsix --force # 安装到 VSCode
```

Gotchas:
- `yarn` 不在默认 PATH——用 `./node_modules/.bin/vsce package --yarn`，别用裸 `yarn`。
- 无 lint 门槛：`tsc -p ./` 干净即可。husky 钩子未安装（`.git/hooks` 空），commit 不跑 lint。（CI `.github/workflows/pr.yml` 跑 `yarn pretest` = lint + compile，node 16.19.0。注意 CI 的 lint 在 `src/statusbar/groupChart.ts` 有既有 parsing error，非本次改动所致。）
- `npm test` 通过 `@vscode/test-electron` 下载 VS Code（依赖网络），用户流程从不跑。
- `out/` 被 gitignore 且 untracked——总是陈旧，改完必须重编译并用 grep 验证新逻辑进了 `out/`。
- vsix **包含 node_modules**：`.vscodeignore` 故意注释掉 `# node_modules`（运行时依赖 iconv-lite/axios 必须进包）。别"瘦身"。
- TypeScript strict，但 `@types/vscode` 钉在 **1.59.0**——新 API（`MarkdownString.supportHtml`、`EventEmitter` fire 参数）需 `as any` 或 `fire(undefined)`。

## float-window 关键架构（本会话踩过的坑，务必遵守）

- **所有网络请求必须走主进程 IPC**。Electron renderer 的 XHR 受 CORS/同源限制：`qt.gtimg.cn` 报 Network Error、`proxy.finance.qq.com`（smartbox 搜索）报 Network Error、`hq.sinajs.cn` 报 403。因此 main.js 注册 `ipcMain.handle('search-stocks')` / `('fetch-quotes')`，renderer 用 `ipcRenderer.invoke`。**新增任何网络请求都照此模式，不要直接在 renderer 里 axios。**
- **腾讯行情必须用 HTTP 且强制 IPv4**：`fetch-quotes` 用 `http://qt.gtimg.cn/q=`（HTTPS 经本机 Clash 代理报 SSL `WRONG_VERSION_NUMBER`/证书错误），并加 `family: 4`（本机 DNS 对 qt.gtimg.cn 只返回 IPv6，否则 `getaddrinfo ENOTFOUND`）。响应是 GBK，需 `iconv-lite` 解码。
- **配置存主进程 userData**：`configFile() = app.getPath('userData')/config.json`（Windows 上是 `%APPDATA%\韭菜悬浮窗\config.json`），经 `config-load`/`config-write` IPC 读写。打包版代码在只读的 `resources/app.asar` 里，**绝不能写 `__dirname`**（曾导致打包版增删股票/分组全部失效）。`migrateConfig()` 首次启动自动从 `float-window/config.json` 或 VSCode `settings.json` 导入。
- **UI 状态**（折叠/置顶/排序/黑白）存 localStorage。
- **打包**：`npm run pack`。`prepack` 钩子（`scripts/bump-version.js`）自动递增 patch 版本并写 `build-version.json`（renderer 读它显示 `vX.Y.Z` 于底部状态栏）。产物 `dist/leek-float-X.Y.Z.exe`（portable 单文件）。打包前必须设镜像环境变量，否则从 GitHub 下载 electron/nsis 失败：
  ```powershell
  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
  npm run pack
  ```
  打包配置里 `signAndEditExecutable: false`——本机无管理员权限，winCodeSign 解压需要符号链接权限会失败；代价是 exe 用默认图标（托盘图标不受影响）。
- 涨跌配色是**黄=涨 `#f0c828`、蓝=跌 `#6fb1ff`**（不是红绿，用户明确要求），UI 强调色用黄；删除按钮/确认条保留红色（危险语义）。

## Conventions that differ from defaults

- Extension UI 声明在 `package.json` `contributes`。新命令必须同时声明在 `package.json` 和注册到 `src/registerCommand.ts`；右键菜单 `when` 必须排除特殊 `viewItem`（如 `stockGroupAdd`）。
- 行情数据来自非官方免费接口（A/港：腾讯 `qt.gtimg.cn`；美股/期货：新浪 `hq.sinajs.cn`）。GBK/GB18030 编码，用 `iconv-lite` 解码。分时分钟量/额为累计值，需取差分。
- **Git 网络**：github.com 直连不通。全局代理 `http.proxy`/`https.proxy = http://127.0.0.1:7890`（Clash），fetch/push 走代理即可。
- 验证安装版代码用用户级 `C:/Users/win10/.claude/settings.json` 授权路径：`C:/Users/win10/.vscode/extensions/giscafer.leek-fund-3.24.0/out/...`。
- Commit style：conventional commits（`feat:`/`fix:`/`docs:`/`chore:`/`revert:` + 中文描述，见 commitlint.config.js），照 `git log` 写。
- 扩展的股票/分组仍来自 `C:/Users/win10/AppData/Roaming/Code/User/settings.json` 的 `leek-fund.*` 键；**悬浮窗已不读它**（独立 userData config），两边配置各自独立。