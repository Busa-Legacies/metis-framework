export interface RuntimeGuardrailConfig {
  outputTailLines: number
  outputTailBytes: number
  outputLineChars: number
  chatTurnsMax: number
  chatTurnChars: number
  resumeSpecsMax: number
}

export const DEFAULT_RUNTIME_GUARDRAILS: RuntimeGuardrailConfig = {
  outputTailLines: 240,
  outputTailBytes: 96 * 1024,
  outputLineChars: 4096,
  chatTurnsMax: 80,
  chatTurnChars: 6000,
  resumeSpecsMax: 24,
}

type RuntimeGuardrailEnv = Record<string, string | undefined>

function positiveIntegerEnv(env: RuntimeGuardrailEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw == null || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

export function buildRuntimeGuardrailConfig(env: RuntimeGuardrailEnv = process.env): RuntimeGuardrailConfig {
  return {
    outputTailLines: positiveIntegerEnv(env, 'AW_OUTPUT_TAIL_LINES', DEFAULT_RUNTIME_GUARDRAILS.outputTailLines),
    outputTailBytes: positiveIntegerEnv(env, 'AW_OUTPUT_TAIL_BYTES', DEFAULT_RUNTIME_GUARDRAILS.outputTailBytes),
    outputLineChars: positiveIntegerEnv(env, 'AW_OUTPUT_LINE_CHARS', DEFAULT_RUNTIME_GUARDRAILS.outputLineChars),
    chatTurnsMax: positiveIntegerEnv(env, 'AW_CHAT_TURNS_MAX', DEFAULT_RUNTIME_GUARDRAILS.chatTurnsMax),
    chatTurnChars: positiveIntegerEnv(env, 'AW_CHAT_TURN_CHARS', DEFAULT_RUNTIME_GUARDRAILS.chatTurnChars),
    resumeSpecsMax: positiveIntegerEnv(env, 'AW_RESUME_SPECS_MAX', DEFAULT_RUNTIME_GUARDRAILS.resumeSpecsMax),
  }
}

export const RUNTIME_GUARDRAILS = buildRuntimeGuardrailConfig()

export function trimOutputLine(line: string, config: RuntimeGuardrailConfig = RUNTIME_GUARDRAILS): string {
  return line.length > config.outputLineChars ? line.slice(-config.outputLineChars) : line
}

export function trimPersistedOutputLines(lines: string[], config: RuntimeGuardrailConfig = RUNTIME_GUARDRAILS): string[] {
  const byLine = lines.slice(-config.outputTailLines).map((line) => trimOutputLine(line, config))
  let bytes = 0
  const kept: string[] = []
  for (let i = byLine.length - 1; i >= 0; i--) {
    const line = byLine[i]
    bytes += Buffer.byteLength(line, 'utf8') + 1
    if (bytes > config.outputTailBytes && kept.length > 0) break
    kept.push(line)
  }
  return kept.reverse()
}
