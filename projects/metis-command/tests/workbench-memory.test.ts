import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  BRIDGE_MEMORY_DIR,
  WORKBENCH_MEMORY_DIR,
  createMemoryNote,
  discoverMemoryDir,
  ensureMemoryDir,
  extractWikiLinks,
  findBacklinks,
  listMemoryNotes,
  searchMemoryNotes,
  suggestMemoryConnections,
} from '../lib/workbench-memory'

function withTempWorkspace(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-memory-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('discovers .workbenchmemory first and falls back to .bridgememory compatibility', () => withTempWorkspace((root) => {
  let discovery = discoverMemoryDir(root)
  assert.equal(discovery.name, WORKBENCH_MEMORY_DIR)
  assert.equal(discovery.existed, false)
  assert.equal(fs.existsSync(discovery.dir), false)

  fs.mkdirSync(path.join(root, BRIDGE_MEMORY_DIR))
  discovery = discoverMemoryDir(root)
  assert.equal(discovery.name, BRIDGE_MEMORY_DIR)
  assert.equal(discovery.existed, true)

  fs.mkdirSync(path.join(root, WORKBENCH_MEMORY_DIR))
  discovery = discoverMemoryDir(root)
  assert.equal(discovery.name, WORKBENCH_MEMORY_DIR)
  assert.equal(discovery.existed, true)
}))

test('ensureMemoryDir creates preferred local-first memory directory', () => withTempWorkspace((root) => {
  const discovery = ensureMemoryDir(root)
  assert.equal(discovery.name, WORKBENCH_MEMORY_DIR)
  assert.equal(discovery.existed, false)
  assert.equal(fs.statSync(discovery.dir).isDirectory(), true)
}))

test('creates markdown notes with frontmatter-ish metadata and stable filenames', () => withTempWorkspace((root) => {
  const memoryDir = ensureMemoryDir(root).dir
  const note = createMemoryNote({
    memoryDir,
    title: 'Shared Memory Hub',
    body: 'Use [[Mission Contract]] when coordinating lanes.',
    tags: ['Swarm', 'Memory', 'swarm'],
    metadata: { workspaceId: 'ws_1', unsafeKey: 'kept', 'bad:key': 'dropped' },
    now: '2026-05-11T12:00:00.000Z',
    id: 'mem_shared',
  })

  assert.equal(note.relativePath, 'shared-memory-hub.md')
  assert.equal(note.metadata.id, 'mem_shared')
  assert.equal(note.metadata.title, 'Shared Memory Hub')
  assert.deepEqual(note.metadata.tags, ['memory', 'swarm'])
  assert.equal(note.metadata.workspaceId, 'ws_1')
  assert.equal(Object.hasOwn(note.metadata, 'bad:key'), false)
  assert.match(note.raw, /^---\nid: mem_shared\n/m)
  assert.deepEqual(note.wikilinks.map((link) => link.target), ['Mission Contract'])

  const duplicate = createMemoryNote({ memoryDir, title: 'Shared Memory Hub', now: '2026-05-11T12:01:00.000Z' })
  assert.equal(duplicate.relativePath, 'shared-memory-hub-2.md')
}))

test('lists and searches markdown notes by text and tags', () => withTempWorkspace((root) => {
  const memoryDir = ensureMemoryDir(root).dir
  createMemoryNote({
    memoryDir,
    title: 'Evidence Gate',
    body: 'Done tasks require reports and review evidence.',
    tags: ['tasks', 'evidence'],
    now: '2026-05-11T12:00:00.000Z',
  })
  createMemoryNote({
    memoryDir,
    title: 'Voice Targeting',
    body: 'Transcript history should preserve visible target state.',
    tags: ['voice'],
    now: '2026-05-11T12:01:00.000Z',
  })

  assert.deepEqual(listMemoryNotes(memoryDir).map((note) => note.metadata.title), ['Evidence Gate', 'Voice Targeting'])

  const textResults = searchMemoryNotes({ memoryDir, text: 'review evidence' })
  assert.deepEqual(textResults.map((result) => result.note.metadata.title), ['Evidence Gate'])
  assert.ok(textResults[0].score > 0)

  const tagResults = searchMemoryNotes({ memoryDir, tags: ['VOICE'] })
  assert.deepEqual(tagResults.map((result) => result.note.metadata.title), ['Voice Targeting'])

  const combined = searchMemoryNotes({ memoryDir, text: 'done', tags: ['evidence'] })
  assert.deepEqual(combined.map((result) => result.note.metadata.title), ['Evidence Gate'])
}))

test('extracts wikilinks with labels and headings', () => {
  const links = extractWikiLinks('See [[Mission Contract#Review Gate|review flow]], [[Shared Memory Hub]], and [[]].')
  assert.deepEqual(links, [
    {
      raw: '[[Mission Contract#Review Gate|review flow]]',
      target: 'Mission Contract',
      label: 'review flow',
      heading: 'Review Gate',
    },
    {
      raw: '[[Shared Memory Hub]]',
      target: 'Shared Memory Hub',
      label: undefined,
      heading: undefined,
    },
  ])
})

test('finds backlinks to a note title', () => withTempWorkspace((root) => {
  const memoryDir = ensureMemoryDir(root).dir
  createMemoryNote({ memoryDir, title: 'Mission Contract', tags: ['mission'] })
  createMemoryNote({ memoryDir, title: 'Shared Memory Hub', body: 'References [[Mission Contract]] and [[Mission Contract#Scope]].' })
  createMemoryNote({ memoryDir, title: 'Other', body: 'No link here.' })

  const backlinks = findBacklinks(memoryDir, 'Mission Contract')
  assert.equal(backlinks.length, 1)
  assert.equal(backlinks[0].source.metadata.title, 'Shared Memory Hub')
  assert.equal(backlinks[0].links.length, 2)
}))

test('suggests simple connections from shared tags, links, backlinks, and terms', () => withTempWorkspace((root) => {
  const memoryDir = ensureMemoryDir(root).dir
  const source = createMemoryNote({
    memoryDir,
    title: 'Shared Memory Hub',
    body: 'Connect agents with mission review context. See [[Mission Contract]].',
    tags: ['memory', 'swarm'],
    id: 'mem_source',
  })
  createMemoryNote({
    memoryDir,
    title: 'Mission Contract',
    body: 'Mission review context for every agent lane.',
    tags: ['mission', 'swarm'],
  })
  createMemoryNote({
    memoryDir,
    title: 'Voice Targeting',
    body: 'Voice transcripts choose a target app.',
    tags: ['voice'],
  })

  const suggestions = suggestMemoryConnections(memoryDir, source.metadata.id)
  assert.equal(suggestions[0].note.metadata.title, 'Mission Contract')
  assert.ok(suggestions[0].score >= 18)
  assert.ok(suggestions[0].reasons.some((reason) => reason.includes('shared tags')))
  assert.ok(suggestions[0].reasons.includes('linked from source'))
  assert.equal(suggestions.some((suggestion) => suggestion.note.metadata.title === 'Voice Targeting'), false)
}))
