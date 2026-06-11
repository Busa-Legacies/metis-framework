'use client'

import { useEffect, useState } from 'react'
import { Settings, X, KeyRound, LogIn, Check, Loader2, ExternalLink, Brain, ShieldCheck, ShieldAlert } from 'lucide-react'
import type { AgentKind } from '@/lib/types'

interface SettingsState {
  hasOpenAIKey: boolean
  openaiApiKey?: string
  assistantModel?: string
  fallbackModel?: string
  assistantProvider?: 'auto' | 'openclaw' | 'openai' | 'codex-cli' | 'claude-cli'
  assistantPersona?: 'workbench' | 'metis-brain' | 'jarvis'
  hasBridgeKey?: boolean
  bridgeApiKey?: string
  autonomousHopCap?: number
}

interface AuthStatus {
  claude: { installed: boolean; signedIn: boolean }
  codex: { installed: boolean; signedIn: boolean }
  gemini: { installed: boolean; signedIn: boolean }
  openai: { hasKey: boolean }
}

interface Props {
  open: boolean
  onClose: () => void
  activeWorkspaceId: string | null
  onSpawnLogin: (kind: AgentKind, name: string, cmd?: string, args?: string[]) => Promise<void>
}

const SIGNINS: { kind: AgentKind; label: string; provider: 'claude' | 'codex' | 'gemini'; cmd: string; args: string[]; tip: string }[] = [
  { kind: 'claude', provider: 'claude', label: 'Sign in with Claude',  cmd: 'claude', args: ['login'], tip: 'opens claude.ai OAuth in your browser' },
  { kind: 'codex',  provider: 'codex',  label: 'Sign in with OpenAI',  cmd: 'codex',  args: ['login'], tip: 'opens ChatGPT OAuth (uses your account)' },
  { kind: 'gemini', provider: 'gemini', label: 'Sign in with Google',  cmd: 'gemini', args: ['auth', 'login'], tip: 'opens Google OAuth' },
]

