'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, ChevronDown, File as FileIcon, Folder, FolderOpen, RefreshCw, Eye, EyeOff, Pin, Plus, X } from 'lucide-react'
import { ptyApi } from '@/lib/pty-client'

interface Entry { name: string; isDir: boolean; path: string }

interface Props {
  workspaceId: string | null
  workspaceCwd: string
  onPickFile: (absolutePath: string, relPath: string) => void
}

interface Root {
  abs: string
  label: string
  primary: boolean // primary = workspace cwd, can't be removed
  entries: Entry[]
  expanded: boolean
}

export default function FileTree({ workspaceId, workspaceCwd, onPickFile }: Props) {
  const [roots, setRoots] = useState<Root[]>([])
  const [openDirs, setOpenDirs] = useState<Record<string, Entry[]>>({}) // key: rootAbs::rel
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(false)

  const loadRoot = useCallback(async (abs: string) => {
    if (!workspaceId) return [] as Entry[]
    const r = await ptyApi.listFiles(workspaceId, '', abs)
    return r.entries
  }, [workspaceId])

  const loadDir = useCallback(async (abs: string, rel: string) => {
    if (!workspaceId) return [] as Entry[]
    const r = await ptyApi.listFiles(workspaceId, rel, abs)
    return r.entries
  }, [workspaceId])

  const refresh = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    try {
      const [pinResp] = await Promise.all([ptyApi.getPinnedRoots(workspaceId)])
      const pins = pinResp.roots
      const allRoots = [
        { abs: workspaceCwd, primary: true, label: shortLabel(workspaceCwd) },
        ...pins.map((abs) => ({ abs, primary: false, label: shortLabel(abs) })),
      ]
      const next: Root[] = []
      for (const r of allRoots) {
        try {
          const entries = await loadRoot(r.abs)
          next.push({ ...r, entries, expanded: true })
        } catch {
          next.push({ ...r, entries: [], expanded: true })
        }
      }
      setRoots(next)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    } finally { setLoading(false) }
  }, [workspaceId, workspaceCwd, loadRoot])

  useEffect(() => {
    setOpenDirs({})
    setRoots([])
    if (workspaceId) refresh()
  }, [workspaceId, workspaceCwd, refresh])

  const toggleDir = useCallback(async (rootAbs: string, rel: string) => {
    const key = `${rootAbs}::${rel}`
    if (openDirs[key]) {
      setOpenDirs((cur) => { const { [key]: _, ...rest } = cur; return rest })
    } else {
      try {
        const entries = await loadDir(rootAbs, rel)
        setOpenDirs((cur) => ({ ...cur, [key]: entries }))
      } catch {}
    }
  }, [openDirs, loadDir])

  async function addPin() {
    if (!workspaceId) return
    const path = window.prompt('Pin a folder to this workspace (absolute path):', '${METIS_HOME}/memory')
    if (!path) return
    const current = (await ptyApi.getPinnedRoots(workspaceId)).roots
    if (!current.includes(path)) {
      await ptyApi.putPinnedRoots(workspaceId, [...current, path])
      await refresh()
    }
  }
  async function removePin(abs: string) {
    if (!workspaceId) return
    const current = (await ptyApi.getPinnedRoots(workspaceId)).roots
    await ptyApi.putPinnedRoots(workspaceId, current.filter((r) => r !== abs))
    await refresh()
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">Files</div>
        <div className="flex items-center gap-1">
          <button onClick={addPin} title="pin folder" className="rounded p-1 text-slate-400 hover:text-cyan-200">
            <Pin size={12} />
          </button>
          <button onClick={() => setShowHidden((v) => !v)} title={showHidden ? 'hide dotfiles' : 'show dotfiles'} className="rounded p-1 text-slate-400 hover:text-white">
            {showHidden ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
          <button onClick={refresh} className="rounded p-1 text-slate-400 hover:text-white" title="refresh">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>
      {error && <div className="mx-2 rounded border border-rose-300/30 bg-rose-300/5 p-2 text-[10px] text-rose-200">{error}</div>}
      <div className="flex-1 overflow-y-auto px-1 pb-2 text-xs">
        {roots.map((r, i) => (
          <RootView
            key={r.abs}
            root={r}
            showHidden={showHidden}
            openDirs={openDirs}
            onToggleDir={(rel) => toggleDir(r.abs, rel)}
            onPick={(e) => { if (e.isDir) toggleDir(r.abs, e.path); else onPickFile(joinAbs(r.abs, e.path), e.path) }}
            onRemovePin={r.primary ? undefined : () => removePin(r.abs)}
            onToggleExpand={() => setRoots((cur) => cur.map((x, j) => j === i ? { ...x, expanded: !x.expanded } : x))}
          />
        ))}
      </div>
    </div>
  )
}

