'use client'

import { useState, useMemo } from 'react'
import { Wrench, ChevronRight, Zap, Eye, Copy, Check } from 'lucide-react'
import type { Attachment } from '@/lib/types'

export interface ToolCallLog { id: string; name: string; arguments: string; result?: unknown }
export interface UiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments?: Attachment[]
  toolCalls?: ToolCallLog[]
}

const ACTION_VERBS = /^(spawn|kill|broadcast|send|run|write|create|delete|remove|rename|set|patch|post|put|exec|restart|start|stop|launch|deploy|build|install|update|move|copy|apply|assign|attach|detach|split|close|focus|broadcast)/i
const READ_VERBS = /^(get|list|read|peek|status|fetch|find|search|inspect|show|preview|describe|head|tail|view|count)/i

function isAction(name: string): boolean {
  if (ACTION_VERBS.test(name)) return true
  if (READ_VERBS.test(name)) return false
  return false
}

export function ChatMessage({ m }: { m: UiMessage }) {
  const isUser = m.role === 'user'
  return (
    <div
      className={`rounded-xl border px-3 py-2 text-[13px] leading-5 ${
        isUser
          ? 'border-cyan-300/30 bg-cyan-300/8 text-cyan-50'
          : 'border-slate-400/15 bg-black/30 text-slate-100'
      }`}
    >
      <div className="mb-1 text-[9px] font-bold uppercase tracking-[0.2em] text-slate-400">
        {m.role}
      </div>
      {m.attachments && m.attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {m.attachments.map((a, i) =>
            a.type === 'image' ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                key={i}
                src={a.dataUrl}
                alt={a.name}
                className="h-20 max-w-[180px] rounded border border-slate-400/20 object-cover"
              />
            ) : null,
          )}
        </div>
      )}
      <MessageBody text={m.content} />
      {m.toolCalls && m.toolCalls.length > 0 && (
        <div className="mt-2 space-y-1">
          {m.toolCalls.map((t) => (
            <ToolCallBlock key={t.id} call={t} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Splits content on ``` fences and renders code blocks with light syntax highlight. */
export function MessageBody({ text }: { text: string }) {
  const segments = useMemo(() => splitFences(text), [text])
  return (
    <div className="space-y-2">
      {segments.map((seg, i) =>
        seg.kind === 'code' ? (
          <CodeBlock key={i} lang={seg.lang} code={seg.text} />
        ) : (
          <div key={i} className="whitespace-pre-wrap break-words">
            <InlineText text={seg.text} />
          </div>
        ),
      )}
    </div>
  )
}

type Segment = { kind: 'text'; text: string } | { kind: 'code'; lang: string; text: string }

function splitFences(input: string): Segment[] {
  if (!input) return [{ kind: 'text', text: '' }]
  const out: Segment[] = []
  const fence = /```([a-zA-Z0-9_+\-]*)\n?([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = fence.exec(input)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: input.slice(last, m.index) })
    out.push({ kind: 'code', lang: (m[1] || '').toLowerCase(), text: m[2].replace(/\n$/, '') })
    last = m.index + m[0].length
  }
  if (last < input.length) out.push({ kind: 'text', text: input.slice(last) })
  if (out.length === 0) out.push({ kind: 'text', text: input })
  return out
}

/** Renders inline `code` spans inside a text segment. */
function InlineText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: Array<{ kind: 'text' | 'code'; text: string }> = []
    const re = /`([^`\n]+)`/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
      out.push({ kind: 'code', text: m[1] })
      last = m.index + m[0].length
    }
    if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
    if (out.length === 0) out.push({ kind: 'text', text })
    return out
  }, [text])
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'code' ? (
          <code
            key={i}
            className="rounded bg-slate-400/10 px-1 py-0.5 font-mono text-[12px] text-cyan-200"
          >
            {p.text}
          </code>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    // navigator.clipboard is undefined outside secure contexts (phone over
    // http://tailscale-ip) — fall back to execCommand like cards.tsx CopyButton.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code)
      } else {
        const ta = document.createElement('textarea')
        ta.value = code
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {}
  }
  return (
    <div className="overflow-hidden rounded-lg border border-slate-400/15 bg-black/60">
      <div className="flex items-center justify-between border-b border-slate-400/10 bg-black/40 px-2 py-1">
        <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500">
          {lang || 'code'}
        </span>
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-400/10 hover:text-white"
          title="copy"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[1.55] text-slate-100">
        <code dangerouslySetInnerHTML={{ __html: highlight(code, lang) }} />
      </pre>
    </div>
  )
}

/** Lightweight regex-based highlighter — visually distinct, not lexically perfect. */
function highlight(src: string, lang: string): string {
  const esc = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const isShell = /^(sh|bash|zsh|shell|console|terminal)$/.test(lang)
  const keywords = isShell
    ? /\b(if|then|else|fi|for|while|do|done|case|esac|in|function|return|export|local|cd|echo|cat|grep|sed|awk|find|ls|mv|cp|rm|mkdir|chmod|chown|sudo|git|npm|yarn|pnpm|node|python|pip)\b/g
    : /\b(import|export|from|as|return|if|else|for|while|do|switch|case|break|continue|class|extends|implements|interface|type|enum|public|private|protected|static|new|this|super|async|await|yield|try|catch|finally|throw|const|let|var|function|in|of|true|false|null|undefined|void|typeof|instanceof|default|def|elif|pass|lambda|with|None|True|False|self)\b/g

  // Order matters: comments first, then strings, then numbers, then keywords.
  const pieces: Array<{ start: number; end: number; cls: string }> = []
  function add(re: RegExp, cls: string) {
    let m: RegExpExecArray | null
    while ((m = re.exec(esc)) !== null) {
      const start = m.index
      const end = start + m[0].length
      // skip if overlaps existing
      if (pieces.some((p) => start < p.end && end > p.start)) continue
      pieces.push({ start, end, cls })
    }
  }
  add(/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g, 'text-slate-500 italic')
  add(/(["'`])(?:\\.|(?!\1).)*\1/g, 'text-emerald-300')
  add(/\b\d+(?:\.\d+)?\b/g, 'text-amber-300')
  add(keywords, 'text-violet-300')

  pieces.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const p of pieces) {
    if (p.start < cursor) continue
    out += esc.slice(cursor, p.start)
    out += `<span class="${p.cls}">${esc.slice(p.start, p.end)}</span>`
    cursor = p.end
  }
  out += esc.slice(cursor)
  return out
}

