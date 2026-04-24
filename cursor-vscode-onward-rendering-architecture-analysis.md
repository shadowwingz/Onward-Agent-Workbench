<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cursor / VS Code / Onward 渲染架构逆向分析报告

生成日期：2026-04-24

分析范围：

- Cursor：`/Applications/Cursor.app`
- VS Code：`/Applications/Visual Studio Code.app`
- Onward：当前仓库 `/Users/yingyun/Projects/Onward-Github`
- Onward 参考文档：`docs/Off-Renderer Threaded Design - Electron Refactor.md`

## 1. 结论摘要

Cursor 的渲染架构不是单纯的「Electron Renderer + React 页面」模型，而是继承 VS Code 的多进程桌面 IDE 架构后，在其上叠加了大量 AI / Agent / Browser / Retrieval 相关服务。其核心设计是：主 UI 仍由 Workbench Renderer 承载，但可扩展、可阻塞、可并发的能力被拆到 Extension Host、PTY Host、Shared Process、Utility Process、BrowserView/Webview、原生 Node addon、Rust 可执行文件、WASM 和外部二进制工具中。

VS Code 是 Cursor 的关键横向基线。当前本机 VS Code `1.114.0` 已经包含 Chat、Agent、MCP、BrowserView、Copilot、Playwright、sandbox-runtime 等 AI/浏览器相关组件，因此它不是一个“纯编辑器基线”。Cursor 的差异主要体现在：更大的 Workbench bundle、更重的内置扩展集合、更深的 Composer/Agent 协议、更完整的检索索引服务，以及 `cursorsandbox` / `crepectl` / `@anysphere/file-service` 这类异构执行层。

Onward 的现有方向与 Cursor/VS Code 的高层原则一致：Renderer 只应保留输入、DOM 提交和轻量状态；Git、Project FS、SQLite、AppState、ripgrep 已经通过 Node Worker thread 分流；Terminal 输出也已有优先级调度。但 Onward 当前仍比 Cursor/VS Code 更“单体”：没有 Extension Host、Shared Process、PTY Host 独立进程、Utility Process 服务层；Markdown sanitize、Mermaid、Git Diff/History 大结果应用、部分 ProjectEditor 大文件路径仍存在 Renderer 压力。

对 Onward 最有价值的借鉴不是照搬 VS Code/Cursor 的完整 IDE 平台，而是复制其边界原则：把「可增长、可阻塞、可取消」的工作从 Renderer 移到明确的服务宿主中，并让 Renderer 只处理可见区域、输入优先级和 DOM/Monaco/xterm 提交。

## 2. 逆向分析方法

本报告采用静态逆向分析，不启动 Cursor 或 VS Code，不注入、不绕过签名、不分析服务端通信内容。

使用的证据类型：

- `Info.plist`：确认应用标识、版本、签名、URL scheme、Helper 进程信息。
- Bundle 目录：确认 `Contents/Resources/app/out`、`extensions`、`node_modules`、`Frameworks`、helper app。
- `package.json` / `product.json`：确认入口、版本、commit、应用名和数据目录。
- bundle 字符串和 source-map 模块标签：确认主进程、Workbench、AI/Agent/MCP/Browser/Worker 模块边界。
- 内置扩展 `package.json`：确认 activationEvents、extensionKind、入口文件。
- Mach-O / `.node` / `.wasm` / 外部二进制：确认异构执行组件。
- Onward 源码和 `docs/Off-Renderer Threaded Design - Electron Refactor.md`：确认当前设计目标与实现状态。

限制：

- Cursor 与 VS Code 的生产 bundle 已压缩/打包，模块名和字符串只能证明组件存在和边界方向，不能等价于完整源码审计。
- 没有运行动态 trace，因此本报告不声明 Cursor/VS Code 的真实性能数据，只分析架构边界。
- 不推断 Cursor 云端服务内部实现，只分析本地客户端包内证据。

## 3. 本地取证摘要

### 3.1 应用元数据

