import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Socket } from 'bun'
import { encode, lineSplitter } from '@flytower/protocol'
import { dispatch, type AgentContext, type Handlers } from './dispatch.ts'

export interface AgentServer {
  close(): void
}

interface Conn {
  feed: (chunk: Uint8Array) => void
  queue: Promise<void>
  /** Bytes the kernel has not accepted yet; flushed on drain. */
  pending: Uint8Array
}

const encoder = new TextEncoder()

function send(socket: Socket<Conn>, text: string) {
  const c = socket.data
  const bytes = encoder.encode(text)
  const out = c.pending.length ? new Uint8Array([...c.pending, ...bytes]) : bytes
  const written = socket.write(out)
  c.pending = written < out.length ? out.slice(Math.max(written, 0)) : new Uint8Array()
}

/**
 * Listens on a Unix socket, answering requests on one connection strictly in order, as the
 * real agent does. The stand-in runs as you, so the socket is only yours (mode 0600).
 */
export function listen(socketPath: string, handlers: Handlers, ctx: AgentContext): AgentServer {
  mkdirSync(dirname(socketPath), { recursive: true })
  if (existsSync(socketPath)) unlinkSync(socketPath)

  const listener = Bun.listen<Conn>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.timeout(10 * 60)
        socket.data = {
          pending: new Uint8Array(),
          queue: Promise.resolve(),
          feed: lineSplitter(
            (line) => {
              socket.data.queue = socket.data.queue.then(async () => {
                const res = await dispatch(line, handlers, ctx)
                if (socket.readyState === 1) send(socket, encode(res))
              })
            },
            () => socket.end(),
          ),
        }
      },
      data(socket, chunk) {
        socket.data.feed(chunk)
      },
      drain(socket) {
        if (socket.data.pending.length) send(socket, '')
      },
      timeout(socket) {
        socket.end()
      },
      error(socket) {
        socket.end()
      },
    },
  })
  chmodSync(socketPath, 0o600)
  return { close: () => listener.stop(true) }
}
