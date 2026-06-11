'use client'

import { useMemo, useState } from 'react'
import type { AgentLane, DispatchEvent, TaskStatus, WorkbenchState, WorkbenchTask } from '@/lib/types'

const columns: { id: TaskStatus; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'ready', label: 'Ready' },
  { id: 'running', label: 'Running' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
  { id: 'blocked', label: 'Blocked' },
]

const laneColor = {
  violet: 'border-violet-400/30 bg-violet-400/10 text-violet-200',
  cyan: 'border-cyan-300/30 bg-cyan-300/10 text-cyan-100',
  amber: 'border-amber-300/30 bg-amber-300/10 text-amber-100',
  emerald: 'border-emerald-300/30 bg-emerald-300/10 text-emerald-100',
}

function StatusPill({ status }: { status: string }) {
  const cls = status === 'running' ? 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200'
    : status === 'blocked' ? 'border-rose-300/30 bg-rose-300/10 text-rose-200'
    : status === 'review' || status === 'review-ready' ? 'border-amber-300/30 bg-amber-300/10 text-amber-200'
    : 'border-slate-300/20 bg-slate-300/10 text-slate-300'
  return <span className={`badge ${cls}`}>{status}</span>
}

function TaskCard({ task, selected, onSelect }: { task: WorkbenchTask; selected: boolean; onSelect: () => void }) {
  const priority = task.priority === 'critical' ? 'text-rose-300' : task.priority === 'high' ? 'text-amber-300' : 'text-slate-300'
  return (
    <button
      onClick={onSelect}
      className={`w-full rounded-xl border p-3 text-left transition hover:-translate-y-0.5 hover:border-cyan-300/40 ${selected ? 'border-cyan-300/60 bg-cyan-300/10' : 'border-slate-400/10 bg-black/20'}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className={`text-[10px] font-bold uppercase tracking-[0.16em] ${priority}`}>{task.priority}</span>
        <span className="text-[10px] text-slate-500">{task.project}</span>
      </div>
      <div className="text-sm font-semibold text-white">{task.title}</div>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">{task.summary}</p>
    </button>
  )
}

function VoiceHud({ state }: { state: WorkbenchState['voice'] }) {
  return (
    <div className="panel relative overflow-hidden rounded-2xl p-4 scanline">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.24em] text-cyan-200/80">Voice HUD</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-cyan-300 pulse-dot" />
            <span className="text-lg font-black tracking-tight text-white">{state.state}</span>
          </div>
        </div>
        <div className="h-10 flex-1 max-w-xl overflow-hidden rounded-full border border-cyan-300/20 bg-cyan-300/5 px-4 py-2 text-sm text-cyan-50/85">
          {state.transcriptPreview}
        </div>
        <div className="text-right text-[10px] uppercase tracking-[0.18em] text-slate-500">
          Target<br />{state.target ?? 'none'}
        </div>
      </div>
    </div>
  )
}

function AgentLaneCard({ lane }: { lane: AgentLane }) {
  return (
    <div className={`rounded-2xl border p-4 ${laneColor[lane.color]}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-black text-white">{lane.label}</div>
          <div className="mt-1 text-xs opacity-80">{lane.role}</div>
        </div>
        <StatusPill status={lane.status} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded-lg bg-black/25 p-2">
          <div className="text-slate-500">Model</div>
          <div className="mt-1 font-semibold text-white">{lane.model}</div>
        </div>
        <div className="rounded-lg bg-black/25 p-2">
          <div className="text-slate-500">Task</div>
          <div className="mt-1 font-semibold text-white">{lane.currentTaskId ?? '—'}</div>
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-2 text-xs leading-5 text-slate-300">
        {lane.lastEvent}
      </div>
    </div>
  )
}

function ReviewGate({ task }: { task: WorkbenchTask }) {
  const missing = task.artifacts.filter((item) => item.status === 'missing' || item.status === 'failed')
  const canShip = missing.length === 0 && task.artifacts.length > 0
  return (
    <div className="panel rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-amber-200/80">Review Gate</div>
          <div className="mt-1 text-sm font-semibold text-white">{canShip ? 'Evidence complete' : `${missing.length} blocker(s)`}</div>
        </div>
        <StatusPill status={canShip ? 'done-ready' : 'blocked'} />
      </div>
      <div className="space-y-2">
        {task.artifacts.map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-400/10 bg-black/20 p-3">
            <div>
              <div className="text-sm font-semibold text-white">{item.label}</div>
              <div className="mt-1 text-xs text-slate-500">{item.kind} · {item.value}</div>
            </div>
            <StatusPill status={item.status} />
          </div>
        ))}
      </div>
    </div>
  )
}

