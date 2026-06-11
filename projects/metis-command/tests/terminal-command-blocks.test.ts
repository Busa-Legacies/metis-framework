import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cleanTerminalText, extractTerminalCommandBlocks } from '../lib/terminal-command-blocks'

describe('terminal command block extraction', () => {
  it('extracts OSC 133 command blocks with exit status when shell integration is present', () => {
    const raw = [
      '\x1b]133;A\x07prompt',
      '\x1b]133;E;npm%20test\x07',
      '\x1b]133;C\x07',
      '\x1b[32mok\x1b[0m\n',
      'done\n',
      '\x1b]133;D;0\x07',
    ].join('')

    assert.deepEqual(extractTerminalCommandBlocks(raw, { id: (index) => `b${index}` }), [{
      id: 'b0',
      command: 'npm test',
      output: 'ok\ndone',
      exitCode: 0,
      source: 'osc133',
    }])
  })

  it('falls back to common shell prompt heuristics', () => {
    const raw = [
      'agent-workbench % npm test',
      'TAP version 13',
      '# pass 4',
      'agent-workbench % git status --short',
      ' M lib/example.ts',
    ].join('\n')

    const blocks = extractTerminalCommandBlocks(raw)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].command, 'npm test')
    assert.equal(blocks[0].output, 'TAP version 13\n# pass 4')
    assert.equal(blocks[1].command, 'git status --short')
    assert.equal(blocks[1].output, 'M lib/example.ts')
    assert.equal(blocks[1].source, 'prompt')
  })

  it('bounds block count and output size', () => {
    const raw = [
      '$ first',
      '123456789',
      '$ second',
      'abcdefghi',
      '$ third',
      'last-output',
    ].join('\n')

    const blocks = extractTerminalCommandBlocks(raw, { maxBlocks: 2, maxOutputChars: 4 })
    assert.deepEqual(blocks.map((block) => [block.command, block.output]), [
      ['second', 'fghi'],
      ['third', 'tput'],
    ])
  })

  it('strips ANSI and OSC control sequences from display text', () => {
    assert.equal(cleanTerminalText('\x1b]133;A\x07\x1b[31mhello\x1b[0m\rworld'), 'hello\nworld')
  })
})

