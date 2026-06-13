import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  selectClickup,
  selectMs365,
  selectNavoreRepos,
  navoreCounts,
  navoreStatusTone,
  sortNavoreTasks,
  navoreOpenWork,
  type NavoreTask,
} from '../lib/example-data'
import type { MetisAll } from '../lib/metis-api-types'

function task(over: Partial<NavoreTask> = {}): NavoreTask {
  return { id: 'x', name: 'n', status: 'to do', priority: 'normal', due: null, url: '', ...over }
}

function fixture(over: Record<string, unknown> = {}): MetisAll {
  return {
    clickup: {
      ops_tasks: [task({ id: 'o1', status: 'in progress', priority: 'high' })],
      dev_tasks: [task({ id: 'd1', status: 'complete' })],
      projects: [task({ id: 'p1' })],
      milestones: [],
      counts: { ops: 1, projects: 1, milestones: 0, dev: 1 },
    },
    ms365: { calendar: [{}, {}], email: [{}], cache_age_min: 4, stale: false },
    github: [
      { repo: 'example-platform', commits: [{ sha: 'abc1234', message: 'fix', author: 'Ant' }] },
      { repo: 'anthonyabusa.github.io', commits: [] },
    ],
    ...over,
  } as unknown as MetisAll
}

describe('example-data selectors', () => {
  it('extracts the clickup slice defensively', () => {
    const c = selectClickup(fixture())
    assert.equal(c.ops_tasks.length, 1)
    assert.equal(c.dev_tasks.length, 1)
    assert.equal(c.error, undefined)
  })

  it('returns empty arrays (no throw) when clickup is missing or erroring', () => {
    const c = selectClickup(undefined)
    assert.deepEqual(c.ops_tasks, [])
    const e = selectClickup(fixture({ clickup: { error: 'CLICKUP_TOKEN not set' } }))
    assert.equal(e.error, 'CLICKUP_TOKEN not set')
    assert.deepEqual(e.projects, [])
  })

  it('falls back to array lengths when counts are absent', () => {
    const c = selectClickup(fixture({ clickup: { ops_tasks: [task(), task()], dev_tasks: [], projects: [], milestones: [] } }))
    assert.deepEqual(navoreCounts(c), { ops: 2, projects: 0, milestones: 0, dev: 0 })
  })

  it('filters github to Example-owned repos only', () => {
    const repos = selectNavoreRepos(fixture())
    assert.equal(repos.length, 1)
    assert.equal(repos[0].repo, 'example-platform')
  })

  it('reads ms365 counts + staleness', () => {
    const ms = selectMs365(fixture())
    assert.equal(ms.calendar.length, 2)
    assert.equal(ms.email.length, 1)
    assert.equal(ms.stale, false)
    const err = selectMs365(fixture({ ms365: { error: 'No MS365 data yet', calendar: [], email: [] } }))
    assert.equal(err.error, 'No MS365 data yet')
  })

  it('maps free-form statuses to coarse tones', () => {
    assert.equal(navoreStatusTone('Complete'), 'done')
    assert.equal(navoreStatusTone('In Progress'), 'active')
    assert.equal(navoreStatusTone('blocked'), 'blocked')
    assert.equal(navoreStatusTone('to do'), 'open')
    assert.equal(navoreStatusTone(undefined), 'open')
  })

  it('sorts open/active before done, then by priority', () => {
    const sorted = sortNavoreTasks([
      task({ id: 'done', status: 'complete', priority: 'urgent' }),
      task({ id: 'low', status: 'to do', priority: 'low' }),
      task({ id: 'urgent', status: 'to do', priority: 'urgent' }),
    ])
    assert.deepEqual(sorted.map((t) => t.id), ['urgent', 'low', 'done'])
  })

  it('counts only not-done ops + dev as open work', () => {
    // fixture: ops in-progress (open) + dev complete (done) → 1
    assert.equal(navoreOpenWork(selectClickup(fixture())), 1)
  })
})