| 对象 | Cursor | VS Code |
|---|---:|---:|
| 本地路径 | `/Applications/Cursor.app` | `/Applications/Visual Studio Code.app` |
| 版本 | `3.1.15` | `1.114.0` |
| 主入口 | `./out/main.js` | `./out/main.js` |
| applicationName | `cursor` | `code` |
| dataFolderName | `.cursor` | `.vscode` |
| commit | `3a67af7b780e0bfc8d32aefa96b8ff1cb8817f80` | `e7fb5e96c0730b9deb70b33781f98e2f35975036` |
| build date | `2026-04-15T01:46:06.515Z` | `2026-04-01T09:27:11Z` |
| Bundle ID | `com.todesktop.230313mzl4w4u92` | `com.microsoft.VSCode` |
| URL scheme | `cursor://` | `vscode://` |
| 签名主体 | `Developer ID Application: Hilary Stout (VDXQ22DGB9)` | `Developer ID Application: Microsoft Corporation (UBF8T346G9)` |

### 3.2 体积与模块密度

| 项目 | Cursor | VS Code | 观察 |
|---|---:|---:|---|
| `app/out` | `73M` | `51M` | Cursor 输出更大 |
| `workbench.desktop.main.js` | `50.3M` | `16.3M` | Cursor Workbench 增量非常明显 |
| `main.js` | `1.40M` | `1.17M` | Cursor 主进程也有定制增量 |
| `extensions` | `153M` | `57M` | Cursor 内置扩展层明显更重 |
| `node_modules` | `171M` | `130M` | Cursor 额外依赖更多 |
| 签名 sealed resources | `17930` files | `4891` files | Cursor 包内资源数量约 3.7 倍 |

### 3.3 Helper 进程

两者都包含标准 Electron Helper：

- Cursor：`Cursor Helper.app`、`Cursor Helper (Renderer).app`、`Cursor Helper (GPU).app`、`Cursor Helper (Plugin).app`
- VS Code：`Code Helper.app`、`Code Helper (Renderer).app`、`Code Helper (GPU).app`、`Code Helper (Plugin).app`

含义：

- Renderer Helper 承载 Chromium renderer。
- GPU Helper 承载 Chromium GPU 加速。
- Plugin Helper 通常承载 Extension Host / 插件相关 Node/Electron 进程。
- 普通 Helper 可承载通用子进程。

## 4. VS Code 渲染架构基线

VS Code 的本地架构可以概括为以下层级：

```text
Electron Main Process
  -> BrowserWindow / WebContents: Workbench Renderer
  -> Shared Process: 跨窗口共享服务
  -> Extension Host: 扩展运行时，独立 Helper 进程
  -> PTY Host: 终端进程管理与 node-pty
  -> Utility Process: 请求、网络等隔离工作
  -> Search / File Watch / Git / Tunnel / BrowserView / Webview 服务
  -> Native addons / WASM / external binaries
```

关键特点：

- Workbench Renderer 负责主 UI、编辑器、布局、命令面板、可见 DOM、Monaco、xterm UI 接入。
- Extension Host 把扩展代码从主 UI Renderer 隔离出去，减少扩展阻塞 UI 的概率。
- PTY、search、watcher、request 等高风险或高延迟工作不直接压在 Renderer 上。
- Webview 和 BrowserView 使用额外 WebContents 隔离第三方/网页内容。
- 现代 VS Code 已包含 Chat/Agent/MCP/BrowserView/Copilot 类能力，因此它已经是“AI IDE”方向的基线，而不是传统轻量编辑器。

本机 VS Code-only 内置扩展只有少量差异项：`dotenv`、`mermaid-chat-features`、`prompt-basics`。这说明 VS Code 发行包本身也已经带有 AI/Prompt 相关能力。

## 5. Cursor 渲染架构分析

### 5.1 继承 VS Code 的核心骨架

Cursor 的 `app/out/main.js` 模块标签中可以看到与 VS Code 同源的进程/服务边界：

