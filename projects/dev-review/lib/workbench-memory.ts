import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const WORKBENCH_MEMORY_DIR = '.workbenchmemory'
export const BRIDGE_MEMORY_DIR = '.bridgememory'
export const MEMORY_DIR_CANDIDATES = [WORKBENCH_MEMORY_DIR, BRIDGE_MEMORY_DIR] as const

export interface MemoryDirDiscovery {
  dir: string
  name: typeof WORKBENCH_MEMORY_DIR | typeof BRIDGE_MEMORY_DIR
  existed: boolean
}

export interface DiscoverMemoryDirOptions {
  create?: boolean
}

export interface MemoryNoteMetadata {
  id: string
  title: string
  tags: string[]
  createdAt: string
  updatedAt: string
  [key: string]: string | string[]
}

export interface MemoryNote {
  filePath: string
  relativePath: string
  metadata: MemoryNoteMetadata
  body: string
  raw: string
  wikilinks: WikiLink[]
}

export interface CreateMemoryNoteInput {
  memoryDir: string
  title: string
  body?: string
  tags?: string[]
  metadata?: Record<string, string | string[] | undefined>
  now?: string
  id?: string
}

export interface SearchMemoryInput {
  memoryDir: string
  text?: string
  tags?: string[]
  limit?: number
}

export interface MemorySearchResult {
  note: MemoryNote
  score: number
  matches: string[]
}

export interface WikiLink {
  raw: string
  target: string
  label?: string
  heading?: string
}

export interface Backlink {
  source: MemoryNote
  links: WikiLink[]
}

export interface SuggestedConnection {
  note: MemoryNote
  score: number
  reasons: string[]
}

export function discoverMemoryDir(
  workspaceRoot: string,
  options: DiscoverMemoryDirOptions = {},
): MemoryDirDiscovery {
  const root = path.resolve(workspaceRoot)
  for (const name of MEMORY_DIR_CANDIDATES) {
    const candidate = path.join(root, name)
    if (isDirectory(candidate)) return { dir: candidate, name, existed: true }
  }

  const fallbackName = WORKBENCH_MEMORY_DIR
  const fallback = path.join(root, fallbackName)
  if (options.create) fs.mkdirSync(fallback, { recursive: true })
  return { dir: fallback, name: fallbackName, existed: false }
}

export function ensureMemoryDir(workspaceRoot: string): MemoryDirDiscovery {
  return discoverMemoryDir(workspaceRoot, { create: true })
}

export function createMemoryNote(input: CreateMemoryNoteInput): MemoryNote {
  const title = normalizeTitle(input.title)
  const now = input.now ?? new Date().toISOString()
  const id = input.id ? sanitizeMetadataValue(input.id) : stableId(title, now)
  const tags = normalizeTags(input.tags ?? [])
  const metadata: MemoryNoteMetadata = {
    id,
    title,
    tags,
    createdAt: now,
    updatedAt: now,
  }

  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (!isSafeMetadataKey(key) || value === undefined) continue
    if (Array.isArray(value)) metadata[key] = value.map(sanitizeMetadataValue).filter(Boolean)
    else metadata[key] = sanitizeMetadataValue(value)
  }

  fs.mkdirSync(input.memoryDir, { recursive: true })
  const filePath = nextAvailablePath(input.memoryDir, `${slugify(title)}.md`)
  const body = `${input.body ?? ''}`.trim()
  const raw = `${formatFrontmatter(metadata)}\n${body ? `${body}\n` : ''}`
  fs.writeFileSync(filePath, raw, { encoding: 'utf8', flag: 'wx' })
  return parseMemoryNote(filePath, input.memoryDir)
}

