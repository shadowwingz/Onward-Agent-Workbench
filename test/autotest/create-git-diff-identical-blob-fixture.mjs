#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
//
// IBD (Identical-Blob-OID Diff) fixture builder.
//
// Constructs a git repo with two files that share BOTH the same HEAD blob
// OID AND the same working-tree blob OID. This is the precise scenario
// in which the same-blob-OID race surfaces in GitDiffViewer's hunk widget
// install path (the renderer's IPC layer hits an OS page cache because
// the two reads resolve to the same blob, so both file contents arrive
// in the same frame, and the previous setTimeout-based widget install
// raced between the two).
//
// The post-Phase-4 refactor structurally eliminates the race by moving
// widget install onto Monaco's `onDidUpdateDiff` event directly (no
// setTimeout) and removing the defensive `maxLineCount` clamp inside
// normalizeLineSide. This fixture+test pair is the regression gate.
//
// Output (stdout): JSON `{ "root": "/path/to/fixture" }`. The runner
// script reads this and points the dev app at that cwd.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'onward-gdib-fixture-'))

function git(args) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

function gitOut(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

// 5 sections, ~100 lines total. Each section gets a clearly delineated
// block so the modified version produces 5 non-adjacent hunks — that's
// exactly the "widgetDomCount=5" assertion target.
// Keep section headers identical between initial and modified versions
// so only the line-8 edits show up as hunks (= 5 hunks total). The
// modified content uses the same `Section N` header text to keep that
// invariant.
function makeContent(modified) {
  const sections = []
  for (let s = 1; s <= 5; s += 1) {
    sections.push(`## Section ${s}`)
    sections.push('')
    for (let i = 1; i <= 15; i += 1) {
      if (modified && i === 8) {
        sections.push(`Section ${s} line ${i}: [edited for IBD fixture] morbi vitae elit.`)
      } else {
        sections.push(`Section ${s} line ${i}: lorem ipsum dolor sit amet.`)
      }
    }
    sections.push('')
  }
  return sections.join('\n') + '\n'
}

// Alphabet ordering: AGENTS.md comes before CLAUDE.md so the renderer's
// file list shows them in that order. The bug originally surfaced when
// the user clicked CLAUDE.md first (the SECOND file in the list).
const INITIAL_CONTENT = makeContent(false)
const MODIFIED_CONTENT = makeContent(true)

git(['init', '-q', '-b', 'main'])
git(['config', 'user.email', 'autotest@example.invalid'])
git(['config', 'user.name', 'Onward Autotest'])

writeFileSync(join(root, 'AGENTS.md'), INITIAL_CONTENT, 'utf8')
writeFileSync(join(root, 'CLAUDE.md'), INITIAL_CONTENT, 'utf8')

git(['add', '.'])
git(['commit', '-q', '-m', 'IBD fixture: AGENTS.md + CLAUDE.md identical seed'])

// Now mutate to identical modified content. Working-tree blobs will
// also be identical post-write.
writeFileSync(join(root, 'AGENTS.md'), MODIFIED_CONTENT, 'utf8')
writeFileSync(join(root, 'CLAUDE.md'), MODIFIED_CONTENT, 'utf8')

// Validate the identity invariants before declaring the fixture ready.
// `git hash-object` is the same hash git uses for the blob OID after
// `git add`, so we can compare both HEAD blob OIDs and the working-tree
// blob OIDs without paying the cost of an actual commit.
const headBlobAgents = gitOut(['rev-parse', 'HEAD:AGENTS.md'])
const headBlobClaude = gitOut(['rev-parse', 'HEAD:CLAUDE.md'])
const workBlobAgents = gitOut(['hash-object', 'AGENTS.md'])
const workBlobClaude = gitOut(['hash-object', 'CLAUDE.md'])

if (headBlobAgents !== headBlobClaude) {
  process.stderr.write(`IBD fixture invariant failed: HEAD blob OIDs differ\n  AGENTS.md=${headBlobAgents}\n  CLAUDE.md=${headBlobClaude}\n`)
  process.exit(2)
}
if (workBlobAgents !== workBlobClaude) {
  process.stderr.write(`IBD fixture invariant failed: working-tree blob OIDs differ\n  AGENTS.md=${workBlobAgents}\n  CLAUDE.md=${workBlobClaude}\n`)
  process.exit(2)
}

// Sanity-check the diff produces the expected 5 hunks for each file
// (one per section). If git changes its diff defaults the assertion
// below will break in a clean way rather than a renderer-level FAIL.
const diffAgents = execFileSync('git', ['diff', '--unified=0', 'AGENTS.md'], { cwd: root, encoding: 'utf8' })
const hunkCountAgents = (diffAgents.match(/^@@ /gm) || []).length
if (hunkCountAgents !== 5) {
  process.stderr.write(`IBD fixture invariant failed: expected exactly 5 hunks in AGENTS.md diff, got ${hunkCountAgents}\n`)
  process.exit(2)
}

process.stdout.write(JSON.stringify({
  root,
  headBlob: headBlobAgents,
  workBlob: workBlobAgents,
  hunkCount: hunkCountAgents
}) + '\n')
// We deliberately do NOT write any marker file inside `root` — Git Diff
// would surface it as an untracked entry, breaking the file-list-length
// assertion in IBD-00.
void readFileSync
