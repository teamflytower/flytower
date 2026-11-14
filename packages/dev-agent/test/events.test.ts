import { describe, expect, it } from 'bun:test'
import { serverOfLine, UnitEvents, type Follow } from '../src/events.ts'

/** A follower the test feeds lines into, and can make exit. */
function fakeFollow() {
  let emit: (line: string) => void = () => {}
  let exit: () => void = () => {}
  let starts = 0
  const follow: Follow = (onLine) => {
    starts++
    emit = onLine
    return { stop: () => exit(), exited: new Promise<void>((r) => (exit = r)) }
  }
  const line = (unit: string) =>
    emit(JSON.stringify({ UNIT: unit, MESSAGE: 'Main process exited, code=killed, status=9/KILL' }))
  return { follow, line, exit: () => exit(), starts: () => starts }
}

describe('UnitEvents', () => {
  it('reads which server a journal line is about', () => {
    expect(serverOfLine('{"UNIT":"flytower-mc@survival.service"}')).toBe('survival')
    expect(serverOfLine('{"UNIT":"ssh.service"}')).toBeNull()
    expect(serverOfLine('not json')).toBeNull()
  })

  it('answers a first call with everything, then waits for news', async () => {
    const f = fakeFollow()
    const ev = new UnitEvents(f.follow)
    ev.start()
    const first = await ev.wait(['a', 'b'], null, 1000)
    expect(first).toMatchObject({ changed: ['a', 'b'], following: true })

    const pending = ev.wait(['a', 'b'], first.cursor, 5000)
    f.line('ssh.service')
    f.line('flytower-mc@b.service')
    const next = await pending
    expect(next.changed).toEqual(['b'])

    // Nothing new: it times out empty-handed.
    expect((await ev.wait(['a', 'b'], next.cursor, 1000)).changed).toEqual([])
    ev.stop()
  })

  it('collects a burst of lines into one answer', async () => {
    const f = fakeFollow()
    const ev = new UnitEvents(f.follow)
    ev.start()
    const { cursor } = await ev.wait(['a', 'b'], null, 1000)
    const pending = ev.wait(['a', 'b'], cursor, 5000)
    f.line('flytower-mc@a.service')
    setTimeout(() => f.line('flytower-mc@b.service'), 50)
    expect((await pending).changed.sort()).toEqual(['a', 'b'])
    ev.stop()
  })

  it('says everything changed when the journal stops, then follows again', async () => {
    const f = fakeFollow()
    const ev = new UnitEvents(f.follow, 20)
    ev.start()
    const { cursor } = await ev.wait(['a'], null, 1000)
    const pending = ev.wait(['a'], cursor, 5000)
    f.exit()
    expect(await pending).toMatchObject({ changed: ['a'], following: false })
    await Bun.sleep(40)
    expect(f.starts()).toBe(2)
    expect(ev.following).toBe(true)
    // The old cursor belongs to the old run: everything again.
    expect((await ev.wait(['a'], cursor, 1000)).changed).toEqual(['a'])
    ev.stop()
  })
})