export default function SettingsDrawer({ open, onClose, activeWorkspaceId, onSpawnLogin }: Props) {
  const [s, setS] = useState<SettingsState>({ hasOpenAIKey: false, assistantProvider: 'auto' })
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [model, setModel] = useState('gpt-5.5')
  const [fallback, setFallback] = useState('gpt-4o')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  async function load() {
    const [sr, ar] = await Promise.all([
      fetch('/api/settings').then(r => r.json()).catch(() => ({})),
      fetch('/api/auth/status').then(r => r.json()).catch(() => null),
    ])
    setS(sr)
    setAuth(ar)
    if (sr.assistantModel) setModel(sr.assistantModel)
    if (sr.fallbackModel) setFallback(sr.fallbackModel)
  }

  useEffect(() => {
    if (!open) return
    load()
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [open])

  async function save(patch: Partial<SettingsState> & { openaiApiKey?: string; clearOpenAI?: boolean }) {
    setSaving(true)
    try {
      const r = await fetch('/api/settings', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
      })
      const d = await r.json()
      setS((cur) => ({ ...cur, ...d }))
      setSavedAt(Date.now())
      if (patch.openaiApiKey) setKeyInput('')
    } finally { setSaving(false) }
  }

  if (!open) return null
  const justSaved = savedAt && Date.now() - savedAt < 1500

  const provider = s.assistantProvider || 'auto'

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <aside
        onMouseDown={(e) => e.stopPropagation()}
        className="relative z-50 flex h-full w-full max-w-md flex-col border-l border-slate-400/20 bg-[var(--panel)] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-slate-400/10 px-5 py-4">
          <div className="flex items-center gap-2">
            <Settings size={16} className="text-cyan-300" />
            <div className="text-[13px] font-bold uppercase tracking-[0.22em] text-cyan-100">Settings</div>
          </div>
          <button onClick={onClose} className="rounded-lg border border-slate-400/15 bg-black/30 p-1.5 text-slate-300 hover:text-white">
            <X size={14} />
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          {/* Sign-In via OAuth */}
          <section>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">Sign In (OAuth)</div>
            <p className="mb-3 text-[12px] leading-5 text-slate-500">
              No API key required. Each click opens that provider's login page in your browser; once you authenticate, that account powers both the CLI tabs and the in-app assistant.
            </p>
            <div className="space-y-2">
              {SIGNINS.map((row) => {
                const a = auth?.[row.provider]
                const installed = a?.installed
                const signedIn = a?.signedIn
                return (
                  <div key={row.kind} className="rounded-lg border border-slate-400/15 bg-black/30 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <div className="font-semibold text-white">{row.label}</div>
                        {signedIn ? (
                          <span className="badge border-emerald-300/40 bg-emerald-300/10 text-emerald-200"><ShieldCheck size={12} className="mr-1" /> signed in</span>
                        ) : installed ? (
                          <span className="badge border-amber-300/40 bg-amber-300/10 text-amber-200"><ShieldAlert size={12} className="mr-1" /> not signed in</span>
                        ) : (
                          <span className="badge border-rose-300/40 bg-rose-300/10 text-rose-200">not installed</span>
                        )}
                      </div>
                      <button
                        onClick={async () => {
                          if (!activeWorkspaceId) return
                          await onSpawnLogin(row.kind, `${row.kind}-login`, row.cmd, row.args)
                          onClose()
                        }}
                        disabled={!installed || !activeWorkspaceId}
                        className="flex items-center gap-1 rounded-md border border-cyan-300/30 bg-cyan-300/10 px-2.5 py-1 text-[12px] text-cyan-100 hover:bg-cyan-300/20 disabled:opacity-40"
                      >
                        <LogIn size={12} /> {signedIn ? 're-auth' : 'sign in'} <ExternalLink size={12} />
                      </button>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">{row.tip}</div>
                  </div>
                )
              })}
            </div>
          </section>

          {/* Assistant brain */}
          <section>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">Assistant Brain</div>
            <p className="mb-3 text-[12px] leading-5 text-slate-500">Which provider runs the in-app chat panel that spawns agents on your behalf.</p>
            <div className="grid grid-cols-2 gap-2">
              {([
                { id: 'auto', label: 'Auto', tip: 'Metis Brain → claude → codex → key' },
                { id: 'openclaw', label: 'Metis Brain', tip: 'canonical OpenClaw route' },
                { id: 'claude-cli', label: 'Claude (OAuth)', tip: 'uses claude login' },
                { id: 'codex-cli', label: 'OpenAI (OAuth)', tip: 'uses codex login' },
                { id: 'openai', label: 'OpenAI Key', tip: 'paste API key' },
              ] as const).map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => save({ assistantProvider: opt.id as any })}
                  className={`rounded-lg border px-3 py-2 text-left text-[12px] transition ${provider === opt.id ? 'border-cyan-300/40 bg-cyan-300/10 text-white' : 'border-slate-400/15 bg-black/30 text-slate-300 hover:text-white'}`}
                >
                  <div className="flex items-center gap-1.5"><Brain size={12} /> <span className="font-bold">{opt.label}</span></div>
                  <div className="mt-1 text-[10px] text-slate-500">{opt.tip}</div>
                </button>
              ))}
            </div>
          </section>

          {/* OpenAI key (only relevant if provider=openai) */}
          <section className={provider === 'openai' ? '' : 'opacity-60'}>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">OpenAI API Key (optional)</div>
            <p className="mb-3 text-[12px] leading-5 text-slate-500">Only needed if you set Assistant Brain to "OpenAI Key". Stored at <code className="text-slate-300">~/.openclaw/metis-command/settings.json</code>.</p>
            <div className="mb-2 flex items-center gap-2 text-[12px]">
              <KeyRound size={12} className={s.hasOpenAIKey ? 'text-emerald-300' : 'text-slate-500'} />
              <span className={s.hasOpenAIKey ? 'text-emerald-200' : 'text-slate-400'}>
                {s.hasOpenAIKey ? `connected (${s.openaiApiKey})` : 'no key set'}
              </span>
            </div>
            <div className="flex gap-2">
              <input
                type="password" placeholder="sk-..." value={keyInput} onChange={(e) => setKeyInput(e.target.value)}
                className="flex-1 rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 text-[13px] text-white placeholder:text-slate-500 focus:border-cyan-300/40 focus:outline-none"
              />
              <button onClick={() => save({ openaiApiKey: keyInput })} disabled={!keyInput || saving} className="rounded-md border border-cyan-300/30 bg-cyan-300/10 px-3 py-1.5 text-[12px] text-cyan-100 hover:bg-cyan-300/20 disabled:opacity-50">
                {saving ? <Loader2 size={12} className="animate-spin" /> : 'save'}
              </button>
              {s.hasOpenAIKey && (
                <button onClick={() => save({ clearOpenAI: true })} className="rounded-md border border-rose-300/30 bg-rose-300/10 px-3 py-1.5 text-[12px] text-rose-200 hover:bg-rose-300/20">
                  clear
                </button>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-[0.18em] text-slate-500">Primary model</label>
                <input value={model} onChange={(e) => setModel(e.target.value)} onBlur={() => model && save({ assistantModel: model })} className="w-full rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 text-[12px] text-white focus:border-cyan-300/40 focus:outline-none" />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-[0.18em] text-slate-500">Fallback</label>
                <input value={fallback} onChange={(e) => setFallback(e.target.value)} onBlur={() => fallback && save({ fallbackModel: fallback })} className="w-full rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 text-[12px] text-white focus:border-cyan-300/40 focus:outline-none" />
              </div>
            </div>
            {justSaved && <div className="mt-2 flex items-center gap-1 text-[11px] text-emerald-300"><Check size={12} /> saved</div>}
          </section>

          {/* Remote bridge */}
          <section>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">Remote Bridge</div>
            <p className="mb-3 text-[12px] leading-5 text-slate-500">
              Set a shared secret so external bridges (Telegram, voice HUD, etc.) can call <code className="text-slate-300">/api/assistant</code> remotely. Local-only requests skip the check.
            </p>
            <BridgeKeyControl s={s} onSave={save} />
            <p className="mt-3 text-[11px] leading-5 text-slate-500">
              <strong>Telegram example:</strong>{' '}
              <code className="text-slate-300">AW_TG_TOKEN=… AW_TG_ALLOW=… AW_BRIDGE_KEY=… node bridge/telegram.cjs</code> — messages forward to Metis Brain with <code>auto=true</code>, so one Telegram message can spawn an entire swarm.
            </p>
          </section>
        </div>
      </aside>
    </div>
  )
}

