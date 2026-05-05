# Git Diff 性能诊断面板 — 工作进展（2026-05-05）

本文件记录 `0429-bug-git-diff-cc` 分支当前轮次的工作总结，以及需要继续打磨的事项。提交说明可以基于此撰写。

## 一、已完成的工作

### 1. UI / 交互修复
- Hunk 级 Stage / Revert / Unstage 改成永久按钮工具栏（之前 hover 才出现）。
- File-list ↔ detail 分隔条 + Monaco split sash 永久可见。
- Side-by-side / Inline / Auto 三态切换，本地存储全局持久化。
- 顶部操作组（toggle + change-nav + jump-to-editor + refresh）移到 working-directory 行。
- File-level 按钮标签：`Stage File / Revert File / Unstage File / Delete File / Keep File Staged`。
- 抑制 `git-diff-restore-banner`（仍 abort 滚动恢复，但不再弹提示）。
- 关闭 Monaco 自带 `renderGutterMenu` 的箭头。

### 2. 主进程缓存基础设施
- **Content cache**：`electron/main/git-diff-content-cache.ts`，per-project 100 MB × 8 project，单文件 10 MB 上限；项目内 smallest-first 淘汰、项目间 LRU。
- **Precompute scheduler**：`electron/main/git-diff-precompute-scheduler.ts`，debounce 100 ms + 6 路并发 + 100 候选；按 `additions+deletions DESC` 排。
- **Wiring**：`electron/main/git-diff-content-cache-wiring.ts`，把 `gitDiffCacheInvalidator` / fetcher / 调度器串起来。
- **List cache**：`electron/main/git-diff-request-cache.ts`（已有）+ 新增 `inspectStats()` 暴露 hits/misses/forces/entries/inFlight/TTL。
- **Mutation IPC 显式失效**：stage/unstage/discard/save/updateIndex 之后主动 `invalidateProject`，因为 fs.watch 排除了 `.git/**`。

### 3. 点击延迟 tracker + perf trace
- `src/components/GitDiffViewer/clickLatencyTracker.ts`：7 个时间点 click → ipcStart → ipcEnd → stateSet → editorReady → diffComputed → paintReady。
- 6 个 phase span perf trace 事件（`renderer:git-diff.click-phase.*`，`ph='X'`，payload 带 `durationMs / cwd / terminalId / fileKey / cacheState / totalMs`）。
- 事件名常量收口在 `src/utils/click-phase-event-names.ts`（leaf 模块），`perf-trace-names.ts` + 单测 + 发射器都从那里 import，避免双份字符串漂移。
- `infra/trace.md` § 2 同步。

### 4. In-app 性能诊断面板
- `src/components/GitDiffViewer/GitDiffDebugPanel.tsx`：常驻在 working-dir 行下方，默认展开，本地存储 `git-diff-debug-panel-collapsed`。
- 5 个分区：
  1. **Last click**：5 段彩色 phase 条 + legend（IPC fetch / State set / Monaco mount / Diff compute / Paint）+ cache hit/miss + total。
  2. **Aggregate**：count / hit-rate / p50 / p95 / max / cancelled，下面再附每段均值。
  3. **Content cache**：每 project 用量 / entries / LRU 顺序，当前 cwd 高亮。
  4. **List cache**：entries / hit-rate / misses / forces / in-flight / TTL。
  5. **Scheduler**：bursts / in-flight / pending / completed / cancelled / skipped。
  6. **History**：最近 30 次点击的堆叠柱状图，hover 看 filename / total / cacheState。
- 折叠时停止主进程 stats 轮询（避免无意义 IPC）；展开时清掉旧 stats。
- 三条渲染分支（SubpagePanelShell / external-panel / 旧 modal）都挂上同一个 panel 实例，避免漏渲染。

### 5. 关键 bug 修复
- **placeholder onDidUpdateDiff 抢跑**：未缓存文件首次点击时 Monaco 会先对空 placeholder 触发一次 `onDidUpdateDiff`，被 tracker 当成 diffComputed 锁定，真实内容到达时被去重忽略，导致面板显示「几十毫秒」而实际等了几秒。修法：
  - `markDiffComputedIfReal` 改成 gate 在 tracker 自己的 `stateSetAt`（不是 lagging 的 `fileContentsRef`）。
  - cached early-return 路径里也调用 `markStateSet`，否则缓存命中的点击永远过不了门槛。