- `vs/platform/sharedProcess/electron-main/sharedProcess.js`
- `vs/platform/utilityProcess/electron-main/utilityProcess.js`
- `vs/platform/utilityProcess/electron-main/utilityProcessWorkerMainService.js`
- `vs/platform/extensions/electron-main/extensionHostStarter.js`
- `vs/platform/terminal/electron-main/electronPtyHostStarter.js`
- `vs/platform/terminal/node/ptyHostService.js`
- `vs/platform/webview/electron-main/webviewMainService.js`
- `vs/platform/webview/electron-main/webviewProtocolProvider.js`
- `vs/platform/browserView/electron-main/browserViewMainService.js`
- `vs/workbench/services/search/node/ripgrepHelper.js`

这说明 Cursor 的主 UI 不是所有工作都在一个 Renderer 内完成，而是保留了 VS Code 的多进程服务化基础。

### 5.2 Workbench Renderer

Cursor 的主 UI bundle 是：

- `/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js`

取证结果：

- Cursor Workbench bundle 约 `50.3M`。
- VS Code Workbench bundle 约 `16.3M`。
- Cursor Workbench 中出现大量 `composer`、`agent`、`mcp`、`proto/agent`、`proto/aiserver`、`browserView`、`retrieval` 模块。

Cursor Workbench 承载的主要 UI/协议模块包括：

- Chat：`vs/workbench/contrib/chat/**`
- Composer：`vs/workbench/contrib/composer/**`
- Agent：`vs/workbench/services/agent/**`、`proto/agent/v1/**`
- AI Server 协议：`proto/aiserver/v1/**`
- MCP：`vs/workbench/contrib/mcp/**`、`vs/workbench/services/ai/browser/mcp*`
- Browser automation / browser editor：`composer/browser/browser*`
- Cursor 自有能力：`cursorRules`、`cursorHooks`、`cursorIgnore`、`cursorAuth`、`cursorPlugins`、`cursorBlame`

推断：

- Cursor 把大量 AI 交互状态、Composer UI、工具调用展示和 Browser 工具 UI 放在 Workbench Renderer。
- 但重型执行并不只在 Renderer 内完成，而是通过扩展宿主、主进程服务、原生模块和 helper 进程完成。

### 5.3 Extension Host 层

Cursor 内置扩展数量：

- Cursor：`111`
- VS Code：`93`
- Cursor-only：`21`
- VS Code-only：`3`

重要 Cursor-only 扩展：

| 扩展 | extensionKind | activationEvents | 作用推断 |
|---|---|---|---|
| `cursor-agent` | 未显式声明 | `*` | Agent SDK 主扩展，启动即激活 |
| `cursor-agent-exec` | 未显式声明 | `*` | Agent 执行路径 |
| `cursor-retrieval` | `workspace` | `onStartupFinished` | 代码检索 / 索引 / semantic search |
| `cursor-shadow-workspace` | `workspace` | `onStartupFinished` | Shadow workspace / 隔离工作区 |
| `cursor-browser-automation` | `ui` | `onStartupFinished` | 浏览器自动化 |
| `cursor-mcp` | `workspace` | `onStartupFinished`, `onUri` | MCP 集成 |
| `cursor-commits` | `workspace` | `onStartupFinished` | 提交/归因相关 |
| `cursor-always-local` | `ui` | `onStartupFinished`, `onResolveRemoteAuthority:background-composer` | 本地/remote authority 桥接 |
| `cursor-socket` | `ui` | `onResolveRemoteAuthority:background-composer`, `onStartupFinished` | socket / remote bridge |
| `cursor-resolver` | `ui` | `onResolveRemoteAuthority:background-composer` | 自定义 remote authority resolver |
| `cursor-file-service` | 未显式声明 | 无 main | file service package wrapper |

这是一种重要架构选择：Cursor 没有把所有 AI 功能直接塞进 Workbench Renderer，而是利用 VS Code 扩展模型，把部分功能放入 Extension Host。这样做的收益是：