function ToolCallBlock({ call }: { call: ToolCallLog }) {
  const [open, setOpen] = useState(false)
  const action = isAction(call.name)
  const args = useMemo(() => prettyJson(call.arguments), [call.arguments])
  const result = useMemo(() => prettyJson(call.result), [call.result])
  const colors = action
    ? 'border-amber-300/25 bg-amber-300/5 text-amber-100'
    : 'border-violet-300/20 bg-violet-300/5 text-violet-200'
  const iconColor = action ? 'text-amber-300' : 'text-violet-300'
  const Icon = action ? Zap : Eye

  return (
    <div className={`overflow-hidden rounded-lg border text-[11px] ${colors}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-white/[0.03]"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''} ${iconColor}`}
        />
        <Icon size={12} className={`shrink-0 ${iconColor}`} />
        <Wrench size={12} className="shrink-0 opacity-50" />
        <span className="font-bold">{call.name}</span>
        <span className="ml-1 truncate text-slate-300/70">{previewArgs(call.arguments)}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-white/5 bg-black/40 px-2 py-2">
          <div>
            <div className="mb-1 text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500">
              arguments
            </div>
            <pre className="max-h-48 overflow-auto rounded bg-black/50 px-2 py-1.5 font-mono text-[11px] leading-[1.5] text-slate-200">
              {args || '{}'}
            </pre>
          </div>
          {call.result !== undefined && call.result !== null && call.result !== '' && (
            <div>
              <div className="mb-1 text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500">
                result
              </div>
              <pre className="max-h-64 overflow-auto rounded bg-black/50 px-2 py-1.5 font-mono text-[11px] leading-[1.5] text-slate-200">
                {result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function previewArgs(raw: string): string {
  if (!raw) return ''
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? flat.slice(0, 80) + '…' : flat
}

function prettyJson(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') {
    const s = v.trim()
    if (s.startsWith('{') || s.startsWith('[')) {
      try { return JSON.stringify(JSON.parse(s), null, 2) } catch {}
    }
    return s
  }
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}
