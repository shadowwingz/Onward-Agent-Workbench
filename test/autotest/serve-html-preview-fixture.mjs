/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const [fixtureDirArg, readyJsonArg] = process.argv.slice(2)

if (!fixtureDirArg || !readyJsonArg) {
  console.error('Usage: node serve-html-preview-fixture.mjs <fixture-dir> <ready-json>')
  process.exit(2)
}

const fixtureDir = path.resolve(fixtureDirArg)
const readyJsonPath = path.resolve(readyJsonArg)

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8']
])

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    const name = path.basename(requestUrl.pathname)
    if (!['external.js', 'external.css'].includes(name)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const fullPath = path.join(fixtureDir, name)
    const bytes = await readFile(fullPath)
    res.writeHead(200, {
      'content-type': contentTypes.get(path.extname(name)) ?? 'application/octet-stream',
      'cache-control': 'no-store'
    })
    res.end(bytes)
  } catch (error) {
    res.writeHead(500)
    res.end(String(error))
  }
})

server.listen(0, '127.0.0.1', async () => {
  const address = server.address()
  if (!address || typeof address === 'string') {
    console.error('Failed to resolve fixture server address')
    process.exit(1)
  }
  const baseUrl = `http://127.0.0.1:${address.port}`
  const templatePath = path.join(fixtureDir, 'regularization_landscape.template.html')
  const htmlPath = path.join(fixtureDir, 'regularization_landscape.html')
  const template = await readFile(templatePath, 'utf-8')
  await writeFile(htmlPath, template.replaceAll('__HTML_PREVIEW_SERVER_URL__', baseUrl), 'utf-8')
  await writeFile(readyJsonPath, JSON.stringify({
    baseUrl,
    htmlPath
  }), 'utf-8')
})

const shutdown = () => {
  server.close(() => {
    process.exit(0)
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
