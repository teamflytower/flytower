import {
  AgentError,
  PROTOCOL_VERSION,
  Request,
  verbs,
  type Params,
  type Response,
  type Result,
  type Verb,
} from '@flytower/protocol'

/** What every handler is given: the version to report and where to log each request. */
export interface AgentContext {
  version: string
  log: (event: AuditEvent) => void
}

export interface AuditEvent {
  at: string
  id: string
  verb: string
  outcome: 'ok' | 'error'
  code?: string
  ms: number
}

export type Handler<V extends Verb> = (params: Params<V>, ctx: AgentContext) => Promise<Result<V>>
export type Handlers = { [V in Verb]: Handler<V> }

const isVerb = (v: string): v is Verb => Object.hasOwn(verbs, v)

/**
 * Turns one request line into one response, checking params and results against the shared
 * protocol, so the panel gets the same errors from the stand-in as from the real agent. Never throws: every failure becomes an error
 * response, and every request is written to the audit log.
 */
export async function dispatch(
  line: string,
  handlers: Handlers,
  ctx: AgentContext,
): Promise<Response> {
  const started = Date.now()
  let id = 'unknown'
  let verb = 'unknown'
  const finish = (res: Response): Response => {
    ctx.log({
      at: new Date(started).toISOString(),
      id,
      verb,
      outcome: res.ok ? 'ok' : 'error',
      ...(res.ok ? {} : { code: res.error.code }),
      ms: Date.now() - started,
    })
    return res
  }
  const fail = (code: AgentError['code'], message: string) =>
    finish({ id, ok: false, error: { code, message } })

  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return fail('bad_request', 'not valid JSON')
  }
  const req = Request.safeParse(raw)
  if (!req.success) return fail('bad_request', 'not a valid request envelope')
  id = req.data.id
  verb = req.data.verb
  if (!isVerb(verb)) return fail('unknown_verb', `unknown verb ${JSON.stringify(verb)}`)

  const spec = verbs[verb]
  const params = spec.params.safeParse(req.data.params ?? {})
  if (!params.success)
    return fail('invalid_params', params.error.issues.map((i) => i.message).join('; '))

  try {
    const handler = handlers[verb] as Handler<Verb>
    const result = await handler(params.data as Params<Verb>, ctx)
    const checked = spec.result.safeParse(result)
    if (!checked.success) return fail('internal', 'handler returned an invalid result')
    return finish({ id, ok: true, result: checked.data })
  } catch (err) {
    if (err instanceof AgentError) return fail(err.code, err.message)
    return fail('internal', err instanceof Error ? err.message : 'unexpected error')
  }
}

export const protocolInfo = (version: string) => ({
  agentVersion: version,
  protocol: PROTOCOL_VERSION,
})