function BridgeKeyControl({ s, onSave }: { s: SettingsState; onSave: (p: any) => Promise<void> }) {
  const [val, setVal] = useState('')
  return (
    <div>
      <div className="mb-2 text-[12px]">
        <span className={s.hasBridgeKey ? 'text-emerald-200' : 'text-slate-400'}>
          {s.hasBridgeKey ? `set (${s.bridgeApiKey})` : 'not set — only local requests allowed'}
        </span>
      </div>
      <div className="flex gap-2">
        <input
          type="password" placeholder="random 12+ char secret" value={val} onChange={(e) => setVal(e.target.value)}
          className="flex-1 rounded-md border border-slate-400/15 bg-black/40 px-2 py-1.5 text-[12px] text-white placeholder:text-slate-500 focus:border-cyan-300/40 focus:outline-none"
        />
        <button onClick={async () => { if (val.length >= 12) { await onSave({ bridgeApiKey: val }); setVal('') } }} disabled={val.length < 12} className="rounded-md border border-cyan-300/30 bg-cyan-300/10 px-3 py-1.5 text-[12px] text-cyan-100 hover:bg-cyan-300/20 disabled:opacity-50">save</button>
        {s.hasBridgeKey && (
          <button onClick={() => onSave({ clearBridge: true })} className="rounded-md border border-rose-300/30 bg-rose-300/10 px-3 py-1.5 text-[12px] text-rose-200 hover:bg-rose-300/20">clear</button>
        )}
      </div>
    </div>
  )
}
