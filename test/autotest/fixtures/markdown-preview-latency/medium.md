# Medium Markdown Preview Latency Fixture

This fixture sits in the middle of the size band — roughly 2000
characters of plain prose, headings, lists, inline code, and a single
fenced code block, but no math or diagrams. The purpose is to probe
whether the markdown preview restore time scales with document size on
the cache-miss path while staying flat on the cache-hit path.

## Section A — Context

The preview-restore phase machine in ProjectEditor used to install a
fixed 1300 ms safety timer on every reveal, regardless of whether any
markdown / worker / mermaid work was still in flight. The current
event-driven settle takes a fast `setTimeout(0)` path the moment the
work signals clear. Cache hits should land in the fast path on the
first call, because the cached HTML already matches the file content
and no worker or mermaid render is needed.

## Section B — Measurement

The autotest opens this file three times for cache-miss measurement
and three times for cache-hit measurement, then asserts that both
paths reveal within their absolute budgets and report the fast path.

## Section C — Worked Example

Below is a small TypeScript snippet that mirrors the pure-logic
decision the unit test pins down:

```ts
function isPreviewWorkPending(s: PreviewWorkSignals): boolean {
  return (
    s.markdownRenderPending ||
    s.workerInFlight ||
    s.workerQueued ||
    s.mermaidInFlight ||
    s.mermaidPending > 0
  )
}
```

When this function returns `false`, `queuePreviewReveal` schedules
`phase = 'idle'` on the next tick. When it returns `true`, reveal
waits for the next event-driven queue call (worker complete /
mermaid complete / hasMoreRenderWork flipped) and re-evaluates the
signals.

## Section D — Notes

- The fast-path delay is a single `setTimeout(0)` so the browser gets
  one paint frame to commit the cached HTML before the CSS opacity
  rule lifts. This typically lands in 4–16 ms.
- `RENDERER_MARKDOWN_PREVIEW_REVEAL` instrumentation tags every
  finalize with `cause` and `hadWork` so production traces can tell
  whether a restore cycle saw pending work before the fast reveal.

End of fixture.
