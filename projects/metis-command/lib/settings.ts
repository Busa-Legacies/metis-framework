import 'server-only'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface AppSettings {
  openaiApiKey?: string
  assistantModel?: string
  fallbackModel?: string
  assistantProvider?: 'auto' | 'openclaw' | 'openai' | 'codex-cli' | 'claude-cli'
  assistantPersona?: AssistantPersona
  autonomousHopCap?: number
  bridgeApiKey?: string // shared secret for remote bridges (Telegram etc.) to call /api/assistant
}

export type AssistantPersona = 'workbench' | 'metis-brain' | 'jarvis'
export type NormalizedAssistantPersona = 'workbench' | 'metis-brain'

const DIR = path.join(os.homedir(), '.openclaw', 'metis-command')
const FILE = path.join(DIR, 'settings.json')
const LEGACY_FILE = path.join(os.homedir(), '.openclaw', 'agent-workbench', 'settings.json')

function ensureDir() { fs.mkdirSync(DIR, { recursive: true }) }

export function normalizeAssistantPersona(value: unknown): NormalizedAssistantPersona {
  return value === 'metis-brain' || value === 'jarvis' ? 'metis-brain' : 'workbench'
}

export function isMetisBrainPersona(value: unknown): boolean {
  return normalizeAssistantPersona(value) === 'metis-brain'
}

export function readSettings(): AppSettings {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    try {
      return JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'))
    } catch {
      return {}
    }
  }
}

export function writeSettings(patch: Partial<AppSettings>): AppSettings {
  ensureDir()
  const next = { ...readSettings(), ...patch }
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2))
  return next
}

export function effectiveOpenAIKey(): string | undefined {
  return readSettings().openaiApiKey || process.env.OPENAI_API_KEY
}

export function effectiveModel(): { primary: string; fallback: string } {
  const s = readSettings()
  return {
    primary: s.assistantModel || process.env.AW_ASSISTANT_MODEL || 'gpt-5.5',
    fallback: s.fallbackModel || process.env.AW_FALLBACK_MODEL || 'gpt-4o',
  }
}