export function listMemoryNotes(memoryDir: string): MemoryNote[] {
  if (!isDirectory(memoryDir)) return []
  return listMarkdownFiles(memoryDir)
    .map((file) => parseMemoryNote(file, memoryDir))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

export function readMemoryNote(filePath: string, memoryDir = path.dirname(filePath)): MemoryNote {
  return parseMemoryNote(filePath, memoryDir)
}

export function searchMemoryNotes(input: SearchMemoryInput): MemorySearchResult[] {
  const textTerms = tokenize(input.text ?? '')
  const tagTerms = normalizeTags(input.tags ?? [])
  const notes = listMemoryNotes(input.memoryDir)
  const results: MemorySearchResult[] = []

  for (const note of notes) {
    const noteTags = new Set(note.metadata.tags.map((tag) => tag.toLowerCase()))
    if (tagTerms.some((tag) => !noteTags.has(tag))) continue

    const haystack = `${note.metadata.title}\n${note.metadata.tags.join(' ')}\n${note.body}`.toLowerCase()
    if (textTerms.some((term) => !haystack.includes(term))) continue

    const matches: string[] = []
    let score = 0
    for (const tag of tagTerms) {
      matches.push(`tag:${tag}`)
      score += 8
    }
    for (const term of textTerms) {
      const titleHit = note.metadata.title.toLowerCase().includes(term)
      const tagHit = note.metadata.tags.some((tag) => tag.toLowerCase().includes(term))
      const bodyHit = note.body.toLowerCase().includes(term)
      if (titleHit) {
        matches.push(`title:${term}`)
        score += 6
      }
      if (tagHit) {
        matches.push(`tag:${term}`)
        score += 4
      }
      if (bodyHit) {
        matches.push(`body:${term}`)
        score += 2
      }
    }
    results.push({ note, score, matches })
  }

  return results
    .sort((a, b) => b.score - a.score || a.note.relativePath.localeCompare(b.note.relativePath))
    .slice(0, Math.max(0, input.limit ?? results.length))
}

export function extractWikiLinks(markdown: string): WikiLink[] {
  const links: WikiLink[] = []
  const re = /\[\[([^\]\n]+)\]\]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(markdown))) {
    const rawInner = match[1].trim()
    if (!rawInner) continue
    const [targetPart, labelPart] = rawInner.split('|', 2).map((part) => part.trim())
    const [targetName, headingPart] = targetPart.split('#', 2).map((part) => part.trim())
    if (!targetName) continue
    links.push({
      raw: match[0],
      target: targetName,
      label: labelPart || undefined,
      heading: headingPart || undefined,
    })
  }
  return links
}

export function findBacklinks(memoryDir: string, target: string): Backlink[] {
  const normalizedTarget = normalizeLinkTarget(target)
  return listMemoryNotes(memoryDir)
    .map((source) => ({
      source,
      links: source.wikilinks.filter((link) => normalizeLinkTarget(link.target) === normalizedTarget),
    }))
    .filter((backlink) => backlink.links.length > 0)
}

export function suggestMemoryConnections(
  memoryDir: string,
  noteIdOrTitleOrPath: string,
  limit = 5,
): SuggestedConnection[] {
  const notes = listMemoryNotes(memoryDir)
  const source = findNote(notes, noteIdOrTitleOrPath)
  if (!source) return []

  const sourceTags = new Set(source.metadata.tags.map((tag) => tag.toLowerCase()))
  const sourceLinks = new Set(source.wikilinks.map((link) => normalizeLinkTarget(link.target)))
  const sourceTerms = new Set(tokenize(`${source.metadata.title} ${source.body}`).filter((term) => term.length >= 4))

  const suggestions: SuggestedConnection[] = []
  for (const note of notes) {
    if (note.filePath === source.filePath) continue
    const reasons: string[] = []
    let score = 0

    const sharedTags = note.metadata.tags.filter((tag) => sourceTags.has(tag.toLowerCase()))
    if (sharedTags.length > 0) {
      score += sharedTags.length * 10
      reasons.push(`shared tags: ${sharedTags.join(', ')}`)
    }

    if (sourceLinks.has(normalizeLinkTarget(note.metadata.title)) || sourceLinks.has(normalizeLinkTarget(note.metadata.id))) {
      score += 8
      reasons.push('linked from source')
    }

    if (note.wikilinks.some((link) => normalizeLinkTarget(link.target) === normalizeLinkTarget(source.metadata.title))) {
      score += 8
      reasons.push('links back to source')
    }

    const sharedTerms = tokenize(`${note.metadata.title} ${note.body}`)
      .filter((term) => term.length >= 4 && sourceTerms.has(term))
      .slice(0, 5)
    if (sharedTerms.length > 0) {
      score += sharedTerms.length
      reasons.push(`shared terms: ${Array.from(new Set(sharedTerms)).join(', ')}`)
    }

    if (score > 0) suggestions.push({ note, score, reasons })
  }

  return suggestions
    .sort((a, b) => b.score - a.score || a.note.relativePath.localeCompare(b.note.relativePath))
    .slice(0, Math.max(0, limit))
}

