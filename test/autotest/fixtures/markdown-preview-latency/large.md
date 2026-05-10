# Large Markdown Preview Latency Fixture

The largest fixture in the markdown-preview-latency band — roughly
5000 characters of plain prose, headings, lists, inline code, and a
few fenced code blocks. It deliberately avoids math, mermaid, and
images so the cache-hit path measures only the phase-machine
overhead, not extra rendering subsystems.

The autotest opens this file once per trial; the cache-miss path
runs through the full marked → katex → highlight.js worker pipeline
and the renderer-side DOMPurify sanitize. The cache-hit path skips
all of that and re-applies the snapshotted HTML through
`dangerouslySetInnerHTML`, then transitions the preview-restore
phase machine straight from `waiting-html` to `idle`.

## 1. Background - why the wait existed

Before the event-driven settle, every reveal scheduled a fixed
1300 ms safety timer.
That constant was sized for the worst-case worker debounce path,
where a freshly opened markdown file might still be waiting for
worker output 1.2 s after the user pressed the shortcut. On the
cache-hit path, however, no worker work is pending — the cached
HTML is byte-identical to what the file currently contains and the
session cache already validated `entry.content === fileContent`.
So the 1300 ms wait was a defensive padding paid by every entry,
including the ones that had nothing to wait for.

The user-visible symptom: re-entering Markdown preview always
showed loading dots for ~1.3 seconds, even when the file had been
viewed seconds earlier and the cache trivially served the same HTML
that was previously rendered.

## 2. Event-driven settle

The fix replaces the fixed timer with an event-driven decision:

- **Fast path.** When `isPreviewWorkPending` returns false, schedule
  `phase = 'idle'` on the next tick via `setTimeout(0)`. This gives
  the browser one paint frame to commit the `dangerouslySetInnerHTML`
- **Pending work.** When work is pending, reveal waits for the next
  event-driven `queuePreviewReveal` call (fired by `worker.onmessage`,
  by `mermaid.finally`, or by the layoutEffect once
  `hasMoreRenderWork` flips to false) and re-evaluates the signals.
  Cache-miss paths should therefore also land well under the old
  1300 ms budget once the worker output has committed.

## 3. Pure-logic split

The decision boundary itself is now a pure function so a unit
test can pin down its truth table without spinning up Electron:

```ts
export type PreviewWorkSignals = {
  markdownRenderPending: boolean
  workerInFlight: boolean
  workerQueued: boolean
  mermaidPending: number
  mermaidInFlight: boolean
}

export function isPreviewWorkPending(s: PreviewWorkSignals): boolean {
  return (
    s.markdownRenderPending ||
    s.workerInFlight ||
    s.workerQueued ||
    s.mermaidInFlight ||
    s.mermaidPending > 0
  )
}
```

The unit test enumerates all 32 boolean combinations of the five
signals (treating `mermaidPending` as a non-negative integer) and
asserts the function returns `true` whenever any signal indicates
work, `false` only when every signal says idle. Pair it with this
autotest, which exercises the same decision through the live
React component against three real markdown source sizes.

## 4. Trace event coverage

`RENDERER_MARKDOWN_PREVIEW_REVEAL` is the new instant-event marker
emitted by `queuePreviewReveal::finalize`. Its payload tags every
reveal with:

- `cause`: `fast-path` if the work signals were idle at settle
  time.
- `hadWork`: whether this restore cycle observed pending work before
  the fast reveal; lets Perfetto SQL queries split reveal duration by
  branch.
- `durationMs`: wall-clock from `queuePreviewReveal` entry to the
  `phase:idle` commit.

A regression where the fast path stops firing (for example, a
future refactor that re-introduces unconditional `setTimeout(1300)`)
would show up as `durationMs` jumping back to ~1300. That gives the
perf review pipeline an automatic alert before the 1.3 s wait reaches
users again.

## 5. Test plan

The autotest authoring follows the *Unit test + autotest as a
paired deliverable* hard rule:

- **Unit layer.** `test/unittest/preview-restore-settle.test.mts`
  locks `isPreviewWorkPending` against every boolean combination of
  the five signals. Runs in plain Node, finishes in milliseconds,
  no Electron required.
- **Autotest layer.** This suite drives a real ProjectEditor in a
  packaged dev build, opens each fixture, captures the
  reveal durations from the debug API, and asserts both cache-miss
  and cache-hit paths meet their budgets and report the fast path.

The combination catches both classes of regression: a math-side
bug in the pure-logic table (caught by the unit test) and a wiring
bug where the table is correct but the React effects never call
`isPreviewWorkPending` at the right moment (caught by the
autotest).

End of fixture.
