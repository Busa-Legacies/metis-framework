import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RUNTIME_GUARDRAILS,
  buildRuntimeGuardrailConfig,
  trimOutputLine,
  trimPersistedOutputLines,
  type RuntimeGuardrailConfig,
} from '../lib/runtime-guardrails.ts'

test('runtime guardrail defaults match release output/runtime caps', () => {
  assert.deepEqual(buildRuntimeGuardrailConfig({}), DEFAULT_RUNTIME_GUARDRAILS)
  assert.equal(DEFAULT_RUNTIME_GUARDRAILS.outputTailLines, 240)
  assert.equal(DEFAULT_RUNTIME_GUARDRAILS.outputTailBytes, 96 * 1024)
  assert.equal(DEFAULT_RUNTIME_GUARDRAILS.outputLineChars, 4096)
  assert.equal(DEFAULT_RUNTIME_GUARDRAILS.chatTurnsMax, 80)
  assert.equal(DEFAULT_RUNTIME_GUARDRAILS.chatTurnChars, 6000)
  assert.equal(DEFAULT_RUNTIME_GUARDRAILS.resumeSpecsMax, 24)
})

test('runtime guardrail env overrides accept positive integers and reject unsafe values', () => {
  const config = buildRuntimeGuardrailConfig({
    AW_OUTPUT_TAIL_LINES: '12.7',
    AW_OUTPUT_TAIL_BYTES: '2048',
    AW_OUTPUT_LINE_CHARS: '256',
    AW_CHAT_TURNS_MAX: '0',
    AW_CHAT_TURN_CHARS: '-10',
    AW_RESUME_SPECS_MAX: 'not-a-number',
  })

  assert.equal(config.outputTailLines, 12)
  assert.equal(config.outputTailBytes, 2048)
  assert.equal(config.outputLineChars, 256)
  assert.equal(config.chatTurnsMax, DEFAULT_RUNTIME_GUARDRAILS.chatTurnsMax)
  assert.equal(config.chatTurnChars, DEFAULT_RUNTIME_GUARDRAILS.chatTurnChars)
  assert.equal(config.resumeSpecsMax, DEFAULT_RUNTIME_GUARDRAILS.resumeSpecsMax)
})

test('persisted output guardrails bound line count, line width, and byte budget', () => {
  const config: RuntimeGuardrailConfig = {
    outputTailLines: 3,
    outputTailBytes: 11,
    outputLineChars: 4,
    chatTurnsMax: 80,
    chatTurnChars: 6000,
    resumeSpecsMax: 24,
  }

  assert.equal(trimOutputLine('abcdef', config), 'cdef')
  assert.deepEqual(trimPersistedOutputLines(['one', 'two', 'three', 'four', 'five'], config), ['four', 'five'])
  assert.deepEqual(trimPersistedOutputLines(['short', 'abcdef', 'ghijkl'], config), ['cdef', 'ijkl'])
})
