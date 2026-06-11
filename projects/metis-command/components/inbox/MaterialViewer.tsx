'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileText, Image as ImageIcon, Code2, Loader2, AlertTriangle, ChevronDown, ChevronUp, ListTree } from 'lucide-react'
import { metisApi, type MetisResult } from '@/lib/metis-api'
import type { MetisMaterial, MetisFileContent, MetisDocBrief } from '@/lib/metis-api-types'

// ── Material viewer (#240) ────────────────────────────────────────────────────
// Renders the plan / decision record / design / spec attached to an inbox item
// so Ant can review it IN the card. Markdown leads with a condensed, server-
// extracted brief (the decision sections + an outline) — the whole point is to
// decide in-place without reading the clunky full doc — with the full rendered
// document one tap away. Images preview inline; other text shows as a code block.

// Mermaid (decision trees / process maps) is heavy and browser-only, so it loads
// on demand and renders into an SVG once mounted.
function Mermaid({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState<string | null>(null)
  const id = `mmd-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
        const { svg } = await mermaid.render(id, chart)
        if (alive && ref.current) ref.current.innerHTML = svg
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : 'diagram failed to render')
      }
    })()
    return () => { alive = false }
  }, [chart, id])
  if (err) return <pre className="overflow-x-auto rounded-lg border border-rose-400/20 bg-black/40 p-2 text-[11px] text-rose-300">{chart}</pre>
  return <div ref={ref} className="my-2 flex justify-center overflow-x-auto rounded-lg border border-[var(--line)] bg-black/30 p-2" />
}

// ControlCenter-styled markdown. Links are non-navigable (would break the SPA shell);
// fenced ```mermaid blocks render as diagrams.
const MD_COMPONENTS = {
  h1: (p: React.HTMLAttributes<HTMLHeadingElement>) => <h1 className="mb-2 mt-3 text-[15px] font-bold text-slate-50" {...p} />,
  h2: (p: React.HTMLAttributes<HTMLHeadingElement>) => <h2 className="mb-1.5 mt-3 border-b border-[var(--line)] pb-1 text-[13px] font-bold text-cyan-100" {...p} />,
  h3: (p: React.HTMLAttributes<HTMLHeadingElement>) => <h3 className="mb-1 mt-2.5 text-[13px] font-semibold text-slate-100" {...p} />,
  p: (p: React.HTMLAttributes<HTMLParagraphElement>) => <p className="mb-2 text-[13px] leading-relaxed text-slate-300" {...p} />,
  ul: (p: React.HTMLAttributes<HTMLUListElement>) => <ul className="mb-2 ml-4 list-disc space-y-0.5 text-[13px] text-slate-300" {...p} />,
  ol: (p: React.HTMLAttributes<HTMLOListElement>) => <ol className="mb-2 ml-4 list-decimal space-y-0.5 text-[13px] text-slate-300" {...p} />,
  li: (p: React.HTMLAttributes<HTMLLIElement>) => <li className="leading-relaxed" {...p} />,
  strong: (p: React.HTMLAttributes<HTMLElement>) => <strong className="font-bold text-slate-100" {...p} />,
  em: (p: React.HTMLAttributes<HTMLElement>) => <em className="italic text-slate-200" {...p} />,
  a: ({ children, href }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <span title={href} className="text-cyan-300 underline decoration-cyan-300/40">{children}</span>
  ),
  blockquote: (p: React.HTMLAttributes<HTMLQuoteElement>) => <blockquote className="mb-2 border-l-2 border-cyan-300/30 pl-3 text-[13px] italic text-slate-400" {...p} />,
  table: (p: React.HTMLAttributes<HTMLTableElement>) => <div className="mb-2 overflow-x-auto"><table className="w-full border-collapse text-[12px]" {...p} /></div>,
  th: (p: React.HTMLAttributes<HTMLTableCellElement>) => <th className="border border-[var(--line)] bg-white/5 px-2 py-1 text-left font-semibold text-slate-200" {...p} />,
  td: (p: React.HTMLAttributes<HTMLTableCellElement>) => <td className="border border-[var(--line)] px-2 py-1 text-slate-300" {...p} />,
  hr: () => <hr className="my-3 border-[var(--line)]" />,
  code: ({ className, children, ...rest }: React.HTMLAttributes<HTMLElement>) => {
    const txt = String(children ?? '')
    if (/language-mermaid/.test(className ?? '')) return <Mermaid chart={txt.replace(/\n$/, '')} />
    const block = /language-/.test(className ?? '') || txt.includes('\n')
    if (block) return <pre className="mb-2 overflow-x-auto rounded-lg border border-[var(--line)] bg-black/40 p-2 text-[12px] text-emerald-100"><code {...rest}>{children}</code></pre>
    return <code className="rounded bg-white/10 px-1 py-0.5 text-[12px] text-cyan-100" {...rest}>{children}</code>
  },
}

function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{text}</ReactMarkdown>
}

// The condensed brief: what you need to decide, without the full doc.
function BriefView({ brief }: { brief: MetisDocBrief }) {
  const [showOutline, setShowOutline] = useState(false)
  const hasSections = brief.sections.length > 0
  return (
    <div className="space-y-3">
      {brief.tldr && !hasSections && (
        <div className="text-[13px] leading-relaxed text-slate-300"><Markdown text={brief.tldr} /></div>
      )}
      {brief.sections.map((s) => (
        <div key={s.heading} className="rounded-lg border border-[var(--line)] bg-black/20 px-3 py-2">
          <div className="mb-1 text-[12px] font-bold text-cyan-100">{s.heading}</div>
          <Markdown text={s.body} />
        </div>
      ))}
      {brief.outline.length > 0 && (
        <div>
          <button onClick={() => setShowOutline((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--muted)] hover:text-cyan-200">
            <ListTree size={12} /> Outline ({brief.outline.length})
            {showOutline ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {showOutline && (
            <div className="mt-1.5 flex flex-col gap-0.5">
              {brief.outline.map((h, i) => (
                <div key={i} className="truncate text-[12px] text-slate-400" style={{ paddingLeft: `${(h.level - 1) * 12}px` }}>
                  {h.level <= 2 ? <span className="text-slate-200">{h.text}</span> : h.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const KIND_ICON: Record<string, React.ReactNode> = {
  markdown: <FileText size={12} />,
  image: <ImageIcon size={12} />,
  text: <Code2 size={12} />,
}

export default function MaterialViewer({ material }: { material: MetisMaterial }) {
  const [path, setPath] = useState<string | null>(material.primary)
  const [res, setRes] = useState<MetisResult<MetisFileContent> | null>(null)
  const [loading, setLoading] = useState(false)
  const [showFull, setShowFull] = useState(false)

  const load = useCallback(async (p: string) => {
    setLoading(true); setShowFull(false)
    const r = await metisApi.file(p)
    setRes(r)
    setLoading(false)
  }, [])

  useEffect(() => { if (path) load(path) }, [path, load])

  if (!material.files.length) return null
  const data = res?.ok ? res.data : null
  const fileErr = res && !res.ok ? res.error : (data && !data.ok ? data.error : null)

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[#0d1018]/60">
      <div className="flex items-center gap-1.5 border-b border-[var(--line)] px-2.5 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--muted)]">Material</span>
        {data?.kind === 'markdown' && data.brief && (
          <button onClick={() => setShowFull((v) => !v)}
            className="ml-auto rounded-md border border-cyan-300/25 bg-cyan-300/5 px-2 py-0.5 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-300/15">
            {showFull ? 'Show brief' : 'Open full document'}
          </button>
        )}
      </div>

      {/* File switcher (only when >1 candidate) */}
      {material.files.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-[var(--line)] px-2.5 py-1.5">
          {material.files.map((f) => (
            <button key={f.path} onClick={() => setPath(f.path)} title={f.path}
              className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${
                f.path === path ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-100' : 'border-[var(--line)] bg-black/20 text-slate-400 hover:text-slate-200'
              }`}>
              {KIND_ICON[f.kind]} <span className="max-w-[140px] truncate">{f.label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="max-h-[46vh] overflow-y-auto px-3 py-2.5">
        {loading && <div className="flex items-center gap-2 py-4 text-[12px] text-[var(--muted)]"><Loader2 size={14} className="animate-spin" /> loading {path?.split('/').pop()}…</div>}
        {!loading && fileErr && (
          <div className="flex items-start gap-1.5 rounded-lg border border-rose-400/20 bg-rose-400/5 px-2.5 py-2 text-[12px] text-rose-200">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {fileErr}
          </div>
        )}
        {!loading && data?.ok && (
          <>
            {data.kind === 'image' && data.dataUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={data.dataUrl} alt={data.path} className="mx-auto max-h-[42vh] rounded-lg border border-[var(--line)]" />
            )}
            {data.kind === 'text' && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-2 text-[12px] leading-relaxed text-slate-300">{data.content}</pre>
            )}
            {data.kind === 'markdown' && (
              showFull || !data.brief
                ? <Markdown text={data.content ?? ''} />
                : <BriefView brief={data.brief} />
            )}
            {data.truncated && <div className="mt-2 text-[11px] text-amber-300/70">⋯ truncated (file exceeds size cap) — open the full file to read the rest</div>}
            <div className="mt-2 border-t border-[var(--line)] pt-1.5 font-mono text-[10px] text-[var(--muted)]">{data.path}</div>
          </>
        )}
      </div>
    </div>
  )
}
