/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Eager-prefetch scheduler that fills the per-project diff content cache
// **before** the user clicks any specific file. Driven by the existing
// `gitDiffCacheInvalidator` events (fs.watch + state-mirror deltas), so a
// burst of file changes triggers exactly one rebuild rather than a flood.
//
// Lifecycle:
//   - `onProjectInvalidated(project)` is called from the cache invalidator's
//     listener. The scheduler debounces (200ms by default), then asks for
//     the current working set, sorts by `additions + deletions` descending
//     (large files first — biggest perceived win on cache miss), and walks
//     through them with bounded concurrency (3 at a time). Files that
//     exceed the single-file cap are skipped at this stage so they don't
//     starve smaller candidates.
//   - HEAD-change is just another invalidation event from the same source;
//     on receipt we wipe the project bucket (the cache layer does this) and
//     re-precompute the new working set.
//
// What this is NOT: an exhaustive replacement for the renderer's on-click
// fetch. The renderer still goes through the IPC path; this scheduler just
// makes sure that IPC almost always returns a cache hit.

export interface DiffFile {
  filename: string
  additions: number
  deletions: number
  changeType: string
  status: string
  isSubmoduleEntry?: boolean
  /** Full path of the repo this file belongs to. May differ from `project`
   * when a parent diff includes submodule files. */
  repoRoot?: string
}

export interface PrecomputeSchedulerOptions {
  /** Max files fetched in parallel. Default 3. */
  concurrency?: number
  /** Debounce window before a precompute burst kicks off. Default 200ms. */
  debounceMs?: number
  /** Hard cap on candidates per burst. Default 50. */
  maxCandidatesPerBurst?: number
  /**
   * Decides whether a file is eligible (e.g. excludes binary-ish extensions).
   * Mirrors the renderer's `shouldPrefetchFileBody` filter.
   */
  isEligible?: (file: DiffFile) => boolean
  /** Async hook injected by callers — fetches one file's content. */
  fetchFile: (project: string, file: DiffFile) => Promise<void>
  /** Async hook that returns the current working set for a project. */
  loadWorkingSet: (project: string) => Promise<DiffFile[]>
  /** Pluggable timer/clock so tests stay deterministic. */
  timer?: {
    setTimeout: (cb: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}

interface PendingProject {
  project: string
  /** Timer handle for the debounce window. */
  debounceHandle: unknown
  /** Monotonic burst id used to invalidate any in-flight wave. */
  generation: number
}

const DEFAULT_CONCURRENCY = 3
const DEFAULT_DEBOUNCE_MS = 200
const DEFAULT_MAX_CANDIDATES = 50

export interface PrecomputeStats {
  totalBursts: number
  totalCancelled: number
  totalCompleted: number
  totalSkipped: number
  pendingProjects: string[]
  inFlightProjects: string[]
}

export class GitDiffPrecomputeScheduler {
  private readonly pending = new Map<string, PendingProject>()
  private readonly inFlight = new Map<string, number>()
  private readonly options: Required<Omit<PrecomputeSchedulerOptions, 'isEligible' | 'timer'>>
    & Pick<PrecomputeSchedulerOptions, 'isEligible' | 'timer'>
  private readonly timer: NonNullable<PrecomputeSchedulerOptions['timer']>
  private readonly stats: PrecomputeStats = {
    totalBursts: 0,
    totalCancelled: 0,
    totalCompleted: 0,
    totalSkipped: 0,
    pendingProjects: [],
    inFlightProjects: []
  }

  constructor(options: PrecomputeSchedulerOptions) {
    this.options = {
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      maxCandidatesPerBurst: options.maxCandidatesPerBurst ?? DEFAULT_MAX_CANDIDATES,
      isEligible: options.isEligible,
      timer: options.timer,
      fetchFile: options.fetchFile,
      loadWorkingSet: options.loadWorkingSet
    }
    this.timer = options.timer ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    }
  }

  /**
   * Caller-facing entry point. Each call cancels any pending burst for the
   * same project and starts a fresh debounce window. Multiple invalidations
   * during the window collapse into one burst.
   */
  onProjectInvalidated(project: string): void {
    const existing = this.pending.get(project)
    if (existing) this.timer.clearTimeout(existing.debounceHandle)

    const generation = (existing?.generation ?? 0) + 1
    const handle = this.timer.setTimeout(() => {
      this.pending.delete(project)
      void this.runBurst(project, generation)
    }, this.options.debounceMs)
    this.pending.set(project, { project, debounceHandle: handle, generation })
  }

  /**
   * Cancel any pending or in-flight burst for the given project. Used when
   * the project is detached / cwd changes / the cache invalidator says the
   * watcher has been LRU-evicted. Returns true when something was cancelled.
   */
  cancelProject(project: string): boolean {
    let cancelled = false
    const pending = this.pending.get(project)
    if (pending) {
      this.timer.clearTimeout(pending.debounceHandle)
      this.pending.delete(project)
      cancelled = true
    }
    const inFlight = this.inFlight.get(project)
    if (inFlight !== undefined) {
      this.inFlight.set(project, inFlight + 1) // bump generation; runBurst checks this
      cancelled = true
    }
    if (cancelled) this.stats.totalCancelled += 1
    return cancelled
  }

  inspectStats(): PrecomputeStats {
    return {
      ...this.stats,
      pendingProjects: [...this.pending.keys()],
      inFlightProjects: [...this.inFlight.keys()]
    }
  }

  // --- private ---

  private async runBurst(project: string, generation: number): Promise<void> {
    this.stats.totalBursts += 1
    this.inFlight.set(project, generation)
    try {
      const workingSet = await this.options.loadWorkingSet(project)
      if (!this.isCurrent(project, generation)) return

      const candidates = workingSet
        .filter((file) => (this.options.isEligible ? this.options.isEligible(file) : true))
        .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
        .slice(0, this.options.maxCandidatesPerBurst)

      // Bounded-concurrency worker loop. Plain index pointer so we don't
      // need to allocate Promises per slot when concurrency is small.
      let cursor = 0
      const workers: Promise<void>[] = []
      const next = async () => {
        while (this.isCurrent(project, generation) && cursor < candidates.length) {
          const file = candidates[cursor++]
          try {
            await this.options.fetchFile(project, file)
            this.stats.totalCompleted += 1
          } catch {
            this.stats.totalSkipped += 1
          }
        }
      }
      for (let i = 0; i < this.options.concurrency; i += 1) {
        workers.push(next())
      }
      await Promise.all(workers)
    } finally {
      // Only clear in-flight marker if no newer generation has taken over.
      if (this.inFlight.get(project) === generation) {
        this.inFlight.delete(project)
      }
    }
  }

  private isCurrent(project: string, generation: number): boolean {
    return this.inFlight.get(project) === generation
  }
}
