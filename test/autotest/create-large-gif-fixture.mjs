/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, writeFile } from 'fs/promises'
import { dirname, resolve } from 'path'

const outputPath = process.argv[2]
const targetSize = Number.parseInt(process.argv[3] ?? '', 10)

if (!outputPath || !Number.isFinite(targetSize) || targetSize <= 0) {
  console.error('Usage: node test/autotest/create-large-gif-fixture.mjs <output-path> <size-bytes>')
  process.exit(2)
}

const resolvedOutput = resolve(outputPath)
await mkdir(dirname(resolvedOutput), { recursive: true })

const header = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
  0x01, 0x00, 0x01, 0x00,
  0x80, 0x00, 0x00,
  0x00, 0x00, 0x00,
  0xff, 0xff, 0xff,
  0x2c,
  0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00,
  0x00,
  0x02,
  0x02,
  0x44, 0x01,
  0x00
])
const trailer = Buffer.from([0x3b])
const minimumSize = header.length + trailer.length
const commentPayloadSize = Math.max(0, targetSize - minimumSize)
const commentBlocks = []
let remaining = commentPayloadSize
if (remaining > 0) {
  commentBlocks.push(Buffer.from([0x21, 0xfe]))
  while (remaining > 0) {
    const chunkSize = Math.min(255, remaining)
    commentBlocks.push(Buffer.from([chunkSize]))
    commentBlocks.push(Buffer.alloc(chunkSize, 0x20))
    remaining -= chunkSize
  }
  commentBlocks.push(Buffer.from([0x00]))
}

const buffer = Buffer.concat([header, ...commentBlocks, trailer])

await writeFile(resolvedOutput, buffer)
console.log(JSON.stringify({ outputPath: resolvedOutput, sizeBytes: buffer.length }))