function parseMemoryNote(filePath: string, memoryDir: string): MemoryNote {
  const raw = fs.readFileSync(filePath, 'utf8')
  const parsed = parseFrontmatter(raw)
  const fallbackTitle = titleFromFile(filePath)
  const metadata: MemoryNoteMetadata = {
    id: scalarMetadata(parsed.metadata.id) || slugify(fallbackTitle),
    title: scalarMetadata(parsed.metadata.title) || fallbackTitle,
    tags: arrayMetadata(parsed.metadata.tags),
    createdAt: scalarMetadata(parsed.metadata.createdAt) || '',
    updatedAt: scalarMetadata(parsed.metadata.updatedAt) || '',
    ...parsed.metadata,
  }
  metadata.tags = normalizeTags(arrayMetadata(metadata.tags))
  return {
    filePath,
    relativePath: path.relative(memoryDir, filePath),
    metadata,
    body: parsed.body,
    raw,
    wikilinks: extractWikiLinks(parsed.body),
  }
}

function parseFrontmatter(raw: string): { metadata: Record<string, string | string[]>; body: string } {
  if (!raw.startsWith('---\n')) return { metadata: {}, body: raw }
  const end = raw.indexOf('\n---', 4)
  if (end === -1) return { metadata: {}, body: raw }
  const frontmatter = raw.slice(4, end).trim()
  const bodyStart = raw.indexOf('\n', end + 4)
  const body = bodyStart === -1 ? '' : raw.slice(bodyStart + 1)
  const metadata: Record<string, string | string[]> = {}
  for (const line of frontmatter.split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const rawValue = line.slice(idx + 1).trim()
    if (!isSafeMetadataKey(key)) continue
    metadata[key] = parseMetadataValue(rawValue)
  }
  return { metadata, body }
}

function formatFrontmatter(metadata: MemoryNoteMetadata): string {
  const lines = Object.entries(metadata).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}: [${value.map(formatScalar).join(', ')}]`
    return `${key}: ${formatScalar(value)}`
  })
  return `---\n${lines.join('\n')}\n---`
}

function parseMetadataValue(value: string): string | string[] {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => unquote(item.trim()))
      .filter(Boolean)
  }
  return unquote(value)
}

function formatScalar(value: string): string {
  if (/^[a-zA-Z0-9_.:/@+-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function unquote(value: string): string {
  if (!value) return ''
  try {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return JSON.parse(value.startsWith("'") ? JSON.stringify(value.slice(1, -1)) : value)
    }
  } catch {}
  return value
}

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listMarkdownFiles(abs))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(abs)
  }
  return out
}

function nextAvailablePath(dir: string, basename: string): string {
  const parsed = path.parse(basename)
  for (let i = 0; i < 1000; i += 1) {
    const suffix = i === 0 ? '' : `-${i + 1}`
    const candidate = path.join(dir, `${parsed.name}${suffix}${parsed.ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error(`memory_note_path_exhausted: ${basename}`)
}

function normalizeTitle(title: string): string {
  const normalized = title.trim().replace(/\s+/g, ' ')
  if (!normalized) throw new Error('memory_note_invalid: title required')
  return normalized
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(
    new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)),
  ).sort()
}

function normalizeLinkTarget(target: string): string {
  return target.trim().toLowerCase().replace(/\.md$/i, '').replace(/\s+/g, ' ')
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'memory-note'
}

function stableId(title: string, now: string): string {
  return `mem_${createHash('sha256').update(`${title}\n${now}`).digest('hex').slice(0, 12)}`
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .map((term) => term.trim())
    .filter(Boolean)
}

function findNote(notes: MemoryNote[], lookup: string): MemoryNote | undefined {
  const normalizedLookup = normalizeLinkTarget(lookup)
  return notes.find((note) =>
    note.filePath === lookup ||
    note.relativePath === lookup ||
    normalizeLinkTarget(note.metadata.id) === normalizedLookup ||
    normalizeLinkTarget(note.metadata.title) === normalizedLookup ||
    normalizeLinkTarget(note.relativePath) === normalizedLookup,
  )
}

function titleFromFile(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, ' ')
}

function scalarMetadata(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

function arrayMetadata(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value
  if (!value) return []
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function sanitizeMetadataValue(value: string): string {
  return `${value}`.trim().replace(/\r?\n/g, ' ')
}

function isSafeMetadataKey(key: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}
