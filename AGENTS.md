# AGENTS.md

## Where things live

- The workspace root (`myleekfund`) is NOT the project. The VSCode extension lives in **`leek-fund/`** — that is also where the git repo is. Run all commands from `C:\wyb\project\myleekfund\leek-fund`.
- **`leek-fund/float-window/`** is a separate Electron desktop floating window (韭菜悬浮窗): transparent, always-on-top, dragable stock ticker reading the same `leek-fund.stocks` from the VSCode user settings. Run `npm start` inside it; it has its own `node_modules` (gitignored) and is excluded from the vsix (`.vscodeignore`).

## What this is

Personal fork (`wengyubin97/myleekfund`) of the leek-fund VSCode extension (韭菜盒子, v3.24.0). User only cares about A股/港股 watchlist; the fork adds custom status bar (signal colors, no flashing), stock groups, intraday chart tooltips.

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
- TypeScript strict, but `@types/vscode` is pinned to **1.59.0** — newer VSCode APIs (e.g. `MarkdownString.supportHtml`) need `as any` casts.

## Conventions that differ from defaults

- Extension UI is declared in `package.json` `contributes` (`views`/`commands`/`menus`). New commands must be declared there AND registered in `src/registerCommand.ts`; menu `when` clauses must exclude special `viewItem` values like `stockGroupAdd`.
- Market data comes from unofficial free web APIs (Tencent `qt.gtimg.cn` for A/HK, Sina `hq.sinajs.cn` for US/futures). Responses are GBK/GB18030 — decode with `iconv-lite`. Intraday minute volume/amount are cumulative; take deltas.
- User settings live outside the repo at `C:/Users/win10/AppData/Roaming/Code/User/settings.json` (e.g. `leek-fund.statusBarStock`). `.claude/settings.json` grants access to it and to the installed extension dir `C:/Users/win10/.vscode/extensions/giscafer.leek-fund-3.24.0` for verifying installed builds.
