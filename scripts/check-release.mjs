#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

let files
try {
  files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\0')
    .filter(Boolean)
    .sort()
} catch {
  const ignoredDirectories = new Set([
    '.git', '.cache', '.playwright-cli', '.vercel', 'coverage', 'dist', 'node_modules', 'output', 'playwright-report', 'test-results',
  ])
  const walk = (directory = '.') => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = directory === '.' ? entry.name : join(directory, entry.name)
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name) || path === 'public/assets' || path === 'supabase/.temp' || path === 'supabase/.branches') return []
      if (path === 'data' || path === 'uploads') return readdirSync(path, { withFileTypes: true }).some(({ name }) => name === '.gitkeep') ? [`${path}/.gitkeep`] : []
      return walk(path)
    }
    if (entry.name === '.DS_Store' || entry.name.endsWith('.log') || entry.name.endsWith('.tsbuildinfo')) return []
    if (/^\.env(?:\.|$)/.test(entry.name) && entry.name !== '.env.example') return []
    if (path === 'public/index.html') return []
    return [path]
  })
  files = walk().sort()
  console.warn('Git metadata was not found; auditing the unpacked source tree with the built-in ignore rules.')
}

const violations = []
const forbiddenPath = (file) => {
  if (file === '.env.example') return false
  if (/^\.env(?:\.|$)/.test(file) || file === '.envrc') return true
  if (file === 'uploads/.gitkeep') return false
  if (/^(?:dist|output|uploads|\.vercel|\.playwright-cli|playwright-report|test-results|coverage)\//.test(file)) return true
  if (/^data\//.test(file) && file !== 'data/.gitkeep') return true
  if (/^public\/(?:index\.html|assets\/)/.test(file)) return true
  if (/\.tsbuildinfo$|\.log$|(?:^|\/)\.DS_Store$/.test(file)) return true
  return false
}

for (const file of files) if (forbiddenPath(file)) violations.push(`${file}: private or generated path must remain ignored`)

const textExtensions = new Set([
  '', '.css', '.env', '.example', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt', '.webmanifest', '.yml', '.yaml',
])

const patterns = [
  ['Anthropic API key', new RegExp(`\\b${['sk', 'ant', 'api'].join('-')}[A-Za-z0-9_-]{20,}\\b`, 'g')],
  ['Voyage API key', new RegExp(`\\b${['pa', ''].join('-')}[A-Za-z0-9_-]{20,}\\b`, 'g')],
  ['Telegram bot token', /\b\d{7,12}:[A-Za-z0-9_-]{25,}\b/g],
  ['Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g],
  ['JWT-like token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['private key', new RegExp(['-----BEGIN', '(?: RSA| EC| OPENSSH)?', ' PRIVATE KEY-----'].join(''), 'g')],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
]

const placeholder = (value) => /^(?:|your_|generate_|example|sample|test|dummy|changeme|<|\$\{)/i.test(value)
const assignmentPattern = /^(?:export\s+)?([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|SERVICE_ROLE_KEY))\s*=\s*([^\s#]+).*$/gm
const formerDeployment = ['kept', 'mu', 'black'].join('-') + '.vercel.app'

for (const file of files) {
  if (!textExtensions.has(extname(file)) || statSync(file).size > 2 * 1024 * 1024) continue
  const content = readFileSync(file, 'utf8')
  if (content.includes('\0')) continue
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0
    if (pattern.test(content)) violations.push(`${file}: possible ${label}`)
  }
  assignmentPattern.lastIndex = 0
  for (const match of content.matchAll(assignmentPattern)) {
    const value = match[2].replace(/^['"]|['"]$/g, '')
    if (!placeholder(value)) violations.push(`${file}: ${match[1]} appears to contain a real value`)
  }
  if (content.includes(formerDeployment)) violations.push(`${file}: contains a deployment-specific hostname`)
}

if (violations.length) {
  console.error('Release audit failed:\n')
  for (const violation of [...new Set(violations)]) console.error(`  - ${violation}`)
  console.error('\nRemove the file/value or add an intentional placeholder. Rotate any real credential that was exposed.')
  process.exit(1)
}

console.log(`Release audit passed: ${files.length} tracked or unignored files, no private runtime paths or common credential formats found.`)
