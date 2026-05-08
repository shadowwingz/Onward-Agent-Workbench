# Git Diff Performance Diagnostics / Hunk Actions 当前状态

日期：2026-05-08
分支：`0429-bug-git-diff-cc`

## 1. 我们要做的事

本轮任务围绕 Git Diff 的性能诊断和 hunk 级操作体验，主要目标如下：

1. 让 `Performance Diagnostics` 成为全局调试开关：
   - 默认不显示。
   - 用户需要先在 Settings 里打开 `Performance Diagnostics`。
   - 环境变量只作为更高层的 feature gate，后续发布正式版本时可以直接关闭整个诊断入口。
   - 面板启用后默认折叠，并持久化用户的折叠/展开偏好。

2. 降低 Git Diff 诊断面板的信息噪声：
   - 去掉用户看不懂、对实际排查帮助不大的 `cwd` / `tid` 明细行。
   - 从普通面板里移除 `Watcher health` 展示，仅保留底层 telemetry 能力。
   - 重写 `List cache` 的说明，让它明确表示“Git Diff 文件列表请求缓存”，不是点击单个文件时的 content cache。
   - 增加 `Terms` 说明，解释 Last click、Content cache、List cache、Scheduler 等指标的含义。

3. 修复 Content cache 区域的可读性：
   - 项目路径 hover 时应快速显示完整路径。
   - entries hover 时显示该项目缓存的具体条目。
   - hover 延迟缩短到原先的一半，触发区域更直接。

4. 修复 hunk 级 `Stage` / `Revert`：
   - 在多个文件之间反复切换后，按钮不能消失。
   - `Revert` 必须真正应用到工作区文件。
   - inline 模式下按钮不能遮挡代码内容，因此改为 hover / focus 时显示。

5. 所有自动化测试必须有 watchdog：
   - 单个 runner 超过 180 秒视为失败。
   - 失败后输出持久化日志，避免靠人工观察实时输出判断。

## 2. 解决思路

### 2.1 Performance Diagnostics 全局开关

新增持久化设置 `performanceDiagnosticsEnabled`，默认值为 `false`。

设置入口放在 Settings 的 `Diagnostics` 区域。Git Diff 面板渲染时同时检查：

1. 全局 setting 是否打开。
2. feature flag / 环境变量 hard gate 是否允许。

这样正式版本可以通过 feature flag 关闭整个功能，而日常开发中用户也可以自己决定是否显示诊断面板。

### 2.2 面板信息重构

`Performance Diagnostics` 面板从“默认展示大量内部字段”调整为“默认折叠、按需展开、术语可解释”：

- 删除可见的 `cwd` / `tid` 行。
- 删除普通 UI 里的 `Watcher health` 区块。
- `List cache` 改为展示：
  - resident list count
  - idle / in-flight 状态
  - last request 类型
  - hit rate / miss / force
  - TTL
  - key 与 entry age at request
- `Terms` 里说明 List cache 只会在 Git Diff 打开、刷新、TTL 到期、mutation invalidation 等路径变化；单纯点击不同文件不会必然改变它。

### 2.3 Content cache 策略与展示

Content cache 仍表示 main process 中缓存的 per-file diff body：

- 缓存内容：`originalContent`、`modifiedContent`、图片/预览相关内容以及 cache metadata。
- 用途：避免用户切换 diff 文件时反复从 Git / 文件系统读取大文件内容。
- 项目级容量：最多 8 个项目，每项目约 100 MB。
- 项目顺序：近期访问优先，用户进入某项目查看 Git Diff 时，该项目被移动到队列头部；第 9 个项目被淘汰。
- 项目内条目淘汰：继续按大小优先淘汰较小条目，保证项目内容量上限。

UI 中不再强调“流逝时间”作为策略依据，主要展示容量、条目数、队列顺序和 hover 明细。

### 2.4 Hunk action 稳定性

Hunk action 的核心修复有三层：

1. 工具条生命周期：
   - 由 Monaco diff line changes 安装 content widget。
   - 初始隐藏，仅 hover / focus 时显示。
   - 文件切换、diff 更新、关闭时清理旧 widget，再按当前文件重新安装。

2. 点击行为：
   - DOM button 仍是真实用户路径。
   - 点击后保存最近一次 hunk action promise，autotest 可等待该 promise 完成，避免用固定 sleep 或 polling 猜异步完成。

3. 写入基准：
   - hunk action 是写操作，不能依赖可能过期的 renderer / main content cache。
   - 执行前强制 fresh `getFileContent(force: true)`，用当前 Git/index/worktree 内容计算下一份内容。
   - 如果 Monaco EOF 附近 line number 与 `@pierre/diffs` 的行号存在漂移，则 `buildContentWithChangeRange` 先尝试精确 line range 命中；整份 diff 都无法命中时，才按 hunk index 做兜底。

