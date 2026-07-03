/**
 * Same-origin sidecar token hand-off (#259).
 *
 * The PTY sidecar is default-deny; browser clients need its token. This route
 * runs on the console's Next server (same machine as the sidecar) and reads
 * the token from env or the sidecar's 0600 token file. Deliberate trust
 * boundary: anyone who can load the console origin can drive the sidecar —
 * the gate protects :3761 as an independent surface (README known limits).
 * The sidecar itself never serves its own token.
 */
import { NextResponse } from 'next/server'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const dynamic = 'force-dynamic'

export async function GET() {
  const fromEnv = process.env.DEV_REVIEW_SIDECAR_TOKEN?.trim()
  if (fromEnv) return NextResponse.json({ token: fromEnv })
  const dataDir = process.env.AW_DATA_DIR ?? path.join(os.homedir(), '.openclaw', 'dev-review')
  try {
    const token = fs.readFileSync(path.join(dataDir, 'sidecar-token'), 'utf8').trim()
    if (token) return NextResponse.json({ token })
  } catch {}
  return NextResponse.json(
    { error: 'sidecar token unavailable — is the PTY sidecar running?' },
    { status: 503 },
  )
}