- **rAF 在窗口失焦时被节流**：autotest 跑起来时窗口不在前台，paintReady 永远 seal 不上。修法：
  - `markDiffComputed` 在 rAF 之外同时排一个 `setTimeout(seal, 80)` 兜底，先到先封口、`sealed` 标志位防止重复 seal。
  - autotest 进来第一件事调 `electronAPI.debug.focusWindow()`，并 log `document.visibilityState / hasFocus`。

### 6. 自动化自验证
- autotest 加了独立的外部测量（`MutationObserver` 监 `.monaco-diff-editor`，固定 cap = 7000 ms，记录最后一次 mutation 时间），跟 tracker.totalMs 配对生成 `gdcl:tracker-vs-external-json`。
- 跑了 8 个文件后的对照（窗口聚焦下）：
  - 慢文件（5400 ms 渲染）：tracker 跟 observer 差 0 ~ 0.2 ms（毫秒级一致）。
  - 快 cached 文件（60–200 ms tracker / 6–15 ms observer）：tracker 偏高 50–200 ms，是 *DOM committed* vs *Monaco onDidUpdateDiff + 下一帧 rAF* 之间的固有 gap，不是 bug。

### 7. 测试 / 文档
- 新增单元测试：8 个 suite（content cache、precompute scheduler、click latency tracker、Monaco 语言映射、hunk actions、request cache、state mirror worker core、project-editor diff jump state）+ debug aggregator + click-phase 事件发射器，**66/66 全部通过**。
- 新增 autotest：`run-git-diff-click-latency-autotest.sh` 走整个工作集 + 强制 6 个 phase 事件落盘的回归 gate。
- i18n：en + zh-CN 都补齐 28+ 个 `gitDiff.debug.*` key。
- 提交了一次 "Add per-project diff content cache, click-latency tracking, UI polish"（commit `2026-05-05` 之前那一笔，34 files +4696 / -1265）。

---

## 二、用户实测仍然有问题（待修）

> 用户原话：「有的时候甚至启动了 4 秒，但是你这边直接显示 Paint 才十几毫秒，这显然是你拆分的力度不够，要么就是你漏掉了许多关键的操作部分。」

也就是说 tracker 现在在某些路径下还是低估了真实等待。最可能的原因：

1. **Monaco 的语法 tokenize 是 post-paint 的**：`onDidUpdateDiff` 触发 → 我标记 `paintReadyAt`，但语法颜色其实是后续多帧通过 `onDidChangeTokens` 流式涂上去的。用户看到的「彩色 diff」时间晚于我认定的 paintReady。
2. **Monaco worker 冷启动**：第一次打开 diff editor 时 worker / theme / 语言模块的 lazy-load 可能耗几百毫秒到几秒，没有被独立测量。
3. **首次 DiffEditor mount 太慢**：`handleEditorDidMount` 只在第一次发火，Mount phase 在后续点击全是 null —— 但首次 mount 本身的耗时可能就是用户感知的 3–4 秒，需要单独抓。
4. **language 模块 lazy-load**：第一次点 Python / Go / TS 文件时 Monaco 才 fetch 该语言，这段是 paintReady 之后的事情，不在我现有 phase 里。
5. **Hunk widget 安装错误**：测试日志里出现过 `startLineNumber 3266 cannot be after endLineNumberExclusive 2165`，可能让某些文件的渲染卡住，需要单独排查。
6. **从 Git Diff 子页面被打开 → 列表 ready → 第一次点击** 之间也有耗时，但 tracker 是 per-click 的，没盖到「首次开启子页面」这段。

---

## 三、接下来的任务

### 高优先级（直接对齐用户感知）

1. **新增 "tokenize-settle" phase**
   - 在 `markDiffComputed` 之后挂 Monaco 的 `IModel.onDidChangeTokens` 监听器（original + modified 两侧）。
   - 当 tokens 不再变化（quiet 窗口 100 ms）或到达 cap（5000 ms）时记录 `tokenizeSettleAt`。
   - panel 加第 6 段「Settle」，total = paintReadyAt → tokenizeSettleAt。
   - 如果用户感知的「4 秒」其实是 tokenize 时间，这段会显示出来。

