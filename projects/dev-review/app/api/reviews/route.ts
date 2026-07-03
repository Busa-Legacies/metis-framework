import { NextResponse, type NextRequest } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Review-session persistence. One JSON file per target (origin+path slug) at
 * ~/.openclaw/dev-review/sessions/ — same data root as the PTY sidecar. The
 * file is ALSO the agent-readable artifact: send-to-agent cites its path so
 * the agent can read full annotation payloads (rects, styles) beyond the
 * prompt summary.
 */

const SESSIONS_DIR = path.join(
  process.env.AW_DATA_DIR ?? path.join(os.homedir(), '.openclaw', 'dev-review'),
  'sessions',
)

function slugFor(url: string): string | null {
  try {
    const u = new URL(url)
    const raw = `${u.hostname}-${u.port || 'default'}${u.pathname}`
    return raw.replace(/\/+$/, '').replace(/[^a-zA-Z0-9.-]+/g, '_') || null
  } catch {
    return null
  }
}

function fileFor(url: string): string | null {
  const slug = slugFor(url)
  return slug ? path.join(SESSIONS_DIR, `${slug}.json`) : null
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  const file = url && fileFor(url)
  if (!file) return NextResponse.json({ error: 'bad url' }, { status: 400 })
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return NextResponse.json({ session: data, path: file })
  } catch {
    return NextResponse.json({ session: null, path: file })
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body.url !== 'string' || !Array.isArray(body.annotations)) {
    return NextResponse.json({ error: 'expected {url, annotations[]}' }, { status: 400 })
  }
  const file = fileFor(body.url)
  if (!file) return NextResponse.json({ error: 'bad url' }, { status: 400 })
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  const payload = { url: body.url, savedAt: new Date().toISOString(), annotations: body.annotations }
  fs.writeFileSync(file, JSON.stringify(payload, null, 2))
  return NextResponse.json({ ok: true, path: file })
}
