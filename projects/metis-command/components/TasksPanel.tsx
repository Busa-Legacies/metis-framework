'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, X, Pencil, GitBranch, Eye, Trash2, Hammer, ShieldCheck } from 'lucide-react'
import { ptyApi } from '@/lib/pty-client'
import type { Agent, Task, TaskStatus } from '@/lib/types'
import { MetisLoader } from './ui/MetisLoader'

const COLS: { status: TaskStatus; label: string; color: string }[] = [
  { status: 'todo', label: 'todo', color: 'text-slate-300 border-slate-400/20' },
  { status: 'building', label: 'building', color: 'text-amber-200 border-amber-300/30' },
  { status: 'review', label: 'review', color: 'text-cyan-200 border-cyan-300/30' },
  { status: 'done', label: 'done', color: 'text-emerald-200 border-emerald-300/30' },
]

export default function TasksPanel({ workspaceId, agents, onError }: { workspaceId: string | null; agents: Agent[]; onError: (m: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<Task | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [evidenceCounts, setEvidenceCounts] = useState<Record<string, number>>({})

  const refresh = useCallback(async () => {
    if (!workspaceId) { setTasks([]); return }
    setLoading(true)
    try {
      const r = await ptyApi.listTasks(workspaceId)
      setTasks(r.tasks)
      const entries = await Promise.all(r.tasks.map(async (task) => {
        try {
          const ev = await ptyApi.listTaskEvidence(workspaceId, task.id)
          return [task.id, ev.evidence.length] as const
        } catch {
          return [task.id, 0] as const
        }
      }))
      setEvidenceCounts(Object.fromEntries(entries))
    } catch (e) {
      onError(e instanceof Error ? e.message : 'failed to load tasks')
    } finally {
      setLoading(false)
    }
  }, [workspaceId, onError])

  useEffect(() => { refresh() }, [refresh])

  async function create() {
    if (!workspaceId || !newTitle.trim()) return
    try {
      await ptyApi.createTask(workspaceId, { title: newTitle.trim() })
      setNewTitle('')
      await refresh()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'failed to create task')
    }
  }

  async function move(t: Task, status: TaskStatus) {
    if (!workspaceId || t.status === status) return
    try {
      await ptyApi.updateTask(workspaceId, t.id, { status })
      await refresh()
    } catch (e) {
      if (status === 'done' && e instanceof Error && e.message.includes('requires_evidence')) {
        const reason = window.prompt('Done requires report evidence plus review evidence. Enter an override reason to mark done anyway, or leave blank to cancel.')
        if (!reason?.trim()) return
        try {
          await ptyApi.updateTask(workspaceId, t.id, { status, overrideDoneGate: true, overrideReason: reason.trim() })
          await refresh()
          return
        } catch (overrideError) {
          onError(overrideError instanceof Error ? overrideError.message : 'failed to override done gate')
          return
        }
      }
      onError(e instanceof Error ? e.message : 'failed to move task')
    }
  }

  async function review(t: Task) {
    if (!workspaceId) return
    try {
      await ptyApi.reviewTask(workspaceId, t.id)
      await refresh()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'failed to spawn reviewer')
    }
  }

  async function build(t: Task) {
    if (!workspaceId) return
    try {
      await ptyApi.buildTask(workspaceId, t.id)
      await refresh()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'failed to spawn builder')
    }
  }

  async function remove(t: Task) {
    if (!workspaceId) return
    if (!confirm(`Delete task "${t.title}"?`)) return
    try {
      await ptyApi.deleteTask(workspaceId, t.id)
      await refresh()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'failed to delete task')
    }
  }

  if (!workspaceId) {
    return <div className="flex h-full items-center justify-center text-[12px] text-slate-500">no workspace selected</div>
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-slate-400/10 px-2 py-1.5">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') create() }}
          placeholder="add a task… (enter to save)"
          className="flex-1 rounded-md border border-slate-400/15 bg-black/40 px-2 py-1 text-[12px] text-white placeholder:text-slate-500 focus:border-cyan-300/40 focus:outline-none"
        />
        <button onClick={create} disabled={!newTitle.trim()} className="rounded-md border border-cyan-300/30 bg-cyan-300/10 px-2 py-1 text-[12px] text-cyan-100 hover:bg-cyan-300/20 disabled:opacity-40" title="add task">
          <Plus size={12} />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-2 py-2">
        {COLS.map((col) => {
          const items = tasks.filter((t) => t.status === col.status)
          return (
            <div key={col.status} className={`rounded-lg border bg-black/20 ${col.color}`}>
              <div className="flex items-center gap-2 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em]">
                <span>{col.label}</span>
                <span className="rounded-full bg-black/40 px-1.5 py-0 text-[9px] text-slate-400">{items.length}</span>
              </div>
              <div className="space-y-1 px-1.5 pb-1.5">
                {items.length === 0 && (
                  <div className="px-1 py-1 text-[10px] italic text-slate-600">empty</div>
                )}
                {items.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    agents={agents}
                    evidenceCount={evidenceCounts[t.id] ?? 0}
                    onMove={(s) => move(t, s)}
                    onEdit={() => setEditing(t)}
                    onBuild={() => build(t)}
                    onReview={() => review(t)}
                    onDelete={() => remove(t)}
                  />
                ))}
              </div>
            </div>
          )
        })}
        {loading && tasks.length === 0 && (
          <MetisLoader size={16} label="loading tasks…" inline className="px-2 py-1 text-[10px]" />
        )}
      </div>

      {editing && (
        <TaskEditDialog
          task={editing}
          agents={agents}
          workspaceId={workspaceId}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await refresh() }}
          onError={onError}
        />
      )}
    </div>
  )
}

