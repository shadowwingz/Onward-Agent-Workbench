<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Git Diff Performance Diagnostics

The Git Diff Performance Diagnostics panel explains click-to-render latency for the Git Diff view. It is hidden by default and appears only when Settings → Diagnostics → Performance Diagnostics is enabled. The environment feature flag `ONWARD_FEATURE_GIT_DIFF_PERFORMANCE_DIAGNOSTICS=0` is a hard product gate that hides the panel even if the setting is enabled.

## Cache Terms

**Content cache hit** means the selected file body was already available from an in-memory cache. The cached payload is the `getFileContent` result: original content, modified content, binary and media flags, image data URLs, and preview payloads for supported document types. A hit avoids the slower worker path that reads from Git and the filesystem.

The Last Click pill labels a hit or miss from the structured `cacheInfo` returned by the main process. It no longer infers hit/miss from a fast IPC round trip. The main process also emits explicit `main:git.diff.content-cache.hit` / `main:git.diff.content-cache.miss` trace events at lookup time with the same source and miss-reason fields.

**Content cache miss** means that payload was absent, invalidated, stale, too large to store, evicted, or still being warmed by the scheduler. The renderer still gets the file, but the request falls through to the worker and may repopulate the cache afterward. Miss reasons include first load, mutation/watch/mirror invalidation, manual refresh, project queue eviction, single-file cap, precompute pending, entry not warmed, and worker error.

**Content cache n/a** means the click measurement did not produce a reliable hit/miss label, usually because it was cancelled, non-text, or incomplete.

This is separate from the **list cache**, which caches the changed-file list returned by Git Diff. The list cache does not contain file bodies. It has a short TTL and can be bypassed by explicit refresh, mutation, or watcher invalidation. It usually does not move while the user is only clicking files, because file clicks read the content cache, not the changed-file-list cache.

Watcher health is kept in the debug stats returned by main, but it is no longer shown in the normal Performance Diagnostics panel. It is operational telemetry for maintainers, not a metric most users can act on. Watcher errors still cause immediate cache invalidation and a best-effort re-subscribe.

The **precompute scheduler** is not a cache itself. It runs after invalidations and fills the content cache in the background. The current strategy debounces invalidation bursts, fetches up to 100 eligible files with six-way concurrency, skips binary-heavy extensions and files above the single-file cap, and prioritizes larger diffs first.

## Content Cache Policy

The main-process content cache is bucketed by project root:

- Per project budget: 100 MB.
- Maximum resident projects: 8.
- Single file cap: 10 MB.
- Project eviction: project buckets are kept in a recent-access queue. A hit or write moves that project to the front; when a ninth project appears, the tail bucket is removed.
- In-project eviction: smallest entries are evicted first, with older entries as the tie-breaker. This intentionally keeps large files warm because large file misses are more visible to users.
- Invalidation: Git/file mutations, explicit refreshes, and watcher or mirror updates clear the affected project bucket.

## Last Click Phases

The Last Click bar is a single selected-file click split into ordered phases:

- **IPC Fetch**: renderer asks main for the selected file body.
- **State Set**: React state receives the selected file body.
- **Model Bind**: original and modified Monaco models are bound to the DiffEditor.
- **Monaco Mount**: DiffEditor cold mount or model-ready wait.
- **Diff Compute**: Monaco computes the line and word diff.
- **DOM Commit**: Monaco writes visible diff rows into the DOM.
- **Paint**: next browser frame after DOM commit.
- **Settle**: post-paint quiet window for Monaco tokenization, decorations, hunk widgets, and DOM mutations. This can dominate when syntax highlighting or decorations stream over multiple frames.

`First paint` is the click-to-paint proxy. `Total` is click-to-settled. `Settle reason` explains why the measurement sealed, such as token quiet, DOM quiet, non-text, or timeout.

## Reading The Panel

**Aggregate** shows rolling stats over the recent click history: completed count, content-cache hit rate, p50, p95, max, cancelled clicks, and per-phase averages.

**Content cache** shows resident project buckets. Rows follow the recent-access queue: the first row is the project most recently hit or written, and the tail is the next candidate if a ninth project must be admitted. The bar is usage against that project's 100 MB budget, bytes/entries show how much payload is resident, and the current working directory row is highlighted.

Hover or focus a project path to see the full path immediately. Hover or focus the bytes/entries value to inspect the resident entry list for that project bucket; entries are sorted by cached byte size so the largest retained diff bodies are easiest to spot.

**List cache** shows changed-file-list cache health: resident list entries, idle/in-flight state, last request outcome, hit rate, misses, force bypasses, and TTL. If those numbers do not move while selecting files, that is expected; the list cache is touched when Git Diff opens/reloads, Refresh Changes runs, TTL expires, or a mutation invalidates the list.

**Precompute scheduler** shows background cache warming: invalidation bursts, projects currently in-flight, projects pending debounce, completed fetches, cancelled bursts, and skipped files.

**History** shows recent click measurements as stacked bars. Taller bars are slower clicks; colors match the Last Click phase legend.
