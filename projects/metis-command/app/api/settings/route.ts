import { NextRequest, NextResponse } from 'next/server'
import { normalizeAssistantPersona, readSettings, writeSettings, type AppSettings } from '@/lib/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function redact(s: AppSettings) {
  const { openaiApiKey, bridgeApiKey, ...rest } = s
  return {
    ...rest,
    openaiApiKey: openaiApiKey ? `••••${openaiApiKey.slice(-4)}` : '',
    hasOpenAIKey: !!openaiApiKey,
    bridgeApiKey: bridgeApiKey ? `••••${bridgeApiKey.slice(-4)}` : '',
    hasBridgeKey: !!bridgeApiKey,
  }
}

export async function GET() {
  return NextResponse.json(redact(readSettings()))
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Partial<AppSettings> & { clearOpenAI?: boolean; clearBridge?: boolean }
  const patch: Partial<AppSettings> = {}
  if (typeof body.assistantModel === 'string') patch.assistantModel = body.assistantModel
  if (typeof body.fallbackModel === 'string') patch.fallbackModel = body.fallbackModel
  if (typeof body.assistantProvider === 'string') patch.assistantProvider = body.assistantProvider
  if (typeof body.assistantPersona === 'string') patch.assistantPersona = normalizeAssistantPersona(body.assistantPersona)
  if (typeof body.autonomousHopCap === 'number') patch.autonomousHopCap = Math.max(1, Math.min(40, body.autonomousHopCap))
  if (typeof body.openaiApiKey === 'string' && body.openaiApiKey.length > 8) patch.openaiApiKey = body.openaiApiKey.trim()
  if (typeof body.bridgeApiKey === 'string' && body.bridgeApiKey.length >= 12) patch.bridgeApiKey = body.bridgeApiKey.trim()
  if (body.clearOpenAI) patch.openaiApiKey = undefined as any
  if (body.clearBridge) patch.bridgeApiKey = undefined as any
  const next = writeSettings(patch)
  return NextResponse.json(redact(next))
}
