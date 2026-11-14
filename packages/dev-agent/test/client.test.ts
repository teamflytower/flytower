import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { AgentError } from '@flytower/protocol'
import { callAgent } from '@flytower/protocol/client'
import { protocolInfo, type Handlers } from '../src/dispatch.ts'
import { listen } from '../src/socket.ts'

const closers: (() => void)[] = []
afterEach(() => closers.splice(0).forEach((c) => c()))

const sock = () => join(mkdtempSync(join(tmpdir(), 'flytower-cl-')), 'agent.sock')

/** The stand-in's socket and dispatch, with just enough verbs to talk to. */
function agentAt() {
  const socketPath = sock()
  const handlers = {
    ping: async (_p, ctx) => protocolInfo(ctx.version),
    'service.start': async ({ server }) => {
      throw new AgentError('not_found', `no server ${server}`)
    },
  } as Partial<Handlers> as Handlers
  const server = listen(socketPath, handlers, { version: '0.0.0-test', log: () => {} })
  closers.push(() => server.close())
  return socketPath
}

describe('callAgent against the stand-in', () => {
  it('returns a typed result', async () => {
    const socketPath = agentAt()
    expect(await callAgent('ping', {}, { socketPath })).toEqual({
      agentVersion: '0.0.0-test',
      protocol: 1,
    })
  })

  it("throws the agent's error code", async () => {
    const socketPath = agentAt()
    const err = await callAgent('service.start', { server: 'ghost' }, { socketPath }).catch(
      (e) => e,
    )
    expect(err).toMatchObject({ name: 'AgentError', code: 'not_found' })
  })

  it('validates params before sending', async () => {
    const err = await callAgent(
      'service.start',
      { server: 'BAD NAME' },
      { socketPath: sock() },
    ).catch((e) => e)
    expect(err).toMatchObject({ code: 'invalid_params' })
  })

  it('reports an unreachable agent', async () => {
    const err = await callAgent('ping', {}, { socketPath: sock() }).catch((e) => e)
    expect(err).toMatchObject({ code: 'internal' })
    expect(err.message).toContain('unreachable')
  })

  it('times out when the agent never answers', async () => {
    const socketPath = sock()
    const silent = createServer(() => {})
    await new Promise<void>((r) => silent.listen(socketPath, r))
    closers.push(() => silent.close())
    const err = await callAgent('ping', {}, { socketPath, timeoutMs: 50 }).catch((e) => e)
    expect(err.message).toContain('in time')
  })
})