function DispatchLedger({ events }: { events: DispatchEvent[] }) {
  return (
    <div className="panel rounded-2xl p-4">
      <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-200/80">Dispatch Ledger</div>
      <div className="space-y-2">
        {events.slice(0, 6).map((event) => (
          <div key={event.id} className="rounded-xl border border-slate-400/10 bg-black/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-bold text-white">{event.target}</div>
              <StatusPill status={event.status} />
            </div>
            <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400">{event.promptPreview}</p>
            <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
              <span>{event.timestampCt}</span>
              <span>hash {event.promptHash}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function WorkbenchApp({ initialState }: { initialState: WorkbenchState }) {
  const [state] = useState(initialState)
  const [selectedId, setSelectedId] = useState(initialState.tasks[0]?.id)
  const selectedTask = state.tasks.find((task) => task.id === selectedId) ?? state.tasks[0]

  const grouped = useMemo(() => {
    return columns.map((column) => ({ ...column, tasks: state.tasks.filter((task) => task.status === column.id) }))
  }, [state.tasks])

  return (
    <main className="grid-bg min-h-screen p-5">
      <div className="mx-auto max-w-[1800px] space-y-5">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.28em] text-cyan-200/80">Jarvis Command Surface</div>
            <h1 className="mt-2 text-4xl font-black tracking-[-0.04em] text-white">Agent Workbench</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
              BridgeMind-style task rooms for visible Claude/Codex/Jarvis execution: task board, workspace lanes, voice HUD, dispatch ledger, and review gate.
            </p>
          </div>
          <div className="flex gap-2 text-xs text-slate-400">
            <span className="badge border-cyan-300/25 bg-cyan-300/10 text-cyan-100">local-first</span>
            <span className="badge border-violet-300/25 bg-violet-300/10 text-violet-100">human review</span>
            <span className="badge border-amber-300/25 bg-amber-300/10 text-amber-100">no false done</span>
          </div>
        </header>

        <VoiceHud state={state.voice} />

        <section className="grid gap-5 xl:grid-cols-[1.15fr_1.6fr_.95fr]">
          <div className="panel rounded-2xl p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">Task Board</div>
              <span className="text-xs text-slate-500">{state.tasks.length} tasks</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-1">
              {grouped.map((column) => (
                <div key={column.id} className="rounded-2xl border border-slate-400/10 bg-black/20 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-xs font-black uppercase tracking-[0.14em] text-slate-300">{column.label}</div>
                    <span className="text-xs text-slate-500">{column.tasks.length}</span>
                  </div>
                  <div className="space-y-2">
                    {column.tasks.length === 0 ? <div className="rounded-xl border border-dashed border-slate-400/10 p-3 text-xs text-slate-600">Empty</div> : null}
                    {column.tasks.map((task) => (
                      <TaskCard key={task.id} task={task} selected={task.id === selectedTask.id} onSelect={() => setSelectedId(task.id)} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-5">
            <div className="panel rounded-2xl p-5">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-200/80">Workspace Room</div>
                  <h2 className="mt-1 text-2xl font-black text-white">{selectedTask.title}</h2>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">{selectedTask.summary}</p>
                </div>
                <StatusPill status={selectedTask.status} />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                {state.lanes.map((lane) => <AgentLaneCard key={lane.id} lane={lane} />)}
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <div className="panel rounded-2xl p-4">
                <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.22em] text-violet-200/80">Instructions</div>
                <ul className="space-y-2">
                  {selectedTask.instructions.map((item) => <li key={item} className="rounded-xl border border-slate-400/10 bg-black/20 p-3 text-sm leading-6 text-slate-300">{item}</li>)}
                </ul>
              </div>
              <div className="panel rounded-2xl p-4">
                <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-200/80">Knowledge</div>
                <ul className="space-y-2">
                  {selectedTask.knowledge.map((item) => <li key={item} className="rounded-xl border border-slate-400/10 bg-black/20 p-3 text-sm leading-6 text-slate-300">{item}</li>)}
                </ul>
              </div>
            </div>
          </div>

          <aside className="space-y-5">
            <ReviewGate task={selectedTask} />
            <DispatchLedger events={state.dispatches} />
          </aside>
        </section>
      </div>
    </main>
  )
}