function RootView({ root, showHidden, openDirs, onToggleDir, onPick, onRemovePin, onToggleExpand }: {
  root: Root
  showHidden: boolean
  openDirs: Record<string, Entry[]>
  onToggleDir: (rel: string) => void
  onPick: (e: Entry) => void
  onRemovePin?: () => void
  onToggleExpand: () => void
}) {
  return (
    <div className="mb-1">
      <div className="group flex items-center gap-1 rounded-md px-1.5 py-0.5 text-slate-300">
        <button onClick={onToggleExpand} className="flex items-center gap-1 truncate text-left hover:text-white">
          {root.expanded ? <ChevronDown size={12} className="text-slate-500" /> : <ChevronRight size={12} className="text-slate-500" />}
          <Pin size={12} className={root.primary ? 'text-cyan-300' : 'text-violet-300'} />
          <span className="truncate font-bold uppercase tracking-[0.14em] text-[10px]">{root.label}</span>
        </button>
        <div className="flex-1" />
        {onRemovePin && (
          <button onClick={onRemovePin} title="unpin" className="opacity-0 group-hover:opacity-70 hover:opacity-100"><X size={12} /></button>
        )}
      </div>
      {root.expanded && (
        <div>
          {root.entries.filter((e) => showHidden || !e.name.startsWith('.')).map((e) => (
            <Node key={e.path} entry={e} depth={1} rootAbs={root.abs} openDirs={openDirs} onToggleDir={onToggleDir} onPick={onPick} showHidden={showHidden} />
          ))}
        </div>
      )}
    </div>
  )
}

function Node({ entry, depth, rootAbs, openDirs, onToggleDir, onPick, showHidden }: { entry: Entry; depth: number; rootAbs: string; openDirs: Record<string, Entry[]>; onToggleDir: (rel: string) => void; onPick: (e: Entry) => void; showHidden: boolean }) {
  const key = `${rootAbs}::${entry.path}`
  const expanded = entry.isDir && !!openDirs[key]
  const allChildren = expanded ? openDirs[key] : []
  const children = (allChildren ?? []).filter((c) => showHidden || !c.name.startsWith('.'))
  return (
    <div>
      <button
        onClick={() => onPick(entry)}
        draggable={!entry.isDir}
        onDragStart={(e) => {
          if (!entry.isDir) {
            e.dataTransfer.setData('text/plain', joinAbs(rootAbs, entry.path))
            e.dataTransfer.effectAllowed = 'copy'
          }
        }}
        className="flex w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-left text-slate-300 hover:bg-slate-300/5 hover:text-white"
        style={{ paddingLeft: `${4 + depth * 12}px` }}
      >
        {entry.isDir ? (
          expanded ? <ChevronDown size={12} className="text-slate-500" /> : <ChevronRight size={12} className="text-slate-500" />
        ) : <span className="w-[11px]" />}
        {entry.isDir ? (expanded ? <FolderOpen size={12} className="text-cyan-300" /> : <Folder size={12} className="text-cyan-300/70" />) : <FileIcon size={12} className="text-slate-400" />}
        <span className="truncate">{entry.name}</span>
      </button>
      {expanded && children.map((c) => (
        <Node key={c.path} entry={c} depth={depth + 1} rootAbs={rootAbs} openDirs={openDirs} onToggleDir={onToggleDir} onPick={onPick} showHidden={showHidden} />
      ))}
    </div>
  )
}

function shortLabel(abs: string): string {
  const parts = abs.split('/').filter(Boolean)
  if (parts.length <= 1) return abs
  // ~/foo/bar style abbreviation
  if (abs.startsWith('/Users/')) {
    const rest = parts.slice(2)
    return '~/' + rest.slice(-2).join('/')
  }
  return parts.slice(-2).join('/')
}

function joinAbs(rootAbs: string, rel: string): string {
  if (!rel) return rootAbs
  return rootAbs.replace(/\/$/, '') + '/' + rel
}