2. **抓首次 DiffEditor mount 冷启动**
   - 新增独立信号：`RENDERER_GIT_DIFF_EDITOR_FIRST_MOUNT_MS`，在 `handleEditorDidMount` 第一次执行时记录从 `git-diff:open` 事件到 mount 完成的耗时。
   - panel 在 cold-start 那一次显示「Cold mount: Xms」单独行。

3. **细化现有 phase**
   - **Mount phase 拆**：现在的 Mount = stateSet → editorReady。可以拆成 *react-commit*（stateSet → effect-flush）+ *monaco-swap-model*（effect-flush → DiffEditor.setModel done）+ *editor-ready-event*。
   - **Diff compute 拆**：从 `editorReady` → `onDidChangeModelContent`（modified 侧）+ `onDidUpdateDiff`，分别抓「Monaco 接收新内容」和「diff 算法跑完」两个时间点。

4. **修 hunk widget 的范围错误**
   - 排查 `startLineNumber > endLineNumberExclusive` 的来源（八成在 `gitDiffHunkActions.ts` 的范围计算里），写一个最小复现测试。
   - 这个 bug 让某些文件渲染卡住，autotest 跑下来某些文件直接变 cancelled。

### 中优先级（数据完整度）

5. **autotest 的 fast-path 50–200 ms gap**
   - 慢路径已经毫秒级一致，快路径 tracker 比 observer 系统性高 50–200 ms。
   - 如果加了 tokenize-settle 之后 gap 没消，需要在 panel 里把 *click → DOM committed* 跟 *click → onDidUpdateDiff fired* 的差也单独标出来，而不是把它和 rAF 混在一起。

6. **去掉 autotest 的 self-validation cap**
   - 现在 cap=8 是迭代用的；定稿后改回 `candidates.length`，让 full-regression 跑全集。
   - 同时把 `gdcl-tracker-vs-external-within-50ms` 这个断言收紧到合理阈值（例如慢路径 ≤ 5 ms，快路径 ≤ 200 ms）。

7. **Windows runner 补齐**
   - `run-git-diff-click-latency-autotest.sh` 已写，但缺 `.ps1`；CLAUDE.md 要求三平台同步。

### 低优先级（清理）

8. **事件名常量两份冗余**：已经收口到 `src/utils/click-phase-event-names.ts`，但 `clickLatencyTraceEmitter.ts` 还 re-export 了一份（向后兼容）。如果没人引用 emitter 那侧的常量，可以删掉。

9. **panel 默认可见性**：当前默认对所有用户可见。可以考虑：dev build 默认展开，prod build 默认折叠（需要的时候再展开），或者直接做成 `ONWARD_GIT_DIFF_DEBUG=1` env / 设置项控制。

10. **panel 状态接进 `__onwardGitDiffDebug`**：让 autotest 可以直接读 panel 当前显示的内容（现在是间接通过 tracker.getHistory() 推算）。

11. **i18n / 文档**
    - tokenize-settle / cold-mount 加进去之后，i18n 同步加 key（en + zh-CN）。
    - `infra/trace.md` § 2 加新事件行。

---

## 四、当前未提交的改动概览

未提交：本轮自验证迭代涉及的 `src/autotest/test-git-diff-click-latency.ts`、`src/components/GitDiffViewer/{GitDiffViewer.tsx, clickLatencyTracker.ts, GitDiffDebugPanel.tsx, GitDiffDebugPanel.css}`、`src/components/GitDiffViewer/GitDiffViewer.css` 等等。

已提交：上一轮的 34 个文件 +4696 / -1265（content cache + 监测信号 + 单测 + autotest + 文档）。

---

## 五、复现 / 验证步骤

```bash
# 重建
rm -rf out release && pnpm dist:dev

# 自验证 autotest（窗口必须聚焦，否则 rAF 节流）
bash test/autotest/run-git-diff-click-latency-autotest.sh

# 关键比对字段
grep "gdcl:tracker-vs-external-json" traces/test-logs/git-diff-click-latency-autotest.log
grep "gdcl:walk-done" traces/test-logs/git-diff-click-latency-autotest.log

# 查看面板：启动应用后，在 Git Diff 子页 working-directory 行下方
open "/path/to/.app"
```

延迟 trace 直接 Perfetto 查看：

```bash
bash infra/scripts/open_trace.sh traces/perf/<newest>.json
```
