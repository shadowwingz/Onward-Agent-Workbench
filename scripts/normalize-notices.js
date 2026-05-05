#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const fs = require('fs')
const path = require('path')

const target = path.join(__dirname, '..', 'ThirdPartyNotices.txt')
const before = fs.readFileSync(target, 'utf8')
const after = before
  .replace(/\r\n?/g, '\n')
  .replace(/[ \t]+$/gm, '')

if (before === after) {
  process.exit(0)
}

fs.writeFileSync(target, after)
