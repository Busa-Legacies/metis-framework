export interface TerminalCommandBlock {
  id: string
  command: string
  output: string
  exitCode?: number
  source: 'osc133' | 'prompt'
  startedAt?: string
  endedAt?: string
}

export interface TerminalCommandBlockOptions {
  now?: () => string
  id?: (index: number) => string
  maxBlocks?: number
  maxOutputChars?: number
}

const DEFAULT_MAX_BLOCKS = 80
const DEFAULT_MAX_OUTPUT_CHARS = 24 * 1024

interface OscMarker {
  code: string
  payload: string
  index: number
  end: number
}

function blockId(options: TerminalCommandBlockOptions, index: number) {
  return options.id?.(index) ?? `cmd_${index + 1}`
}

function limitOutput(output: string, maxOutputChars: number) {
  const normalized = cleanTerminalText(output).trim()
  return normalized.length > maxOutputChars ? normalized.slice(-maxOutputChars) : normalized
}

export function cleanTerminalText(raw: string): string {
  return String(raw)
    .replace(/\x1b\]133;[^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r(?!\n)/g, '\n')
}

function decodeOscPayload(payload: string): string {
  const value = payload.startsWith(';') ? payload.slice(1) : payload
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseOscMarkers(raw: string): OscMarker[] {
  const markers: OscMarker[] = []
  const re = /\x1b\]133;([A-Z])((?:;[^\x07\x1b]*)?)(?:\x07|\x1b\\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw))) {
    markers.push({
      code: match[1],
      payload: decodeOscPayload(match[2] ?? ''),
      index: match.index,
      end: re.lastIndex,
    })
  }
  return markers
}

function parseExitCode(payload: string): number | undefined {
  const raw = payload.split(';')[0].trim()
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) ? parsed : undefined
}

function extractOsc133Blocks(raw: string, options: TerminalCommandBlockOptions): TerminalCommandBlock[] {
  const markers = parseOscMarkers(raw)
  if (!markers.length) return []

  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const blocks: TerminalCommandBlock[] = []
  let command = ''
  let outputStart = -1
  let startedAt: string | undefined

  for (const marker of markers) {
    if (marker.code === 'E') {
      command = marker.payload.trim()
    } else if (marker.code === 'C') {
      outputStart = marker.end
      startedAt = options.now?.()
    } else if (marker.code === 'D' && outputStart >= 0) {
      const output = limitOutput(raw.slice(outputStart, marker.index), maxOutputChars)
      if (command || output) {
        blocks.push({
          id: blockId(options, blocks.length),
          command,
          output,
          exitCode: parseExitCode(marker.payload),
          source: 'osc133',
          ...(startedAt ? { startedAt } : {}),
          ...(options.now ? { endedAt: options.now() } : {}),
        })
      }
      command = ''
      outputStart = -1
      startedAt = undefined
    }
  }

  return blocks.slice(-(options.maxBlocks ?? DEFAULT_MAX_BLOCKS))
}

function promptCommand(line: string): string | null {
  const trimmed = line.trim()
  const match = trimmed.match(/^(?:\[[^\]]+\]\s*)?(?:[\w.-]+@[\w.-]+\s+)?(?:[~\/][^\s]*|\S+)?\s*(?:[$%]|❯|>)\s+(.+)$/u)
    ?? trimmed.match(/^(?:\[[^\]]+\]\s*)?(?:[\w.-]+@[\w.-]+\s+|(?:[~\/][^\s]*|\S+)\s+)#\s+(.+)$/u)
  if (!match) return null
  const command = match[1].trim()
  if (!command || command === '$' || command.startsWith('[')) return null
  return command
}

function extractPromptBlocks(raw: string, options: TerminalCommandBlockOptions): TerminalCommandBlock[] {
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const lines = cleanTerminalText(raw).split('\n')
  const blocks: TerminalCommandBlock[] = []
  let current: { command: string; output: string[] } | null = null

  for (const line of lines) {
    const command = promptCommand(line)
    if (command) {
      if (current) {
        blocks.push({
          id: blockId(options, blocks.length),
          command: current.command,
          output: limitOutput(current.output.join('\n'), maxOutputChars),
          source: 'prompt',
        })
      }
      current = { command, output: [] }
    } else if (current) {
      current.output.push(line)
    }
  }

  if (current) {
    blocks.push({
      id: blockId(options, blocks.length),
      command: current.command,
      output: limitOutput(current.output.join('\n'), maxOutputChars),
      source: 'prompt',
    })
  }

  return blocks.slice(-(options.maxBlocks ?? DEFAULT_MAX_BLOCKS))
}

export function extractTerminalCommandBlocks(
  raw: string,
  options: TerminalCommandBlockOptions = {},
): TerminalCommandBlock[] {
  const oscBlocks = extractOsc133Blocks(raw, options)
  return oscBlocks.length ? oscBlocks : extractPromptBlocks(raw, options)
}
