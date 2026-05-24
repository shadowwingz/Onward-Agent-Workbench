<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# review-20260524-141850-claude-opus-47-ftrq 评审处理计划

## 背景与输入

- 触发模式：`ts_handoff review review-20260524-141850-claude-opus-47-ftrq`
- 分析时间：2026-05-24 14:47:28 +0800
- 工程目录：`/Users/yingyun/Projects/Onward-Agent-Workbench`
- 当前分支：`master`
- HEAD：`819d346`
- HANDOFF：`/Users/yingyun/Projects/Onward-Agent-Workbench/HANDOFF.html`
- 指定 review：`review-20260524-141850-claude-opus-47-ftrq`
- 停止点：本 PLAN 仅供使用者决策；本次未执行代码修改，未写回 `HANDOFF.html`。

## 事实依据

### HANDOFF 差异点

- `git-diff-freshness`：状态 `in_progress`，剩余 3 个验证项。
- `git-large-file-confirmation`：状态 `in_progress`，剩余 2 个验证项。
- `project-editor-large-file-policy`：状态 `in_progress`，剩余 2 个验证项。
- `git-worker-dedupe-options`：状态 `in_progress`，剩余 2 个验证项。

### Git 摘要

- `git status --short` 显示 33 个已修改 tracked 文件，另有大文件确认相关新增文件和未跟踪 `HANDOFF.html`。
- `git diff --stat 819d346` 显示 33 个 tracked 文件变更，约 `1204 insertions / 219 deletions`。
- `git log --oneline -10 --since='2026-05-24 14:18:50 +0800'` 无输出，说明指定 review 之后没有新 commit。

### 指定 Review 摘要

- Reviewer：`claude-opus-47-ftrq`
- Verdict：`needs_fix`
- 计数：`0 blocker / 0 major / 7 minor / 7 nit`
- 原总结：核心 freshness、大文件确认、worker dedupe 方案总体正确，但合入前建议处理三类问题：
  1. `gitBlobMaxBuffer` 在 size 解析失败时回退到 `Number.MAX_SAFE_INTEGER`，存在无界读取风险。
  2. `confirmLargeText` 已变成死参数但仍保留在 Project Editor / preload / types 链路。
  3. `largeFileConfirmRef` 在 unmount / cwd switch 时不主动 cancel，可能导致 Promise 挂起。

## 值得做的项

### P1：收紧 Git blob 读取 buffer 上限

- 来源：指定 review 的 minor finding。
- 位置：`electron/main/git-utils.ts:2401`
- 现状：`gitBlobMaxBuffer(sizeBytes)` 在 `sizeBytes` 非有限或小于 0 时返回 `Number.MAX_SAFE_INTEGER`。
- 为什么值得做：这是实际内存风险点；异常 `git cat-file -s` 输出或未来调用传入异常 size 时，会绕过 3 MB 大文件保护，允许极大 blob 被读入内存。
- 建议方案：把异常 size 的 fallback 改成有限 safety cap，例如 `GIT_LARGE_FILE_CONFIRM_SIZE + GIT_FILE_READ_BUFFER_MARGIN`，并保留正常 size 下的 margin。
- 风险：如果 fallback 太小，可能影响无法读取 metadata 但实际很小的合法 blob；需要用单测锁住 fallback 行为。
- 验收方法：新增或扩展 unit 覆盖 `sizeBytes = null / undefined / NaN / -1`，确认 maxBuffer 是有限值；`pnpm test:unit` 通过。

### P2：在 Git Diff / Git History 关闭或切换时 cancel 大文件确认

- 来源：指定 review 的 minor finding。
- 位置：`src/components/GitDiffViewer/GitDiffViewer.tsx:3376`、`src/components/GitHistoryViewer/GitHistoryViewer.tsx:816`
- 现状：只在用户点击取消或 debug API 调用时执行 `settleLargeFileConfirmation(false)`；未看到 unmount、关闭面板、cwd/repo switch 时的 cleanup。
- 为什么值得做：pending Promise 不 settle 会让 `ensureFileContent` / history content load 悬挂，后续状态可能停留在 loading 或保留过期确认框。
- 建议方案：在两个 viewer 各自添加 cleanup effect；当 `isOpen` 变为 false、`activeCwd` / repo selection 变更、组件 unmount 时调用 `settleLargeFileConfirmation(false)`。
- 风险：cleanup 不能误伤用户刚点击确认后的二次加载；需要确保 cleanup 只处理当前 pending confirmation。
- 验收方法：扩展 `run-git-large-file-confirmation-autotest.sh`，覆盖确认框出现后关闭面板 / 切换 repo / 切换 cwd，断言确认框消失且后续加载不挂起。

### P3：删除 Project Editor 的 `confirmLargeText` 死参数