- 扩展代码与主 UI Renderer 隔离。
- workspace 类型扩展可以靠近工作区文件系统和远程 authority。
- UI 类型扩展可以接入本地窗口/认证/URI。
- Agent、MCP、retrieval 可以使用 Extension Host 的生命周期与 IPC。

### 5.4 BrowserView / Webview 层

Cursor 主进程中存在：

- `vs/platform/browserView/electron-main/browserViewMainService.js`
- `vs/platform/browserView/electron-main/browserViewChannel.js`
- `vs/platform/webview/electron-main/webviewMainService.js`
- `vs/platform/webview/electron-main/webviewProtocolProvider.js`

Workbench 中存在 Browser Editor / Browser automation / CDP 相关模块。说明 Cursor 对网页/浏览器环境不是简单 iframe，而是使用 Electron 独立 WebContents 族能力：

- BrowserView/WebContentsView：适合真正网页导航、截图、CDP、焦点控制。
- Webview：适合扩展内容、Notebook renderer、Markdown/HTML sandbox。
- Workbench Renderer 只负责容器、遮罩、导航 UI、布局同步和用户交互。

这与 Onward 的 `electron/main/browser-view-manager.ts` 方向相似，但 Cursor 的浏览器层与 Agent/Composer/工具调用更深度绑定。

### 5.5 PTY / Terminal 层

Cursor 继承 VS Code 的 PTY Host：

- `vs/platform/terminal/electron-main/electronPtyHostStarter.js`
- `vs/platform/terminal/node/ptyHostService.js`

这种设计与 Onward 当前不同。Onward 直接在主进程 `PtyManager` 中通过 `node-pty` spawn 终端。Cursor/VS Code 则倾向把 PTY 管理拆成独立 host，降低终端 I/O、shell 集成和进程管理对主进程/Renderer 的影响。

### 5.6 Search / Retrieval / Indexing 层

Cursor 包含两类搜索能力：

- VS Code 基线搜索：`ripgrepHelper.js`、`@vscode/ripgrep`
- Cursor 自有 retrieval：`cursor-retrieval`、`@anysphere/file-service`、`crepectl`

`cursor-retrieval` 证据：

- 扩展体积约 `34M`
- 包含 `worker/dist/main.js`
- 包含 `@anysphere/file-service/file_service.darwin-universal.node`
- `.node` 是 Mach-O universal binary，支持 `x86_64` 和 `arm64`
- 字符串中出现 `crepe`、`index`、`postings.bin`、`metadata.json`、`gitoxide`、`codebase_snapshot`、`queryWithCallback`、`searchWorkers`、`indexWorkers`

推断：

- Cursor 的代码检索不是单纯 `ripgrep` 文本搜索。
- 它有独立的本地索引/快照服务，可能用 Rust/N-API 实现，涉及 Git tree、worktree、ignore 规则、postings index、metadata。
- retrieval 可以在 Extension Host / worker / native addon 多层之间分工。

这对 Onward 的启发是：如果未来做大规模项目索引，不应把索引构建和搜索排名放在 Renderer；应进入 main worker、utility process 或独立 native service。

## 6. Cursor 异构设计

Cursor 的本地包体现了明显的异构架构。

### 6.1 JavaScript / TypeScript / Electron

主要 UI、Workbench、主进程服务和扩展入口仍是 JS bundle：

- `out/main.js`
- `out/bootstrap-fork.js`
- `out/vs/workbench/workbench.desktop.main.js`
- `extensions/*/dist/main.js`

这些部分负责 UI、生命周期、IPC、协议适配、扩展注册和服务装配。

### 6.2 Chromium 多 WebContents

Cursor 使用 Electron/Chromium：

- BrowserWindow Renderer：主 Workbench。
- Webview：扩展内容、隔离 HTML 内容。
- BrowserView/WebContentsView：浏览器工具、网页导航、截图、CDP 相关功能。
- GPU Helper：图形加速隔离。

设计重点：把真实网页运行环境与 Workbench Renderer 分离。

