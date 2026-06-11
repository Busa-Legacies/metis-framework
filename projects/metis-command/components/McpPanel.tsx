'use client'

import { useEffect, useRef, useState } from 'react'
import { Plug, Plus, Trash2, ToggleLeft, ToggleRight, Loader2, Download, X } from 'lucide-react'
import { ptyApi } from '@/lib/pty-client'

interface McpServer {
  id: string
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  enabled: boolean
}

interface Props {
  workspaceId: string | null
  workspaceName: string
}

const PRESETS: { name: string; command: string; args: string[]; tip: string }[] = [
  { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '~'], tip: 'read/write files in your home tree' },
  { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], tip: 'GitHub repos & issues (needs GITHUB_TOKEN)' },
  { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], tip: 'persistent kv memory store' },
  { name: 'puppeteer', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'], tip: 'web automation' },
]

interface DiscoveredMcp { source: string; name: string; command: string; args?: string[]; env?: Record<string, string> }

export default function McpPanel({ workspaceId, workspaceName }: Props) {
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [discovered, setDiscovered] = useState<DiscoveredMcp[]>([])
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [importing, setImporting] = useState(false)

  async function load() {
    if (!workspaceId) return
    setLoading(true)
    try { const r = await ptyApi.getMcpServers(workspaceId); setServers(r.servers) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [workspaceId])

  async function save(next: McpServer[]) {
    if (!workspaceId) return
    setServers(next)
    await ptyApi.putMcpServers(workspaceId, next).catch(() => {})
  }

  function addServer(name: string, command: string, args: string[], env: Record<string, string> = {}) {
    const id = `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`
    save([...servers, { id, name, command, args, env, enabled: true }])
  }

  async function openImport() {
    setShowImport(true)
    setPicked({})
    try {
      const r = await ptyApi.discoverMcp()
      setDiscovered(r.discovered)
      // pre-pick anything not already in the workspace
      const existing = new Set(servers.map((s) => s.name))
      const next: Record<string, boolean> = {}
      for (let i = 0; i < r.discovered.length; i++) {
        if (!existing.has(r.discovered[i].name)) next[String(i)] = true
      }
      setPicked(next)
    } catch (e) { /* show in panel */ }
  }

  async function importPicked() {
    setImporting(true)
    try {
      const additions: McpServer[] = discovered
        .map((d, i) => ({ d, i }))
        .filter(({ i }) => picked[String(i)])
        .map(({ d, i }) => ({
          id: `mcp_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 4)}`,
          name: d.name,
          command: d.command,
          args: d.args ?? [],
          env: d.env ?? {},
          enabled: true,
        }))
      // dedupe against existing names (replace)
      const byName = new Map(servers.map((s) => [s.name, s]))
      for (const a of additions) byName.set(a.name, a)
      await save([...byName.values()])
      setShowImport(false)
    } finally { setImporting(false) }
  }

  function update(id: string, patch: Partial<McpServer>) { save(servers.map((s) => s.id === id ? { ...s, ...patch } : s)) }
  function remove(id: string) { save(servers.filter((s) => s.id !== id)) }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-slate-400/10 px-4 py-3">
        <Plug size={14} className="text-cyan-300" />
        <div className="text-[12px] font-bold uppercase tracking-[0.2em] text-cyan-200/85">MCP Servers</div>
        <span className="text-[10px] text-slate-500 truncate">— {workspaceName}</span>
        <div className="flex-1" />
        {loading && <Loader2 size={12} className="animate-spin text-slate-400" />}
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {servers.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-400/15 p-3 text-[12px] text-slate-500">
            No MCP servers configured. Add one below — they auto-load when you spawn a Claude agent in this workspace.
          </div>
        )}
        {servers.map((s) => (
          <div key={s.id} className="rounded-lg border border-slate-400/15 bg-black/30 p-2">
            <div className="flex items-center gap-2">
              <button onClick={() => update(s.id, { enabled: !s.enabled })} title={s.enabled ? 'disable' : 'enable'} className={s.enabled ? 'text-emerald-300' : 'text-slate-500'}>
                {s.enabled ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
              </button>
              <input
                value={s.name}
                onChange={(e) => update(s.id, { name: e.target.value })}
                className="rounded-md border border-slate-400/15 bg-black/40 px-1.5 py-0.5 text-[12px] font-semibold text-white focus:border-cyan-300/40 focus:outline-none"
              />
              <div className="flex-1" />
              <button onClick={() => remove(s.id)} className="rounded p-1 text-slate-400 hover:text-rose-300"><Trash2 size={12} /></button>
            </div>
            <div className="mt-1.5 grid grid-cols-[60px_1fr] gap-1 text-[11px]">
              <span className="text-slate-500">cmd</span>
              <input
                value={s.command}
                onChange={(e) => update(s.id, { command: e.target.value })}
                placeholder="npx"
                className="rounded border border-slate-400/15 bg-black/40 px-1.5 py-0.5 text-[12px] text-white focus:border-cyan-300/40 focus:outline-none"
              />
              <span className="text-slate-500">args</span>
              <input
                value={(s.args ?? []).join(' ')}
                onChange={(e) => update(s.id, { args: e.target.value.split(/\s+/).filter(Boolean) })}
                placeholder="-y @modelcontextprotocol/server-filesystem ~"
                className="rounded border border-slate-400/15 bg-black/40 px-1.5 py-0.5 text-[12px] text-white focus:border-cyan-300/40 focus:outline-none"
              />
              <span className="text-slate-500">env</span>
              <EnvEditor value={s.env ?? {}} onChange={(env) => update(s.id, { env })} />
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-slate-400/10 p-3">
        <div className="mb-2 flex items-center gap-2">
          <button
            onClick={openImport}
            className="flex items-center gap-1 rounded-md border border-violet-300/30 bg-violet-300/10 px-2 py-1 text-[11px] font-semibold text-violet-100 hover:bg-violet-300/20"
            title="import MCP servers from your existing claude/codex/openclaw configs"
          >
            <Download size={12} /> import existing
          </button>
          <span className="text-[10px] text-slate-500">scans claude.json, openclaw, claude desktop, codex</span>
        </div>
        <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Quick add</div>
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              onClick={() => addServer(p.name, p.command, p.args)}
              title={p.tip}
              className="flex items-center gap-1 rounded-md border border-slate-400/20 bg-black/30 px-2 py-1 text-[11px] text-slate-300 hover:border-cyan-300/30 hover:text-white"
            >
              <Plus size={12} /> {p.name}
            </button>
          ))}
          <button
            onClick={() => addServer('custom', 'npx', [])}
            className="flex items-center gap-1 rounded-md border border-cyan-300/30 bg-cyan-300/10 px-2 py-1 text-[11px] text-cyan-100 hover:bg-cyan-300/20"
          >
            <Plus size={12} /> blank
          </button>
        </div>
        <div className="mt-2 text-[10px] text-slate-500">
          Auto-injected as <code className="text-slate-300">--mcp-config</code> on Claude spawns. Codex picks up MCP via its own config.
        </div>
      </div>

      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={() => setShowImport(false)}>
          <div className="w-full max-w-lg rounded-2xl border border-slate-400/20 bg-black/95 p-4 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center gap-2">
              <Download size={14} className="text-violet-300" />
              <div className="text-[13px] font-bold uppercase tracking-[0.2em] text-violet-200">Import MCP servers</div>
              <div className="flex-1" />
              <button onClick={() => setShowImport(false)} className="rounded p-1 text-slate-400 hover:text-white"><X size={12} /></button>
            </div>
            <div className="mb-2 text-[11px] text-slate-400">Found {discovered.length} server{discovered.length === 1 ? '' : 's'} from your existing configs. Pick the ones to add to <span className="text-cyan-200">{workspaceName}</span>:</div>
            <div className="max-h-[55vh] space-y-1 overflow-y-auto">
              {discovered.map((d, i) => {
                const checked = !!picked[String(i)]
                const exists = servers.some((s) => s.name === d.name)
                return (
                  <label key={i} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 ${checked ? 'border-violet-300/40 bg-violet-300/5' : 'border-slate-400/15 bg-black/30'}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => setPicked((p) => ({ ...p, [String(i)]: e.target.checked }))}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white">{d.name}</span>
                        {exists && <span className="rounded border border-amber-300/30 bg-amber-300/10 px-1 text-[9px] text-amber-200">already added — will replace</span>}
                      </div>
                      <div className="truncate text-[11px] text-slate-400" title={`${d.command} ${(d.args || []).join(' ')}`}>
                        <code>{d.command} {(d.args || []).join(' ')}</code>
                      </div>
                      <div className="text-[10px] text-slate-500">from {d.source}{Object.keys(d.env || {}).length ? ` · env: ${Object.keys(d.env || {}).join(', ')}` : ''}</div>
                    </div>
                  </label>
                )
              })}
              {discovered.length === 0 && (
                <div className="rounded-md border border-slate-400/15 p-3 text-[12px] text-slate-400">No MCP servers found in your existing configs.</div>
              )}
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setShowImport(false)} className="rounded-md border border-slate-400/20 px-3 py-1.5 text-[12px] text-slate-300 hover:text-white">Cancel</button>
              <button
                onClick={importPicked}
                disabled={importing || Object.values(picked).every((v) => !v)}
                className="flex items-center gap-1 rounded-md border border-violet-300/30 bg-violet-300/10 px-3 py-1.5 text-[12px] text-violet-100 hover:bg-violet-300/20 disabled:opacity-40"
              >
                {importing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                Import {Object.values(picked).filter(Boolean).length} server{Object.values(picked).filter(Boolean).length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function EnvEditor({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const [text, setText] = useState(() => Object.entries(value).map(([k, v]) => `${k}=${v}`).join('\n'))
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  return (
    <textarea
      value={text}
      onChange={(e) => {
        const t = e.target.value
        setText(t)
        if (debounce.current) clearTimeout(debounce.current)
        debounce.current = setTimeout(() => {
          const next: Record<string, string> = {}
          for (const line of t.split(/\n/)) {
            const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
            if (m) next[m[1]] = m[2]
          }
          onChange(next)
        }, 300)
      }}
      placeholder="GITHUB_TOKEN=ghp_..."
      rows={2}
      className="rounded border border-slate-400/15 bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-white focus:border-cyan-300/40 focus:outline-none"
    />
  )
}