- 来源：指定 review 的 minor finding。
- 位置：`electron/main/project-editor-utils.ts:43`、`src/components/ProjectEditor/ProjectEditor.tsx:4491`、`src/components/ProjectEditor/ProjectEditor.tsx:4548`、`electron/preload/index.ts:595`、`src/types/electron.d.ts:529`
- 现状：Project Editor 新策略已不再需要大文本确认，但 `confirmLargeText` 仍在 API、preload logging 和 renderer readOptions 中出现。
- 为什么值得做：死参数会误导后续维护者，以为 3 MB+ 文本仍有确认分支；还会让测试覆盖看起来比真实策略更复杂。
- 建议方案：删除 `ProjectReadOptions.confirmLargeText`、renderer readOptions 字段、preload log 字段、类型声明字段；保留 `openMode`。
- 风险：如果存在外部脚本或 autotest 仍传该字段，需同步更新调用面。
- 验收方法：`rg -n "confirmLargeText" electron src test` 无生产链路残留；`test/unittest/project-editor-large-file-policy.test.mts` 与 Project Editor 大文件 autotest 通过。

### P4：修正 `stableStringifyForWorkerKey(undefined)` 的类型契约

- 来源：指定 review 的 minor finding。
- 位置：`electron/main/git-ipc-worker-client-helpers.ts:26`
- 现状：函数声明返回 `string`，但基础分支直接返回 `JSON.stringify(value)`；`value === undefined` 时实际返回 `undefined`。
- 为什么值得做：当前模板字符串会把它隐式转成 `"undefined"`，行为暂时可用，但类型签名不诚实，后续复用可能产生 undefined key。
- 建议方案：显式处理 `undefined`，返回字符串 `"undefined"`；同时加 unit 锁定。
- 风险：如果已有 key 曾依赖隐式 coercion，显式返回 `"undefined"` 与当前模板字符串最终值一致，风险低。
- 验收方法：`test/unittest/git-ipc-worker-client.test.mts` 增加 undefined case；`pnpm test:unit` 通过。

### P5：统一大文件阈值文案与错误编码策略

- 来源：指定 review 的 nit finding。
- 位置：`src/i18n/core.ts:2264`、`src/i18n/core.ts:2266`、`electron/main/git-utils.ts:2383`
- 现状：英文使用 `3 MB`，中文使用 `3MB`；main process 返回硬编码英文 `The current diff exceeds 3 MB.`。
- 为什么值得做：i18n 不一致是低成本修复；main 返回硬编码英文虽然多数路径会被 renderer 本地化覆盖，但错误直出时仍可能泄漏英文。
- 建议方案：中文统一成 `3 MB`；main process 长期建议返回 stable error code 或 metadata，由 renderer 负责文案。
- 风险：改 main error contract 需要同步 renderer / tests；本轮可先做文案统一，把 error code 设计列为后续。
- 验收方法：英文、中文 key 都存在且阈值格式一致；大文件 cancel autotest 对 en / zh-CN 的断言不再兼容无空格旧写法。

### P6：补齐合入前验证闭环

- 来源：HANDOFF §6 incomplete items。
- 目标：不要把四个差异点状态从 `in_progress` 提前切到 `stable`。
- 为什么值得做：当前 HANDOFF 明确列了 unit、autotest、build/startup 仍未完成；这些是合入前的硬验收。
- 建议方案：在完成 P1-P5 后按“最终验收方法”执行，不在 PLAN 阶段运行。
- 风险：项目规则要求 autotest 前先 build，且 `pnpm dist:dev` 会打开 packaged app；执行者必须遵守 exact process name kill/open 规则。
- 验收方法：见本文“最终验收方法”。

## 不值得立即做的项

### D1：暂不优化 Git History 的额外 file-content IPC

- 来源：指定 review 的 minor finding。
- 位置：`src/components/GitHistoryViewer/GitHistoryViewer.tsx:877`
- 不立即做的原因：该路径虽然多一次 IPC，但同时把内容结果写入 `fileContentCacheRef`，能服务后续正文查看；若改成单独 size probe，需要新增 main/worker API，风险超过当前收益。
- 重新考虑条件：trace 显示 Git History 大文件点击存在可感知延迟，或用户明确要求减少该 IPC。
- 验收方法：若以后要做，必须先采集点击链路 trace，再以 latency 前后对比验收。

### D2：暂不抽取重复的 `formatLargeFileSize`

- 来源：指定 review 的 nit finding。
- 位置：`src/components/GitDiffViewer/GitDiffViewer.tsx:157`、`src/components/GitHistoryViewer/GitHistoryViewer.tsx:75`
- 不立即做的原因：重复函数很小，行为一致；抽取会触碰共享路径和 imports，收益偏低。
- 重新考虑条件：后续继续改大文件确认 UI 或需要新增第三个调用点。
- 验收方法：抽取时用 unit 或轻量 renderer helper test 覆盖 B/KB/MB/GB 和边界值。