## 3. 遇到的问题

### 3.1 用户看不懂 List cache

最初面板里的 List cache 指标几乎不动，容易被误解为“点击文件时应该变化”。实际它缓存的是 Git Diff 文件列表请求，不是文件正文缓存。解决方式是改 UI copy 和 Terms，让它明确说明触发条件。

### 3.2 诊断面板默认可见过于打扰

Performance Diagnostics 是调试功能，不应默认占据普通用户界面。已改为 Settings 里手动打开，且默认折叠。

### 3.3 Watcher health 对用户价值低

Watcher health 对实现者排查 watcher 是否活着有用，但对普通使用者没有直接解释价值。已从面板移除，底层数据仍可保留给 debug API / trace 使用。

### 3.4 Hunk Revert 偶发无效

排查过程中遇到几类问题：

1. React state 闭包滞后：
   - DOM button 属于当前文件，但 click handler 里的闭包可能还拿着上一轮 `selectedFile`。
   - 已改为 action 执行时读取 `selectedFileRef` 和 `fileContentsRef`。

2. 缓存内容过期：
   - 即使 action 返回 success，如果计算基准来自旧 content cache，写回后的文件仍可能保持 modified。
   - 已改为写操作前强制 fresh 读取当前 Git 内容。

3. EOF line drift：
   - Monaco line change 在文件末尾附近可能给出第 4 行，而 diff 内容实际只有 3 行。
   - 已增加 hunk index 兜底，但只在整份 diff 没有任何 line range 命中时启用，避免同一个 diff hunk 内多个 change block 被误全选。

4. 测试误判：
   - Revert 后文件列表刷新期间会短暂为空，旧测试把“README 不在空列表里”误判为 Revert 完成。
   - 已改为等待列表重新填充，并同时确认 README 消失、parent unstaged 仍存在。

### 3.5 GDS runner 一度超过 180 秒

GDS 曾在 hunk action 路径卡到 180 秒 watchdog。修复后：

- GDS 单跑：`46/46`，约 35 秒。
- 最终子集回归中 GDS：`46/46`，约 33 秒。

## 4. 当前验证状态

已通过：

- `pnpm typecheck`
- `rm -rf out release && ONWARD_DIST_DEV_OPEN=0 pnpm dist:dev`
- `run-git-diff-click-latency`：`16/16`
- `run-git-diff-staleness-and-submodule`：`46/46`
- `run-settings-update`
- `run-trace-infra-self-check`
- `run-unittest-suite`

最终子集回归：

```bash
python3 test/autotest/run-full-regression.py \
  --app-bin "release/mac-arm64/Under Development 2.0.1-0429-bug-git-diff-cc.app/Contents/MacOS/Under Development 2.0.1-0429-bug-git-diff-cc" \
  --only run-settings-update \
  --only run-unittest-suite \
  --only run-trace-infra-self-check \
  --only run-git-diff-click-latency \
  --only run-git-diff-staleness-and-submodule
```

结果：

- Passed: 5
- Failed: 0
- Skipped: 1

最新 self-check trace：

```bash
bash infra/scripts/open_trace.sh traces/perf/perf-trace-2026-05-07T11-24-08-335Z-50069.json
```

## 5. 当前工作树状态

当前工作树仍有大量未提交改动，包含本轮和前序 Git Diff 性能诊断工作。未执行 commit。

关键改动区域：

- `src/components/GitDiffViewer/*`
- `src/components/Settings/*`
- `src/contexts/SettingsContext.tsx`
- `src/i18n/core.ts`
- `src/types/electron.d.ts`
- `src/types/settings.d.ts`
- `electron/main/*`
- `electron/preload/index.ts`
- `docs/debug-env-variables.md`
- `docs/git-diff-performance-diagnostics.md`
- `test/autotest/*`
- `test/unittest/*`

## 6. 后续建议

1. 抽象通用 Diagnostics shell：
   - 目前 Git Diff 已经有完整诊断面板，但还不是全局通用容器。
   - 后续可以抽出统一的 diagnostics host，再让 Git Diff、Project Editor 等模块挂载自己的 panel。

2. 清理 debug UI copy 和无用 CSS：
   - Watcher health 可见 UI 已移除，但部分旧 i18n / CSS key 可能还可以进一步清理。

3. 复查 cache invalidation 的跨平台细节：
   - 当前方案通过显式 mutation invalidation + watcher invalidation 双保险。
   - Windows / Linux / macOS 的 watcher 行为仍建议在三平台 CI 或手动 smoke 中持续验证。

4. 评估是否保留 autotest-only debug promise API：
   - `waitForLastHunkActionForTest` 能让测试等待真实 DOM click 触发的 action 完成。
   - 它是测试稳定性辅助 API，生产 UI 不使用；后续可以集中放入 debug namespace 的测试专用分组。