### 6.3 Node / Extension Host / 子进程

Cursor 使用 Node 运行扩展、CLI、工具和子进程：

- `Cursor Helper (Plugin).app`
- `cursor-agent/dist/main.js`
- `cursor-agent/dist/claude-agent-sdk/cli.js`
- `child_process`、`spawn`、`fork`、`execFile` 字符串大量存在于 Agent SDK 和 retrieval 扩展中。

这说明 Agent 执行不是纯前端逻辑，具备启动进程、调用工具和运行本地 CLI 的能力。

### 6.4 Native Node Addon

Cursor 包内 native addon 包括：

- `node-pty/build/Release/pty.node`
- `@vscode/sqlite3/build/Release/vscode-sqlite3.node`
- `@vscode/spdlog/build/Release/spdlog.node`
- `@parcel/watcher/build/Release/watcher.node`
- `native-keymap/build/Release/keymapping.node`
- `keytar/build/Release/keytar.node`
- `cursor-proclist/build/Release/cursor_proclist.node`
- `@anysphere/policy-watcher/build/Release/vscode-policy-watcher.node`
- `@anysphere/file-service/file_service.darwin-universal.node`

这些组件承担终端、SQLite、日志、文件监听、键盘映射、密钥链、进程枚举、策略监听、检索索引等能力。

### 6.5 Rust / Mach-O Helper

Cursor 有 VS Code 没有的 helper：

- `resources/helpers/cursorsandbox`
- `resources/helpers/crepectl`
- `resources/helpers/node`

`cursorsandbox` 字符串证据显示：

- 使用 macOS `sandbox-exec` / seatbelt。
- 支持 `workspace_readwrite`、`workspace_readonly`、`insecure_none`。
- 有网络策略：allow/deny list、HTTP/SOCKS proxy、CONNECT、decision log。
- 有写入限制：`.git/config`、`.git/hooks`、`.cursorignore`、`.code-workspace`、`.vscode`、`.cursor` 等路径规则。
- 使用 Rust/Tokio/Hyper 风格网络栈。

`crepectl` 字符串证据显示：

- 与 `crepe` 索引、Git worktree、postings、metadata、commit、snapshot、gitoxide、rayon/tokio 相关。
- 更像 Cursor 的本地代码索引/检索控制工具。

这说明 Cursor 的安全与检索路径都不是纯 JS：它用 Rust/native 层处理更高风险或更重的系统任务。

### 6.6 WASM

Cursor 包内 WASM 包括：

- `tree-sitter.wasm`
- `tree-sitter-bash.wasm`
- `resvg.wasm`
- VS Code 基线的 tree-sitter / oniguruma / js-debug WASM

用途推断：

- 语法解析、shell 脚本解析、SVG 渲染、正则/语法高亮、调试相关任务。
- 这些适合从 JS 主线程隔离，或者作为 Worker / Extension Host / native service 的计算模块。

### 6.7 RPC / Protobuf / MCP

Cursor Workbench 中包含大量 protobuf/connect 模块：

- `proto/agent/v1/*`
- `proto/aiserver/v1/*`
- `mcp_connectweb.js`
- `chat_connectweb.js`
- `fastsearch_connectweb.js`
- `repository_connectweb.js`

这说明 Cursor 的 Agent/AI 能力以强类型 RPC 协议组织，而不是临时 JSON 调用堆积。对复杂 AI 工具链而言，这种协议层能降低 Renderer 与服务之间的耦合。

## 7. Onward 当前架构对比

### 7.1 Onward 已有的正确方向

Onward 的参考文档明确规定：

- Renderer 主线程只处理用户输入、DOM/UI commit、轻量状态切换。
- CPU 工作默认进入 Worker、utility process 或 main worker。
- Prompt 输入优先级最高。
- Terminal 输出必须批处理。
- 性能改造必须保留 Prompt input p95/p99/p999/max latency baseline。

当前代码中已经落地的边界：

