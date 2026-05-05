<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Current Tasks - 2026-05-06

## 已完成工作

### Project Editor 大文件打开能力

- 梳理并调整 Project Editor 的文件打开链路，补充文件大小分层处理。
- 将 3 MB 作为打开前提示阈值：超过阈值时提示用户加载可能需要更久。
- 将 30 MB 作为 eager / chunked 分界线：30 MB 以内仍按完整文本读取，超过 30 MB 切换到只读分块阅读模式。
- 为超大文本文件补充只读提示，避免用户误以为该模式支持编辑保存。
- 新增主进程分块读取 IPC，供 Project Editor 按需请求文本片段。

### Project Editor 交互与反馈优化

- 增加大文件加载过程中的等待反馈和加载动画。
- 增加文件打不开、选择打开方式、二进制兜底等场景的明确用户提示。
- 补齐英文和中文文案，避免新增 UI 文案只覆盖单一语言。
- 增加 ESC / 关闭路径相关交互覆盖，保持 Project Editor 子页面交互一致。

### 二进制与未知类型文件处理

- 增加未知二进制文件打开选择框：用户可选择只读二进制视图或按纯文本打开。
- 增加“记住此扩展名打开方式”的能力，降低同类未知文件的重复确认成本。
- 引入 `hexy` 作为只读二进制阅读基础能力，支持十六进制、八进制、二进制、十进制等显示方式。
- 更新第三方依赖清单和 notices 生成逻辑，确保新增依赖进入许可证记录。

### PNG / PDF 误判修复

- 修复已支持文件类型被“未知二进制”兜底逻辑拦截的问题。
- 将支持的图片类型识别提前到未知二进制 sniff 之前，`.png` 会直接进入图片预览，不再弹出二进制打开方式选择框。
- 保持 PDF / EPUB / SQLite 等已支持类型优先于未知二进制兜底路径。
- 增加 PNG 和 PDF 回归断言，确保支持格式不会再误弹打开方式选择框。

### 终端启动修复

- 诊断并修复开发包中终端无法启动的问题。
- 根因是 packaged app 内 `node-pty` 的 macOS `spawn-helper` 缺少可执行权限，导致 PTY spawn 失败。
- 新增 `scripts/ensure-node-pty-spawn-helper.js`，并接入 `postinstall`、`pack`、`dist`、`dist:dev`、`dist:release` 等脚本。
- 更新 electron-builder 配置，将 `node_modules/node-pty/**` 放入 `asarUnpack`，避免 helper 被打进 asar 后无法执行。
- 修复 `scripts/dist-dev.js` 对 macOS 开发包路径的发现逻辑，覆盖 `release/mac`。

### 性能 Trace 与文档

- 为大文件 / 分块读取等用户可感知路径补充 perf trace 事件。
- 更新 `src/utils/perf-trace-names.ts` 和 `infra/trace.md`，保持 trace 事件注册表与文档一致。
- 在测试说明中登记 Project Editor 大文件测试覆盖面，方便后续回归测试定位。

### 自动化测试

- 新增 Project Editor 大文件与二进制文件自动化测试。
- 新增 macOS / Linux shell runner 与 Windows PowerShell runner。
- 将新 runner 注册到完整回归 orchestrator。
- 增加不同量级文本文件、未知二进制、PNG、PDF 等覆盖场景。
- 已通过验证：
  - `pnpm typecheck`
  - `pnpm lint:comments`
  - `git diff --check`
  - `rm -rf out release && ONWARD_DIST_DEV_OPEN=0 pnpm dist:dev`
  - `test/autotest/run-project-editor-large-file-autotest.sh`：18/18 通过
  - `test/autotest/run-image-diff-autotest.sh`：33/33 通过

## 当前状态

- 当前工作区包含 Project Editor 大文件 / 二进制处理、终端启动修复、自动化测试、trace 文档和依赖 notices 的改动。
- 开发版应用已成功构建并启动过，包名为 `Under Development 2.0.1-editor-enhance`。
- 当前尚未执行 git commit，也尚未 push。

## 接下来的任务

### 提交与推送

- 复核 `git status` 和 `git diff --stat`，确认本次提交只包含当前任务相关文件。
- 生成英文 commit message。
- 执行 git commit。
- 推送当前 `editor-enhance` 分支到远端。

### 手动体验确认

- 在 Project Editor 中手动打开 PNG 文件，确认直接进入图片预览，不出现二进制打开方式选择框。
- 手动打开 PDF 文件，确认直接进入 PDF 阅读器，不出现二进制打开方式选择框。
- 手动打开未知二进制文件，确认选择框仍然出现，且可选择二进制只读视图或纯文本打开。
- 手动打开超过 3 MB 的文本文件，确认加载耗时提示合理。
- 手动打开超过 30 MB 的文本文件，确认进入只读分块阅读模式，并有明确只读提示。

### 后续可选优化

- 基于真实测试数据再确定大文件性能验收线，例如首屏时间、翻页延迟、跳转延迟等。
- 继续评估 Monaco Editor 更细粒度的按需加载方案，决定是否需要替换或增强当前分块阅读实现。
- 评估更成熟的二进制查看组件是否适合长期替代当前 `hexy` 只读视图。
- 在 Windows 和 Linux 环境补跑对应 runner，确认跨平台行为一致。
