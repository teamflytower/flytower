import type { Socket } from 'bun'
import { AgentError, Response } from './envelope.ts'
import { encode, lineSplitter } from './framing.ts'
import type { z } from 'zod'
import { routerVerbs, type RouterVerb } from './router.ts'
import { verbs, type Params, type Result, type Verb } from './verbs.ts'

export interface CallOptions {
  socketPath: string
  /** Default 30 s. Long verbs (runtime.install) pass more. */
  timeoutMs?: number
}

/**
 * Calls one agent verb over a fresh connection. Params are validated before sending and the
 * result after receiving, so both sides enforce the same schema. Failures throw AgentError:
 * the agent's own code when it answered, `internal` when it could not be reached.
 */
export function callAgent<V extends Verb>(
  verb: V,
  params: Params<V>,
  opts: CallOptions,
): Promise<Result<V>> {
  return call('agent', verbs[verb], verb, params, opts) as Promise<Result<V>>
}

export type RouterParams<V extends RouterVerb> = z.infer<(typeof routerVerbs)[V]['params']>
export type RouterResult<V extends RouterVerb> = z.infer<(typeof routerVerbs)[V]['result']>

/** Calls the hostname router's control socket, which speaks the same envelope. */
export function callRouter<V extends RouterVerb>(
  verb: V,
  params: RouterParams<V>,
  opts: CallOptions,
): Promise<RouterResult<V>> {
  return call('router', routerVerbs[verb], verb, params, opts) as Promise<RouterResult<V>>
}

function call(
  who: string,
  spec: { params: z.ZodType; result: z.ZodType },
  verb: string,
  params: unknown,
  { socketPath, timeoutMs = 30_000 }: CallOptions,
): Promise<unknown> {
  const checked = spec.params.safeParse(params)
  if (!checked.success) {
    return Promise.reject(new AgentError('invalid_params', checked.error.issues[0]?.message ?? ''))
  }
  const id = crypto.randomUUID()

  return new Promise((resolve, reject) => {
    let settled = false
    let conn: Socket | undefined
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conn?.end()
      fn()
    }
    const fail = (message: string) => finish(() => reject(new AgentError('internal', message)))
    const timer = setTimeout(() => fail(`${who} did not answer ${verb} in time`), timeoutMs)

    const feed = lineSplitter(
      (line) => {
        const parsed = Response.safeParse(JSON.parse(line))
        if (!parsed.success || parsed.data.id !== id) return
        const res = parsed.data
        if (!res.ok) {
          finish(() => reject(new AgentError(res.error.code, res.error.message)))
          return
        }
        const result = spec.result.safeParse(res.result)
        if (!result.success) return fail(`${who} returned an unexpected result`)
        finish(() => resolve(result.data))
      },
      () => fail(`${who} reply too long`),
    )

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          // Requests are a few hundred bytes, well under one socket write.
          socket.write(encode({ id, verb, params: checked.data }))
        },
        data(_socket, chunk) {
          feed(chunk)
        },
        close() {
          fail(`${who} closed the connection`)
        },
        error(_socket, err) {
          fail(`${who} unreachable: ${err.message}`)
        },
      },
    }).then(
      (socket) => {
        conn = socket
        if (settled) socket.end()
      },
      (err: Error) => fail(`${who} unreachable: ${err.message}`),
    )
  })
}

export * from './subscribe.ts'
