import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_TRIM,
  TrimRules,
  compactTrim,
  describeTrim,
  readTrimRules,
  sameTrimRules,
  toToolRules,
} from '../shared/trim-rules'
import { ServerSpec, compactSpec } from '../shared/spec'
import { specNeeds } from '../server/spec/sections'

const issues = (input: unknown) => {
  const r = TrimRules.safeParse(input)
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}

describe('trim rules', () => {
  it('fills in the planned defaults', () => {
    expect(DEFAULT_TRIM).toEqual({
      inhabitedMinutes: 2,
      spawnRadius: 16,
      playerRadius: 4,
      buffer: 2,
      endRadius: 12,
      unfinished: true,
      border: true,
      dimensions: ['overworld', 'the_nether', 'the_end'],
      protect: [],
    })
    expect(readTrimRules(null)).toEqual(DEFAULT_TRIM)
    expect(readTrimRules({ buffer: 'lots' })).toEqual(DEFAULT_TRIM)
  })

  it('reads the example from the issue', () => {
    const rules = TrimRules.parse({
      inhabitedMinutes: 2,
      spawnRadius: 16,
      playerRadius: 4,
      buffer: 2,
      dimensions: ['overworld', 'the_nether', 'the_end'],
      protect: [{ name: 'Town', dimension: 'overworld', from: [-400, -300], to: [350, 420] }],
    })
    expect(rules.protect[0]).toEqual({
      name: 'Town',
      dimension: 'overworld',
      from: [-400, -300],
      to: [350, 420],
    })
  })

  it('writes dimensions without minecraft:, and keeps modded ones', () => {
    const rules = TrimRules.parse({
      dimensions: ['minecraft:the_nether', 'Mod:Sky'],
      protect: [{ name: 'Hub', dimension: 'minecraft:the_end', from: [0, 0], to: [1, 1] }],
    })
    expect(rules.dimensions).toEqual(['the_nether', 'mod:sky'])
    expect(rules.protect[0]!.dimension).toBe('the_end')
    expect(issues({ dimensions: ['the_end', 'minecraft:the_end'] })).toEqual([
      'dimensions: Each dimension is listed once.',
    ])
  })

  it('explains what is wrong', () => {
    expect(issues({ buffer: 17 })).toEqual(['buffer: buffer is at most 16 chunks.'])
    expect(issues({ spawnRadius: 1.5 })).toEqual([
      'spawnRadius: spawnRadius is a whole number of chunks.',
    ])
    expect(issues({ inhabitedMinutes: -1 })).toEqual([
      "inhabitedMinutes: inhabitedMinutes can't be below 0.",
    ])
    expect(issues({ spawnradius: 3 })[0]).toContain('spawnradius')
    expect(issues({ protect: [{ name: '', from: [0, 0], to: [1, 1] }] })).toEqual([
      'protect.0.name: Give the area a name, like "Town".',
    ])
    expect(issues({ protect: [{ name: 'A', from: [0], to: [1, 1] }] })[0]).toStartWith(
      'protect.0.from',
    )
    expect(issues({ protect: [{ name: 'A', from: [0, 30_000_001], to: [1, 1] }] })).toEqual([
      'protect.0.from.1: Coordinates go from -30000000 to 30000000.',
    ])
    expect(
      issues({
        protect: [
          { name: 'Town', from: [0, 0], to: [1, 1] },
          { name: 'town', from: [5, 5], to: [9, 9] },
        ],
      }),
    ).toEqual(['protect.1.name: There\'s already an area called "town".'])
  })

  it('compacts to what differs from the defaults', () => {
    expect(compactTrim(DEFAULT_TRIM)).toBeNull()
    const rules = TrimRules.parse({
      buffer: 4,
      dimensions: ['overworld'],
      protect: [
        { name: 'Town', from: [1, 2], to: [3, 4] },
        { name: 'Hub', dimension: 'the_nether', from: [1, 2], to: [3, 4] },
      ],
    })
    expect(compactTrim(rules)).toEqual({
      buffer: 4,
      dimensions: ['overworld'],
      protect: [
        { name: 'Town', from: [1, 2], to: [3, 4] },
        { name: 'Hub', dimension: 'the_nether', from: [1, 2], to: [3, 4] },
      ],
    })
    expect(TrimRules.parse(compactTrim(rules))).toEqual(rules)
    expect(describeTrim(rules)).toBe('1 rule changed, trims overworld, 2 protected areas')
    expect(describeTrim(DEFAULT_TRIM)).toBe('Default rules')
  })

  it('treats swapped corners as the same area', () => {
    const a = TrimRules.parse({ protect: [{ name: 'T', from: [0, 10], to: [20, 0] }] })
    const b = TrimRules.parse({ protect: [{ name: 'T', from: [20, 0], to: [0, 10] }] })
    expect(sameTrimRules(a, b)).toBe(true)
    expect(sameTrimRules(a, DEFAULT_TRIM)).toBe(false)
  })

  it('gives the tool every rule, so its defaults never matter', () => {
    const json = toToolRules(
      TrimRules.parse({ protect: [{ name: 'Town', from: [-400, -300], to: [350, 420] }] }),
    )
    expect(Object.keys(json).sort()).toEqual(
      [
        'border',
        'buffer',
        'dimensions',
        'endRadius',
        'inhabitedMinutes',
        'playerRadius',
        'protect',
        'spawnRadius',
        'unfinished',
      ].sort(),
    )
    expect(json.protect).toEqual([
      { name: 'Town', dimension: 'overworld', from: [-400, -300], to: [350, 420] },
    ])
  })
})

describe('world.trim in a spec', () => {
  const base = { name: 'survival', loader: { type: 'fabric', minecraft: '26.3' } }

  it('round-trips through the compact spec', () => {
    const spec = ServerSpec.parse({
      ...base,
      world: { trim: { playerRadius: 6, protect: [{ name: 'Town', from: [0, 0], to: [9, 9] }] } },
    })
    expect(compactSpec(spec).world).toEqual({
      trim: { playerRadius: 6, protect: [{ name: 'Town', from: [0, 0], to: [9, 9] }] },
    })
    expect(compactSpec(ServerSpec.parse({ ...base, world: { trim: {} } })).world).toBeUndefined()
    expect(ServerSpec.safeParse({ ...base, world: { trimm: {} } }).success).toBe(false)
  })

  it('needs world.manage to change', () => {
    const now = ServerSpec.parse(base)
    const next = ServerSpec.parse({ ...base, world: { trim: { buffer: 3 } } })
    expect(specNeeds(now, next)).toEqual(['world.manage'])
    expect(specNeeds(next, next)).toEqual([])
  })
})
