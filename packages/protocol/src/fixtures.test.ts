/**
 * Replays the shared fixtures in protocol/fixtures, which the Rust and Go implementations
 * replay too (docs/decisions/0001-rust-and-go.md).
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod'
import { Cancel, Frame, Request, Response, Subscribe } from './envelope.ts'
import { protocolJsonSchema, protocolJsonSchemaText } from './json-schema.ts'
import { routerVerbNames, routerVerbs, type RouterVerb } from './router.ts'
import { subscriptionNames, subscriptions, verbNames, verbs, type Verb } from './verbs.ts'

const root = join(import.meta.dir, '../../../protocol')

type EnvelopeKind = 'request' | 'response' | 'subscribe' | 'cancel' | 'frame'
interface Line {
  verb?: string
  kind: EnvelopeKind | 'params' | 'result' | 'event'
  valid: boolean
  note?: string
  value: unknown
}

const read = async (name: string) =>
  (await Bun.file(join(root, 'fixtures', name)).text())
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Line)

const envelope = await read('envelope.jsonl')
const verbLines = await read('verbs.jsonl')
const routerLines = (await read('router.jsonl')) as (Line & { verb: RouterVerb })[]
const subLines = await read('subscriptions.jsonl')
const envelopes: Record<EnvelopeKind, z.ZodType> = {
  request: Request,
  response: Response,
  subscribe: Subscribe,
  cancel: Cancel,
  frame: Frame,
}
const isEnvelope = (l: Line): l is Line & { kind: EnvelopeKind } => Object.hasOwn(envelopes, l.kind)
const label = (l: Line) =>
  `${l.verb ? l.verb + ' ' : ''}${l.kind} ${l.valid ? 'accepts' : 'refuses'} ${l.note ?? JSON.stringify(l.value)}`
const zodFor = (l: Line): z.ZodType =>
  isEnvelope(l)
    ? envelopes[l.kind]
    : subLines.includes(l)
      ? subscriptions[l.verb as keyof typeof subscriptions][l.kind as 'params' | 'result' | 'event']
      : verbs[l.verb as Verb][l.kind as 'params' | 'result']
/** Lines whose rule JSON Schema can't express. */
const isRefinement = (l: Line) => l.note?.endsWith('(a refinement, not in schema.json)') ?? false

describe('fixtures against the Zod schemas', () => {
  it.each([...envelope, ...verbLines, ...subLines].map((l) => [label(l), l] as const))(
    '%s',
    (_, l) => {
      expect(zodFor(l).safeParse(l.value).success).toBe(l.valid)
    },
  )

  it('only name known verbs and subscriptions', () => {
    for (const l of verbLines) expect(verbNames).toContain(l.verb as Verb)
    for (const l of subLines) expect(subscriptionNames as string[]).toContain(l.verb!)
  })

  it.each(verbNames.map((v) => [v]))('cover %s with a valid params and result line', (v) => {
    const mine = verbLines.filter((l) => l.verb === v && l.valid)
    expect(mine.some((l) => l.kind === 'params')).toBe(true)
    expect(mine.some((l) => l.kind === 'result')).toBe(true)
  })

  it.each(subscriptionNames.map((s) => [s]))(
    'cover %s with a valid params, result and event line',
    (s) => {
      const mine = subLines.filter((l) => l.verb === s && l.valid)
      for (const kind of ['params', 'result', 'event'])
        expect(mine.some((l) => l.kind === kind)).toBe(true)
    },
  )
})

describe('protocol/schema.json', () => {
  it('is up to date (run `bun scripts/protocol-schema.ts`)', async () => {
    expect(await Bun.file(join(root, 'schema.json')).text()).toBe(protocolJsonSchemaText())
  })

  // Reading the exported schema back proves it says the same as Zod, as far as JSON Schema can.
  const schema = protocolJsonSchema()
  const fromJson = (l: Line) =>
    z.fromJSONSchema(
      (isEnvelope(l)
        ? schema[l.kind]
        : subLines.includes(l)
          ? schema.subscriptions[l.verb!]![l.kind as 'params' | 'result' | 'event']
          : schema.verbs[l.verb!]![l.kind as 'params' | 'result']) as Parameters<
        typeof z.fromJSONSchema
      >[0],
    )
  it.each(
    [...envelope, ...verbLines, ...subLines]
      .filter((l) => !isRefinement(l))
      .map((l) => [label(l), l] as const),
  )('%s', (_, l) => {
    expect(fromJson(l).safeParse(l.value).success).toBe(l.valid)
  })
})

describe('router fixtures', () => {
  const schema = protocolJsonSchema()
  const kindOf = (l: Line) => l.kind as 'params' | 'result'

  it.each(routerLines.map((l) => [label(l), l] as const))('Zod: %s', (_, l) => {
    expect(routerVerbs[l.verb][kindOf(l)].safeParse(l.value).success).toBe(l.valid)
  })

  it.each(routerLines.filter((l) => !isRefinement(l)).map((l) => [label(l), l] as const))(
    'schema.json: %s',
    (_, l) => {
      const json = schema.routerVerbs[l.verb]![kindOf(l)] as Parameters<typeof z.fromJSONSchema>[0]
      expect(z.fromJSONSchema(json).safeParse(l.value).success).toBe(l.valid)
    },
  )

  it.each(routerVerbNames.map((v) => [v]))('cover %s with a valid params and result line', (v) => {
    const mine = routerLines.filter((l) => l.verb === v && l.valid)
    expect(mine.some((l) => l.kind === 'params')).toBe(true)
    expect(mine.some((l) => l.kind === 'result')).toBe(true)
  })
})
