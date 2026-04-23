<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Terminal Architecture Baseline Fixture

This fixture is copied into `workdir` by the baseline fixture preparation script.
The generated working directory is intentionally small enough to run quickly but
large enough to exercise Git diff parsing, project search, terminal output, and
renderer update paths under concurrent load.
