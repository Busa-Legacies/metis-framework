'use client'

import { useEffect, useMemo, useState } from 'react'
import { Hammer, Loader2, Search, WandSparkles } from 'lucide-react'
import { ptyApi } from '@/lib/pty-client'

interface SkillRow {
  name: string
  path: string
  root: string
  description: string
  updatedAt: string
}

interface Props {
  workspaceId: string | null
  workspaceName: string
}

function shortPath(path: string) {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

function dateLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function SkillsPanel({ workspaceId, workspaceName }: Props) {
  const [skills, setSkills] = useState<SkillRow[]>([])
  const [roots, setRoots] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId) {
      setSkills([])
      setRoots([])
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    ptyApi.listSkills(workspaceId, { limit: 220 })
      .then((result) => {
        if (!alive) return
        setSkills(result.skills)
        setRoots(result.roots)
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : 'failed to load skills')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => { alive = false }
  }, [workspaceId])

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return skills
    return skills.filter((skill) => {
      const haystack = `${skill.name}\n${skill.description}\n${skill.path}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }, [skills, query])

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-slate-400/10 px-4 py-3">
        <Hammer size={14} className="text-cyan-300" />
        <div className="text-[12px] font-bold uppercase tracking-[0.2em] text-cyan-200/85">Skills</div>
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
            placeholder="Search local skills..."
            className="min-w-0 flex-1 bg-transparent text-[12px] text-slate-100 placeholder:text-slate-500 focus:outline-none"
          />
        </label>

        <div className="rounded-md border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-[11px] leading-5 text-cyan-100">
          <div className="flex items-center gap-1 font-semibold"><WandSparkles size={12} /> Agent protocol</div>
          Agents are told to read matching skills first. If none exists, they may research and create a narrow new skill under the OpenClaw skills root, then report the path.
        </div>

        {error ? (
          <div className="rounded-md border border-rose-300/20 bg-rose-400/10 px-3 py-2 text-[11px] text-rose-200">{error}</div>
        ) : roots.length > 0 ? (
          <div className="rounded-md border border-slate-400/15 bg-black/25 px-2.5 py-2">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">roots</div>
            <div className="space-y-1">
              {roots.slice(0, 5).map((root) => (
                <div key={root} className="truncate font-mono text-[10px] text-slate-400" title={root}>{shortPath(root)}</div>
              ))}
              {roots.length > 5 ? <div className="text-[10px] text-slate-500">+{roots.length - 5} more</div> : null}
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {filtered.length === 0 && !loading ? (
            <div className="rounded-md border border-slate-400/15 bg-black/30 px-3 py-2 text-[11px] text-slate-400">
              No matching skills found.
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((skill) => (
                <article key={skill.path} className="rounded-lg border border-slate-400/15 bg-slate-950/50 p-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-semibold text-slate-100">{skill.name}</div>
                      <div className="mt-0.5 truncate font-mono text-[10px] text-slate-500" title={skill.path}>{shortPath(skill.path)}</div>
                    </div>
                    <div className="shrink-0 text-[10px] text-slate-500">{dateLabel(skill.updatedAt)}</div>
                  </div>
                  {skill.description ? <p className="mt-2 line-clamp-3 text-[11px] leading-5 text-slate-300">{skill.description}</p> : null}
                </article>
              ))}
            </div>
          )}
        </div>
      </div>

      <footer className="border-t border-slate-400/10 px-4 py-2 text-[10px] text-slate-500">
        OpenClaw/Codex/workspace skills · read before action
      </footer>
    </div>
  )
}
