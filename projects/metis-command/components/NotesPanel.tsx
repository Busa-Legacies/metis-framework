'use client'

import { useEffect, useRef, useState } from 'react'
import { FileText, Save, Check, Loader2 } from 'lucide-react'
import { ptyApi } from '@/lib/pty-client'

interface Props {
  workspaceId: string | null
  workspaceName: string
}

export default function NotesPanel({ workspaceId, workspaceName }: Props) {
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!workspaceId) return
    setLoaded(false)
    ptyApi.getNotes(workspaceId).then((d) => {
      setText(d.notes ?? '')
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId || !loaded) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const wsId = workspaceId
    const t = text
    saveTimer.current = setTimeout(async () => {
      setSaving(true)
      try { await ptyApi.putNotes(wsId, t); setSavedAt(Date.now()) } finally { setSaving(false) }
    }, 700)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [workspaceId, text, loaded])

  const justSaved = savedAt && Date.now() - savedAt < 1500

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-slate-400/10 px-4 py-3">
        <FileText size={14} className="text-cyan-300" />
        <div className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-200/85">Notes</div>
        <span className="text-[10px] text-slate-500 truncate">— {workspaceName}</span>
        <div className="flex-1" />
        {saving ? <Loader2 size={12} className="animate-spin text-slate-400" />
          : justSaved ? <span className="flex items-center gap-1 text-[10px] text-emerald-300"><Check size={12} /> saved</span>
          : null}
      </header>
      <div className="flex-1 overflow-hidden flex flex-col gap-2 p-3">
        {!text.trim() && (
          <button
            onClick={() => setText(MISSION_TEMPLATE.replace(/\{\{name\}\}/g, workspaceName))}
            className="rounded-md border border-cyan-300/30 bg-cyan-300/10 px-2 py-1 text-[11px] text-cyan-100 hover:bg-cyan-300/20"
          >insert mission/vision template</button>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`# ${workspaceName} — Ops Brief\n\nWhat is this workspace? What lanes are active? What constraints must agents respect?\n\nGoals, success criteria, file scopes, stack, links, current focus.\n\nThis brief is injected into every claude agent spawned in this workspace as authoritative system context.`}
          className="h-full w-full resize-none rounded-lg border border-slate-400/15 bg-black/40 p-3 font-mono text-[12px] leading-5 text-slate-100 placeholder:text-slate-500 focus:border-cyan-300/40 focus:outline-none"
        />
      </div>
      <footer className="border-t border-slate-400/10 px-4 py-2 text-[10px] text-slate-500">
        markdown · auto-saves · injected to every claude agent spawned here
      </footer>
    </div>
  )
}

const MISSION_TEMPLATE = `# {{name}} — Ops Brief

## Objective
What should this workspace produce?

## Goal
The single concrete outcome we're moving toward in the next 30 days.

## Users / Customer
Who is this for? What pain are we solving?

## Constraints
- Hard limits (deadlines, budget, must-not-break, regulatory).
- Stack we have to work in.

## Success Criteria
- How will we know it works? (metrics, behaviors, ship signals)

## Stack & Repo
- Repo path / cwd:
- Languages / frameworks:
- Deploy target:

## Current Focus
What's the next visible deliverable, and which agent owns it.

## Links
- Spec / brief:
- Notion / Obsidian:
- Tracker:
`