function TaskCard({ task, agents, evidenceCount, onMove, onEdit, onBuild, onReview, onDelete }: {
  task: Task
  agents: Agent[]
  evidenceCount: number
  onMove: (s: TaskStatus) => void
  onEdit: () => void
  onBuild: () => void
  onReview: () => void
  onDelete: () => void
}) {
  const owner = agents.find((a) => a.id === task.ownerId)
  const fileCount = task.files?.length ?? 0
  return (
    <div className="group rounded-md border border-slate-400/10 bg-black/40 p-1.5 text-[11px] text-slate-200 hover:border-slate-400/25">
      <div className="flex items-start gap-1">
        <span className="flex-1 truncate font-medium" title={task.title}>{task.title}</span>
        <button onClick={onEdit} className="opacity-0 transition group-hover:opacity-60 hover:opacity-100" title="edit"><Pencil size={12} /></button>
        <button onClick={onDelete} className="opacity-0 transition group-hover:opacity-60 hover:opacity-100 hover:text-rose-300" title="delete"><Trash2 size={12} /></button>
      </div>
      {(owner || fileCount > 0 || evidenceCount > 0) && (
        <div className="mt-0.5 flex items-center gap-2 text-[9px] text-slate-500">
          {owner && <span title={`owner: ${owner.name}`} className="truncate">@{owner.name}</span>}
          {fileCount > 0 && <span title={(task.files ?? []).join('\n')} className="flex items-center gap-0.5"><GitBranch size={12} />{fileCount}</span>}
          {evidenceCount > 0 && <span title="evidence rows recorded for this task" className="flex items-center gap-0.5 text-indigo-200/80"><ShieldCheck size={12} />{evidenceCount}</span>}
        </div>
      )}
      <div className="mt-1 flex items-center gap-1">
        <select
          value={task.status}
          onChange={(e) => onMove(e.target.value as TaskStatus)}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 rounded border border-slate-400/15 bg-black/50 px-1 py-0.5 text-[10px] text-slate-200 focus:border-cyan-300/40 focus:outline-none"
        >
          {COLS.map((c) => <option key={c.status} value={c.status}>→ {c.label}</option>)}
        </select>
        {(task.status === 'todo' || task.status === 'building') && (
          <button onClick={onBuild} title="spawn codex builder" className="rounded border border-amber-300/30 bg-amber-300/10 p-0.5 text-amber-200 hover:bg-amber-300/20"><Hammer size={12} /></button>
        )}
        {(task.status === 'building' || task.status === 'review') && (
          <button onClick={onReview} title="spawn reviewer claude" className="rounded border border-cyan-300/30 bg-cyan-300/10 p-0.5 text-cyan-200 hover:bg-cyan-300/20"><Eye size={12} /></button>
        )}
      </div>
    </div>
  )
}

function TaskEditDialog({ task, agents, workspaceId, onClose, onSaved, onError }: {
  task: Task
  agents: Agent[]
  workspaceId: string
  onClose: () => void
  onSaved: () => Promise<void>
  onError: (m: string) => void
}) {
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description ?? '')
  const [ownerId, setOwnerId] = useState(task.ownerId ?? '')
  const [filesText, setFilesText] = useState((task.files ?? []).join('\n'))

  async function save() {
    try {
      const files = filesText.split('\n').map((s) => s.trim()).filter(Boolean)
      if (files.length > 0) {
        try {
          await ptyApi.claimTaskFiles(workspaceId, task.id, files)
        } catch (e: unknown) {
          const err = e as { status?: number; conflicts?: { file: string; title: string }[] }
          if (err.status === 409) {
            const list = (err.conflicts ?? []).map((c) => `· ${c.file} → "${c.title}"`).join('\n')
            onError(`file ownership conflict:\n${list}`)
            return
          }
          throw e
        }
      }
      await ptyApi.updateTask(workspaceId, task.id, {
        title: title.trim() || task.title,
        description: description.trim(),
        ownerId: ownerId || undefined,
      })
      await onSaved()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'failed to save task')
    }
  }

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-slate-400/20 bg-black/95 p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2">
          <div className="flex-1 text-[13px] font-bold uppercase tracking-[0.2em] text-cyan-200/85">edit task</div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:text-white"><X size={14} /></button>
        </div>

        <label className="mb-1 block text-[10px] uppercase tracking-[0.18em] text-slate-400">title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="mb-3 w-full rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 text-[13px] text-white focus:border-cyan-300/40 focus:outline-none" />

        <label className="mb-1 block text-[10px] uppercase tracking-[0.18em] text-slate-400">description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="mb-3 w-full rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 text-[13px] text-white focus:border-cyan-300/40 focus:outline-none" />

        <label className="mb-1 block text-[10px] uppercase tracking-[0.18em] text-slate-400">owner agent</label>
        <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className="mb-3 w-full rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 text-[13px] text-white focus:border-cyan-300/40 focus:outline-none">
          <option value="">— none —</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.kind})</option>)}
        </select>

        <label className="mb-1 block text-[10px] uppercase tracking-[0.18em] text-slate-400">files (one per line; blocks overlap with other active tasks)</label>
        <textarea value={filesText} onChange={(e) => setFilesText(e.target.value)} rows={4} placeholder="src/foo.ts\nsrc/bar.ts" className="mb-4 w-full rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 font-mono text-[12px] text-white focus:border-cyan-300/40 focus:outline-none" />

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-slate-400/15 px-3 py-1.5 text-[12px] text-slate-300 hover:text-white">cancel</button>
          <button onClick={save} className="rounded-md border border-cyan-300/30 bg-cyan-300/10 px-3 py-1.5 text-[12px] text-cyan-100 hover:bg-cyan-300/20">save</button>
        </div>
      </div>
    </div>
  )
}
