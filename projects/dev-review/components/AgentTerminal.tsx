'use client'

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { agentWsUrl } from '@/lib/pty-client'

interface Props {
  agentId: string
}

export default function AgentTerminal({ agentId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "SF Mono", "DejaVu Sans Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: {
        background: '#05060a',
        foreground: '#e8eef7',
        cursor: '#34d3ff',
        selectionBackground: 'rgba(52,211,255,0.28)',
        black: '#0b0e15',
        brightBlack: '#3b4252',
      },
      scrollback: 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    requestAnimationFrame(() => { try { fit.fit() } catch {} })
    termRef.current = term
    fitRef.current = fit

    const ws = new WebSocket(agentWsUrl(agentId))
    wsRef.current = ws
    let opened = false

    ws.onopen = () => {
      opened = true
      const { cols, rows } = term
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
        if (msg.type === 'data') term.write(msg.data)
        else if (msg.type === 'exit') term.write(`\r\n\x1b[33m[process exited code=${msg.exitCode}]\x1b[0m\r\n`)
      } catch {}
    }
    ws.onclose = () => {
      if (opened) term.write('\r\n\x1b[31m[disconnected]\x1b[0m\r\n')
    }

    const onData = term.onData((d) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data: d }))
    })

    const onResize = () => {
      try { fit.fit() } catch {}
      const { cols, rows } = term
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
    window.addEventListener('resize', onResize)
    const ro = new ResizeObserver(onResize)
    ro.observe(containerRef.current)

    return () => {
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      onData.dispose()
      try { ws.close() } catch {}
      term.dispose()
      termRef.current = null
      fitRef.current = null
      wsRef.current = null
    }
  }, [agentId])

  function shellQuote(s: string): string {
    if (/^[A-Za-z0-9._\/\-]+$/.test(s)) return s
    return `'${s.replace(/'/g, `'\\''`)}'`
  }

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-black/60"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(e) => {
        const files = e.dataTransfer.files
        if (files && files.length && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          e.preventDefault()
          const paths: string[] = []
          for (let i = 0; i < files.length; i++) {
            const f = files[i] as File & { path?: string }
            if (f.path) paths.push(f.path)
          }
          if (paths.length) {
            const text = paths.map(shellQuote).join(' ') + ' '
            wsRef.current.send(JSON.stringify({ type: 'data', data: text }))
          }
        }
      }}
    >
      <div ref={containerRef} className="absolute inset-0 p-2" />
    </div>
  )
}
