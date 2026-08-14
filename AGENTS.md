# AGENTS.md

## Where things live

- The workspace root (`myleekfund`) is NOT the project. The VSCode extension lives in **`leek-fund/`** — that is also where the git repo is. Run all commands from `C:\wyb\project\myleekfund\leek-fund`.
- **`leek-fund/float-window/`** is a separate Electron desktop floating window (韭菜悬浮窗): transparent, always-on-top, dragable stock ticker reading the same `leek-fund.stocks` from the VSCode user settings. Run `npm start` inside it; it has its own `node_modules` (gitignored) and is excluded from the vsix (`.vscodeignore`).

## What this is

Personal fork (`wengyubin97/myleekfund`) of the leek-fund VSCode extension (韭菜盒子, v3.24.0). User only cares about A股/港股 watchlist; the fork adds custom status bar (signal colors, no flashing), stock groups, intraday chart tooltips, tail-session 破位风控 (breakout risk control), and an Electron desktop floating window.

## Custom features to keep intact

- **状态栏**：个股紧凑格式 `名称 价格 涨跌幅`（整条涨跌色；快速拉升/下杀时信号色红/绿，静态不闪烁——`setBarFlash`）；分组按平均涨幅排序。急涨急跌（surge 涨速条）已移除，不要再加回。
- **破位风控**：每个交易日 14:55~15:00 自动检查全部自选股（`src/service/breakRiskService.ts` + 纯判定 `src/shared/breakRisk.ts`）。数据：腾讯 `fqkline` 日线算 MA5/AVG_VOL_5（30s 缓存）+ 实时行情当日开/收/低/量。判定按用户 SOP：收盘<MA5 时 量比/实体/偏离 超标 → SELL_NOW，均未超 → OBSERVE 三天观察期（止损底线=触发日最低价）。结果写入 `globalState.breakRiskOutcomes`，Stock 视图个股行尾追加 `🔴SELL`/`🟡观察N`，分组行追加计数（`stockProvider.getGroupRiskSuffix`）。观察期持久化在配置 `leek-fund.breakWatch`（勿手改）。手动命令 `leek-fund.breakRiskCheck`。
- **分组**：侧边栏分组按平均涨跌幅降序；分组内常驻「➕ 添加股票到此分组」行（`contextValue: stockGroupAdd`，需在右键菜单 when 里排除）；标题栏「收起全部分组」用 VSCode 生成的 `workbench.actions.treeView.leekFundView.stock.collapseAll` 命令，不能用 provider 返回 Collapsed + refresh（VSCode 会记住展开状态）。
- **tooltip**：个股/分组悬停显示自渲染分时图 PNG（`groupChart.ts` 最小 PNG 编码器 + data URI，纯 markdown 不依赖 HTML；`MarkdownString.supportHtml` 颜色方案已回退废弃，勿复用）。

## Critical workflow (do not skip)

**默认流程（用户明确要求的固定规则）：每次修改完代码，立即依次执行 `git commit` → 重新编译 → 打包安装，不要等待用户指示。**

The user runs the installed extension (`giscafer.leek-fund-3.24.0`), not the F5 debug window. After any code change, the full pipeline is required or the user sees nothing:

```
git commit                                              # 提交改动
./node_modules/.bin/tsc -p ./                           # 重新编译到 out/
./node_modules/.bin/vsce package --yarn -o ./           # 打包（内部再跑一次 compile）
code --install-extension ./leek-fund-3.24.0.vsix --force # 安装到 VSCode
```

Gotchas:
- `yarn` is a global npm install not on the default PATH — use `./node_modules/.bin/vsce package --yarn`, never bare `yarn`.
- No lint gate: `./node_modules/.bin/tsc -p ./` compiling clean is the bar. (CI runs `yarn pretest` = lint + compile on node 16.19.0.)
- `out/` is tracked but never committed; it's stale build output. Recompile after edits and verify new logic landed in `out/` (e.g. grep).
- TypeScript strict, but `@types/vscode` is pinned to **1.59.0** — newer VSCode APIs (e.g. `MarkdownString.supportHtml`, `EventEmitter` fire args) need `as any` casts or `fire(undefined)`.
- **Git 网络**：github.com 直连不通。已配置全局代理 `http.proxy`/`https.proxy = http://127.0.0.1:7890`（Clash），fetch/push 走代理即可。若新机器 clone 失败先检查此配置。
- 验证安装版代码时用 `.claude/settings.json` 已授权的路径：`C:/Users/win10/.vscode/extensions/giscafer.leek-fund-3.24.0/out/...`。

## Conventions that differ from defaults

- Extension UI is declared in `package.json` `contributes` (`views`/`commands`/`menus`). New commands must be declared there AND registered in `src/registerCommand.ts`; menu `when` clauses must exclude special `viewItem` values like `stockGroupAdd`.
- Market data comes from unofficial free web APIs (Tencent `qt.gtimg.cn` for A/HK, Sina `hq.sinajs.cn` for US/futures). Responses are GBK/GB18030 — decode with `iconv-lite`. Intraday minute volume/amount are cumulative; take deltas.
- User settings live outside the repo at `C:/Users/win10/AppData/Roaming/Code/User/settings.json` (e.g. `leek-fund.statusBarStock`, `leek-fund.stockGroups`). Both the extension AND `float-window` read stocks/groups from there — keep one source of truth.
