/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Resolves a Monaco language id from a file name. Used by the Git Diff viewer
// to drive syntax highlighting in the diff editor. Tries (1) exact basename
// match (e.g. Dockerfile), (2) lowercased extension match. Returns 'plaintext'
// when nothing matches so Monaco still renders a usable read-only buffer.

export const MONACO_PLAINTEXT_LANGUAGE_ID = 'plaintext'

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  dart: 'dart',
  scala: 'scala',
  groovy: 'groovy',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  hh: 'cpp',
  ino: 'cpp',
  cs: 'csharp',
  m: 'objective-c',
  mm: 'objective-c',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  php: 'php',
  rb: 'ruby',
  rake: 'ruby',
  pl: 'perl',
  pm: 'perl',
  lua: 'lua',
  r: 'r',
  sql: 'sql',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'proto',
  sol: 'sol',
  tex: 'plaintext',
  vb: 'vb',
  fs: 'fsharp',
  fsx: 'fsharp',
  fsi: 'fsharp',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  ex: 'elixir',
  exs: 'elixir',
  jl: 'julia',
  vue: 'html',
  svelte: 'html'
}

const BASENAME_TO_LANGUAGE: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  jenkinsfile: 'groovy',
  rakefile: 'ruby',
  gemfile: 'ruby',
  podfile: 'ruby',
  vagrantfile: 'ruby',
  cmakelists: 'cmake',
  'cmakelists.txt': 'cmake',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.yarnrc': 'ini',
  '.env': 'plaintext',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.bash_profile': 'shell',
  '.profile': 'shell'
}

function getBasename(filename: string): string {
  if (!filename) return ''
  // Normalize Windows separators.
  const segments = filename.split(/[\\/]/)
  return segments[segments.length - 1] || ''
}

export function resolveMonacoLanguageId(filename: string | null | undefined): string {
  if (!filename) return MONACO_PLAINTEXT_LANGUAGE_ID
  const basename = getBasename(filename)
  if (!basename) return MONACO_PLAINTEXT_LANGUAGE_ID
  const lowerBasename = basename.toLowerCase()
  const exactMatch = BASENAME_TO_LANGUAGE[lowerBasename]
  if (exactMatch) return exactMatch
  const dotIndex = lowerBasename.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === lowerBasename.length - 1) {
    return MONACO_PLAINTEXT_LANGUAGE_ID
  }
  const ext = lowerBasename.slice(dotIndex + 1)
  return EXT_TO_LANGUAGE[ext] ?? MONACO_PLAINTEXT_LANGUAGE_ID
}
