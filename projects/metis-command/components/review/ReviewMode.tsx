'use client'

import { useEffect, useState } from 'react'
import { Eye, FileText, ExternalLink, RefreshCw, PenLine } from 'lucide-react'
import { AnnotateTrigger } from '../annotate/AnnotateWidget'

type Track = 'dev' | 'content'

/**
 * Review mode (PLAN M5, first slice). Two tracks behind the Control Center:
 *  - Dev review: embeds the standalone dev-review console (#185, :3760) —
 *    deep-link/iframe per §M5 "start with deep links/embedded module; preserve
 *    standalone dev-review". This shell touches none of the dev-review files.
 *  - Content production: entry points into the writing/fold-back pipeline.
 *
 * Deeper integration (in-shell annotations, content draft cards) lands after the
 * standalone console stabilizes.
 */
export default function ReviewMode() {
  const [track, setTrack] = useState<Track>('dev')
  const [devUrl, setDevUrl] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const override = process.env.NEXT_PUBLIC_METIS_DEVREVIEW_URL
    if (override) setDevUrl(override)
    else if (typeof window !== 'undefined') setDevUrl(`${window.location.protocol}//${window.location.hostname}:3760`)
  }, [])

  return (
    <div data-testid="review-mode" className="flex h-full w-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--line)] bg-black/30 px-2 py-1.5">
        <Eye size={14} className="mr-1 text-cyan-300" />
        <Toggle active={track === 'dev'} onClick={() => setTrack('dev')} icon={<PenLine size={14} />} label="Dev Review" />
        <Toggle active={track === 'content'} onClick={() => setTrack('content')} icon={<FileText size={14} />} label="Content" />
        <div className="flex-1" />
        <AnnotateTrigger />
        {track === 'dev' && devUrl && (
          <>
            <a href={devUrl} target="_blank" rel="noreferrer" title="Open dev-review in a new tab" className="flex items-center gap-1 rounded-lg border border-slate-400/20 bg-black/30 px-2.5 py-1.5 text-sm md:text-[11px] text-slate-300 hover:border-cyan-300/40 hover:text-cyan-100">
              <ExternalLink size={14} /> open
            </a>
            <button onClick={() => setReloadKey((k) => k + 1)} title="Reload" className="flex items-center gap-1 rounded-lg border border-slate-400/20 bg-black/30 px-2.5 py-1.5 text-sm md:text-[11px] text-slate-300 hover:border-cyan-300/40 hover:text-cyan-100">
              <RefreshCw size={14} /> reload
            </button>
          </>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        {track === 'dev' ? (
          devUrl ? (
            <iframe key={reloadKey} src={devUrl} title="Dev Review console" className="h-full w-full border-0 bg-[var(--bg)]" />
          ) : null
        ) : (
          <ContentReview />
        )}
      </div>
    </div>
  )
}

function ContentReview() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="panel flex h-14 w-14 items-center justify-center rounded-2xl">
        <FileText size={28} className="text-cyan-200" />
      </div>
      <div className="text-base font-black uppercase tracking-[0.18em] text-cyan-100">Content Production</div>
      <div className="max-w-md text-[17px] md:text-sm text-slate-300">
        Draft → comments → fold-back → asset production → publish. Voice-profile deltas fold back into the writing system.
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <a href="https://www.notion.so" target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-lg border border-cyan-300/40 bg-cyan-300/10 px-3 py-1.5 text-[15px] md:text-xs text-cyan-100 hover:bg-cyan-300/20">
          <ExternalLink size={14} /> Notion Command Center
        </a>
        <span className="rounded-lg border border-slate-400/20 bg-black/30 px-3 py-1.5 text-[15px] md:text-xs text-slate-400">drafts: projects/writing/drafts/</span>
      </div>
      <span className="badge">in-shell content review · later milestone</span>
    </div>
  )
}

function Toggle({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm md:text-[11px] font-bold ${
        active ? 'border-cyan-300/50 bg-cyan-300/10 text-cyan-100' : 'border-transparent text-slate-400 hover:text-slate-200'
      }`}
    >
      {icon} {label}
    </button>
  )
}