### D3：暂不改 mirror 双路径 invalidation

- 来源：指定 review 的 minor finding。
- 位置：`electron/main/git-state-mirror-router.ts:316`
- 不立即做的原因：`new Set([cwd, repoRoot])` 已避免完全相同路径重复；cwd 与 repoRoot 不同可能是刻意覆盖子目录 / repo root 两种订阅键。没有 trace 证据前不应改变 invalidation fan-out。
- 重新考虑条件：perf trace 证明同一次 mirror update 触发重复 renderer invalidation 并造成明显延迟。
- 验收方法：先补 trace 计数，再确认去重后不会漏掉 subdir / submodule 场景。

### D4：暂不统一空 fingerprint 常量

- 来源：指定 review 的 nit finding。
- 位置：`electron/main/git-state-mirror-worker-entry.ts:325`、`electron/main/git-state-mirror-worker-entry.ts:380`
- 不立即做的原因：`''` 与 `'unknown'` 是可读性问题，不影响当前 change fingerprint 判定路径。
- 重新考虑条件：后续继续整理 mirror worker metadata 或增加 fingerprint schema 校验。
- 验收方法：单测覆盖 meta 缺失与 failure 两条路径的展示 / diff 行为。

### D5：暂不调整 `allowedLargeFileKeysRef` 的 Diff / History 记忆策略

- 来源：指定 review 的 uncovered risk。
- 位置：`src/components/GitDiffViewer/GitDiffViewer.tsx`、`src/components/GitHistoryViewer/GitHistoryViewer.tsx`
- 不立即做的原因：这是产品行为选择，不是明确 bug。Git Diff 对当前工作区文件“一次同意后记住”，Git History 按 commit range 重新提示，两者可能都有合理性。
- 重新考虑条件：产品明确要求“每次都提示”或“同一文件跨 range 记住”。
- 验收方法：先写清行为规格，再补 autotest 覆盖同一文件二次打开和不同 commit range。

### D6：暂不处理 repoRoot fallback dedupe race

- 来源：指定 review 的 uncovered risk。
- 位置：`electron/main/git-ipc-worker-client-helpers.ts`
- 不立即做的原因：当前只是理论风险；调用面大多能稳定给出 repoRoot。直接改 key 可能降低 dedupe 命中或误合并不同 repo。
- 重新考虑条件：发现 repoRoot resolve 抖动导致重复 worker task，或 trace 看到同一文件短时间重复读取。
- 验收方法：用 worker enqueue 集成测试覆盖 repoRoot 有无两种调用是否符合预期。

## 需要先澄清的项

1. 大文件确认记忆策略：Git Diff 是否应该像 Git History 一样按 range / revision 重新提示，还是保持当前工作区文件级记忆。
2. main process 大文件错误是否要改为 error code：如果改，需要同步 renderer i18n 和 autotest 断言。
3. `PROJECT_TEXT_WARNING_SIZE` 是否作为兼容常量保留：如果保留，应加 deprecated 说明；如果删除，需要确认没有外部调用依赖。

## 建议执行顺序

1. 先做 P1、P4：都是低范围纯逻辑修复，可用 unit 快速锁定。
2. 再做 P2：涉及 renderer 生命周期和 E2E，需要补 autotest。
3. 再做 P3、P5：清理死参数和文案，注意同步 preload/types/i18n。
4. 最后做 P6：按完整验收跑 unit、autotest、build/startup，并根据结果决定是否刷新 HANDOFF。

## 最终验收方法

授权后真正修改代码时，建议按以下顺序验收：

1. 纯逻辑检查：
   - `pnpm test:unit`
   - 重点关注 `git-large-file-policy.test.mts`、`git-ipc-worker-client.test.mts`、`project-editor-large-file-policy.test.mts`、Git diff cache / mirror 相关测试。
2. 开发包构建与启动：
   - `rm -rf out release && pnpm dist:dev`
   - 构建后确认应用能正常启动并进入主 UI；如果需要手动启动，必须先用 exact process name `pkill -x "<exact-process-name>"` 清理同名主进程。
3. Autotest：
   - `test/autotest/run-git-large-file-confirmation-autotest.sh`
   - `test/autotest/run-git-diff-staleness-and-submodule-autotest.sh`
   - `test/autotest/run-project-editor-large-file-autotest.sh`
4. 文案与接口检查：
   - `rg -n "confirmLargeText" electron src test` 不应再命中生产链路。
   - `rg -n "3MB|3 MB" src/i18n/core.ts src/autotest/test-git-large-file-confirmation.ts` 确认 en / zh-CN 文案格式按决策一致。
5. HANDOFF 决策：
   - 若使用者确认上述改动并验收通过，再单独运行 `/ts_handoff` 刷新 HANDOFF。
   - 本 PLAN 不自动写回 HANDOFF，也不代表已完成任何代码改动。