| 能力 | Onward 当前实现 | 与 Cursor/VS Code 对应关系 |
|---|---|---|
| Renderer 优先级队列 | `src/utils/renderer-work-scheduler.ts` | 对应 Workbench 内部调度思想，但更轻量 |
| Terminal 输出调度 | `src/terminal/terminal-output-scheduler.ts` | 对应 VS Code terminal output batching 思路 |
| Prompt 输入抢占 | `src/terminal/input-priority-lane.ts` | 明确比 Cursor/VS Code 更聚焦 Prompt |
| Main work 调度 | `electron/main/main-work-scheduler.ts` | 对应主进程服务队列/背压 |
| Git Worker | `electron/main/git-ipc-worker-client.ts` | 对应 Git/SCM 从 Renderer 分离 |
| Git Status Worker | `electron/main/git-status-worker-client.ts` | 对应状态轮询分离 |
| Project FS Worker | `electron/main/project-fs-worker-client.ts` | 对应文件索引/搜索分离 |
| SQLite Worker | `electron/main/sqlite-worker-client.ts` | 对应数据库访问分离 |
| AppState Worker | `electron/main/app-state-worker-client.ts` | 对应持久化分离 |
| ripgrep Worker | `electron/main/ripgrep-search.ts` + `ripgrep-search-worker-entry.ts` | 对应 search worker / ripgrep helper |
| BrowserView | `electron/main/browser-view-manager.ts` | 对应 BrowserView/WebContents 隔离 |
| Trace 基建 | `infra/trace.md`、`src/utils/perf-trace.ts` | Cursor/VS Code 未必内置为 repo-first，但 Onward 对性能证据链更强 |

### 7.2 Onward 与 Cursor/VS Code 的关键差异

| 维度 | Cursor / VS Code | Onward 当前 |
|---|---|---|
| 主 UI | VS Code Workbench Renderer，成熟平台壳 | React/Electron 自研 UI |
| 扩展隔离 | Extension Host / Plugin Helper | 无 Extension Host |
| PTY 隔离 | PTY Host | 主进程 `PtyManager` 直接管理 `node-pty` |
| Shared Process | 有 | 无 |
| Utility Process | 有 `utilityProcess` 服务 | 当前主要用 Node Worker thread |
| Browser 隔离 | BrowserView + Webview 深度集成 | 有 WebContentsView 管理器，但功能较轻 |
| AI/Agent | Composer/Agent/MCP/RPC/扩展/native helper 多层 | 有 coding-agent runtime/config，但远轻于 Cursor |
| 代码索引 | `crepe` / `file-service` / `ripgrep` / Git tree snapshot | Project FS Worker + ripgrep，尚无 native semantic index |
| 安全沙箱 | `cursorsandbox` + network/filesystem policy | 主窗口 `sandbox: false`，BrowserView sandboxed |
| 性能观测 | 有 profiling 字符串与 Sentry/OTel | Onward repo 内 trace/Perfetto 更明确 |

### 7.3 Onward 当前缺口

这些缺口与 Onward 文档中的 P0/P1 基本一致：

- Markdown sanitization 仍在 Renderer：`ProjectEditor.tsx` 中 `DOMPurify.sanitize` 仍是 P0。
- Mermaid SVG 生成仍在 Renderer：`mermaidRenderer.ts` 属于 P1。
- ChangeLog Markdown parse/sanitize 仍在 Renderer：`ChangeLogModal.tsx` 属于 P1。
- Git Diff / Git History 大 payload 后处理仍可能在 Renderer 形成长任务。
- Project file preview 大文件转换虽然在 main，但 IPC payload 仍需严格上限。
- RendererWorkScheduler 当前只覆盖部分 UI 应用路径，尚未成为所有 Renderer 派生重工作的统一入口。
- 主窗口 `sandbox: false` 是现实约束，但从安全边界看弱于 Cursor/VS Code 的多 WebContents/多进程隔离。
- 终端 PTY 仍在主进程，不是独立 PTY host；当终端规模扩大时，主进程事件循环仍可能承压。

