'use client'

import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Link2, Loader2, Search, Tag } from 'lucide-react'
import { ptyApi } from '@/lib/pty-client'

interface KnowledgeNote {
  id: string
  title: string
  tags: string[]
  relativePath: string
  sourceName?: string
  sourcePath?: string
  updatedAt: string
  preview: string
  wikilinks: number
  score?: number
  matches: string[]
}

interface KnowledgeResponse {
  workspaceId: string
  workspaceName: string
  memoryDirName: string
  memoryDir: string
  existed: boolean
  roots?: { name: string; path: string; kind: string }[]
  notes: KnowledgeNote[]
  error?: string
}

interface Props {
  workspaceId: string | null
  workspaceName: string
}

function dateLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function KnowledgePanel({ workspaceId, workspaceName }: Props) {
  const [query, setQuery] = useState('')
  const [data, setData] = useState<KnowledgeResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId) {
      setData(null)
      setError(null)
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const result = await ptyApi.listMemory(workspaceId, { q: query, limit: 30 })
        if (!controller.signal.aborted) setData(result)
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'failed to load memory')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 250)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [workspaceId, query])

  const noteCount = data?.notes.length ?? 0
  const memoryLabel = useMemo(() => data?.memoryDirName ?? '.workbenchmemory', [data?.memoryDirName])
  const roots = data?.roots ?? []

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-slate-400/10 px-4 py-3">
        <BookOpen size={14} className="text-cyan-300" />
        <div className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-200/85">Knowledge</div>
        <span className="truncate text-[10px] text-slate-500">— {workspaceName}</span>
        <div className="flex-1" />
        {loading ? <Loader2 size={12} className="animate-spin text-slate-400" /> : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <label className="flex items-center gap-2 rounded-lg border border-slate-400/15 bg-black/40 px-2.5 py-2">
          <Search size={12} className="shrink-0 text-slate-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search decisions, specs, links..."
            className="min-w-0 flex-1 bg-transparent text-[12px] text-slate-100 placeholder:text-slate-500 focus:outline-none"
          />
        </label>

        {error ? (
          <div className="rounded-md border border-rose-300/20 bg-rose-400/10 px-3 py-2 text-[11px] text-rose-200">{error}</div>
        ) : !workspaceId ? (
          <div className="rounded-md border border-slate-400/15 bg-black/30 px-3 py-2 text-[11px] text-slate-400">
            Select a workspace to inspect its shared memory.
          </div>
        ) : data && !data.existed ? (
          <div className="rounded-md border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-[11px] leading-5 text-cyan-100">
            No local knowledge roots are currently readable for this workspace.
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {roots.length > 0 ? (
              <div className="mb-2 rounded-md border border-slate-400/15 bg-black/25 px-2.5 py-2">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">sources</div>
                <div className="flex flex-wrap gap-1">
                  {roots.slice(0, 8).map((root) => (
                    <span key={root.path} title={root.path} className="rounded-full border border-slate-400/15 bg-slate-900/60 px-1.5 py-0.5 text-[10px] text-slate-300">
                      {root.name}
                    </span>
                  ))}
                  {roots.length > 8 ? <span className="px-1 py-0.5 text-[10px] text-slate-500">+{roots.length - 8}</span> : null}
                </div>
              </div>
            ) : null}
            {noteCount === 0 && !loading ? (
              <div className="rounded-md border border-slate-400/15 bg-black/30 px-3 py-2 text-[11px] text-slate-400">
                No matching local knowledge.
              </div>
            ) : (
              <div className="space-y-2">
                {(data?.notes ?? []).map((note) => (
                  <article key={note.relativePath} className="rounded-lg border border-slate-400/15 bg-slate-950/50 p-3">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-semibold text-slate-100">{note.title}</div>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                          {note.sourceName ? `${note.sourceName}/` : ''}{note.relativePath}
                        </div>
                      </div>
                      <div className="shrink-0 text-[10px] text-slate-500">{dateLabel(note.updatedAt)}</div>
                    </div>
                    {note.preview ? <p className="mt-2 line-clamp-3 text-[11px] leading-5 text-slate-300">{note.preview}</p> : null}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {note.tags.slice(0, 4).map((tag) => (
                        <span key={tag} className="inline-flex items-center gap-1 rounded-full border border-slate-400/15 bg-black/25 px-1.5 py-0.5 text-[10px] text-slate-300">
                          <Tag size={12} className="text-slate-500" />{tag}
                        </span>
                      ))}
                      {note.wikilinks > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-1.5 py-0.5 text-[10px] text-cyan-200">
                          <Link2 size={12} />{note.wikilinks}
                        </span>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="border-t border-slate-400/10 px-4 py-2 text-[10px] text-slate-500">
        {memoryLabel} · Obsidian/OpenClaw/Claude/Codex · read-only
      </footer>
    </div>
  )
}