## 8. 横向对比：架构原则

### 8.1 Cursor 值得借鉴的点

1. 多边界而不是单边界：Cursor 同时使用 Renderer、Extension Host、Main、Utility、PTY Host、BrowserView、native addon、WASM、helper binary。
2. AI 功能分层：Composer UI 在 Renderer，Agent 执行在 Extension/Node/CLI/native/RPC 层，检索在 retrieval/native 层。
3. Browser 工具隔离：网页内容独立 WebContents，Renderer 只做容器和交互。
4. 检索服务独立化：代码库索引不依赖 Renderer，使用 native index 和 Git-aware snapshot。
5. 沙箱策略工程化：文件写入、网络访问、Git 配置等高风险操作有专门 helper 和 policy。
6. 协议显式化：Agent/AI/MCP 用 protobuf/connect 组织，降低大功能堆在 UI 状态里的风险。

### 8.2 Cursor 不适合直接照搬的点

1. 完整 VS Code Workbench 平台成本极高，不适合 Onward 当前规模。
2. Extension Host 适合开放插件生态；如果 Onward 没有插件平台，先用明确 service host 更划算。
3. Cursor 的 AI/Composer bundle 极大，照搬会增加启动成本、调试难度和安全面。
4. Native/Rust 检索服务需要长期维护 ABI、跨平台编译和许可证治理，不应在没有明确性能瓶颈前引入。
5. sandbox helper 需要威胁模型、策略语言、日志和用户可解释性，否则容易变成难调试黑盒。

### 8.3 Onward 应坚持的点

1. Prompt 输入优先级应继续高于所有 Task/Terminal/Git/Search 刷新。
2. Renderer 中必须保留的只有 DOM、Monaco、xterm.write、焦点、布局测量。
3. 所有可增长数据结构必须分页、切片、可取消。
4. 所有 Worker/IPC 服务必须有 timeout、dedupe、owner cancellation、per-repo concurrency。
5. 性能优化必须以 trace 为入口，而不是凭阅读代码猜瓶颈。

## 9. 对 Onward 的架构建议

### 9.1 短期：完成当前文档 P0/P1

优先级最高的不是引入新平台，而是完成已有迁移文档中的硬任务：

- 将 Markdown sanitize 移入 `markdownPreviewWorker` 或专门 sanitizer worker。
- 将 Mermaid SVG 生成移到后台，或至少按可见区域延迟生成。
- 将 ChangeLog Markdown parse/sanitize 移出 Renderer。
- 将 Git Diff / Git History 的大数组转换、分组、排序、diff 后处理移入 main worker，并让 Renderer 只消费分页结果。
- 对 Project preview 大文件设置 IPC payload 上限和流式/分页协议。
- 扩大 `rendererWorkScheduler` 覆盖面，把 global search apply、PromptList 大列表派生、Git result apply 都纳入统一队列。

### 9.2 中期：服务宿主化

Onward 可以不做完整 Extension Host，但建议抽象出清晰的 service host 层：

```text
Renderer
  -> Preload typed API
  -> Main IPC handlers
  -> MainWorkScheduler
  -> Service hosts:
       app-state worker
       git worker
       project-fs worker
       sqlite worker
       ripgrep worker
       markdown/sanitize worker
       terminal/pty host
       browser-view service
```

其中 PTY host 是下一个值得评估的边界。如果多任务终端、Git watch、shell output 同时高压，主进程直接管理所有 PTY 可能成为瓶颈。可以先不拆独立 Electron Helper，而是把 PTY 管理封装成可替换接口，为未来迁移到 utility process 或单独 Node child process 留接口。

### 9.3 中长期：检索与 Agent 执行层

如果 Onward 未来需要 Cursor 类检索能力，建议路线是：

- 第一阶段：增强当前 `project-fs-worker` 和 `ripgrep-search-worker`，增加索引缓存、ignore 策略、结果分页、取消和 per-root budget。
- 第二阶段：引入 main worker 内的轻量倒排索引，而不是直接上 native。
- 第三阶段：当 trace 证明 JS worker 不够，再考虑 Rust/native service。
- 第四阶段：Agent 执行如果需要文件写入和命令执行隔离，再设计 sandbox policy。不要先做 sandbox，再倒推需求。

### 9.4 安全边界建议

Onward 当前主窗口 `sandbox: false` 是为了现有 preload/native 能力，但这与 Cursor/VS Code 的多层隔离相比风险更集中。建议：

- BrowserView 继续保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。
- Renderer 不直接获得文件系统和进程能力，只通过 preload typed API。
- Coding agent / terminal / browser automation 的高风险操作必须走 main/service 层审计。
- 若未来支持自动修改文件或联网工具，应先建立最小 policy 和 trace log，再考虑 Cursor 式 sandbox。

## 10. 建议的 Onward 目标架构

```text
User Input / Prompt
  -> Renderer input lane
  -> Renderer visible UI commit
  -> xterm / Monaco / DOM only

Renderer background derivation
  -> RendererWorkScheduler
  -> visible-only batching
  -> cancellation on view switch

Preload API
  -> typed IPC
  -> request id / cancellation / timeout

Main process
  -> MainWorkScheduler
  -> per-root / per-repo / per-db concurrency
  -> trace counters at 1s granularity

Worker/service hosts
  -> Git IPC Worker
  -> Git Status Worker
  -> Project FS Worker
  -> ripgrep Worker
  -> SQLite Worker
  -> AppState Worker
  -> Markdown sanitize/render Worker
  -> future PTY Host
  -> future Code Index Host

Isolated WebContents
  -> BrowserView for web pages
  -> no Node integration
  -> explicit navigation/storage policy
```

这个目标架构比 Cursor/VS Code 更小，但保留同一原则：Renderer 不承担可增长工作，主进程不无限制并发，服务层可取消可观测。

## 11. 风险清单

| 风险 | 当前影响 | 建议 |
|---|---|---|
| Markdown sanitize 在 Renderer | 大 Markdown 可能卡 Prompt 输入 | 迁到 worker，Renderer 只挂载 safe HTML |
| Mermaid 在 Renderer | 图多时长任务明显 | 后台生成或可见区域生成 |
| Git Diff/History 大结果应用 | 大仓库可能造成 UI 卡顿 | worker 分页、Renderer 分批 apply |
| PTY 在主进程 | 多终端输出和 shell 管理可能压主事件循环 | 抽象 PTY host，后续拆 process |
| 主窗口 sandbox false | 安全面集中 | 限制 preload API，BrowserView sandbox，agent 操作走 policy |
| 缺少动态对比数据 | 无法证明优化收益 | 每次性能改造必须采 trace 和 before/after JSON |
| 未来 Agent 功能膨胀 | 容易把工具执行塞回 Renderer | 先定义 Agent service boundary 和执行权限 |

## 12. 最终判断

Cursor 的架构是「VS Code 多进程 IDE 平台 + AI/Agent 异构执行层」：主 UI 仍在 Workbench Renderer，但真正复杂的能力被分散到 Extension Host、BrowserView、PTY Host、native addon、Rust helper、WASM 和 RPC 协议层。它的核心价值不是某一个技术点，而是边界足够多、每个边界职责相对明确。

Onward 当前已经走在正确方向上：Worker 化、主进程调度、Renderer 调度、Terminal 输出批处理和 Perfetto trace 都已经存在。当前最重要的架构任务不是引入完整 VS Code 插件平台，而是把已知 P0/P1 Renderer 重任务迁完，并把现有 Worker/service 体系收敛成稳定、可取消、可观测的服务宿主模型。

本轮仓库变更是一份分析报告，不是代码实现。设计评价：这不是临时补丁，而是一次架构取证与方向校准。后续更优方向是把报告中的短期 P0/P1 迁移拆成可验证的工程任务，每个任务都带 trace baseline、自动测试和明确的 Renderer 责任缩减指标。
