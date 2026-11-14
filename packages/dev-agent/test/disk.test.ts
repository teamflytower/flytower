import { describe, expect, it } from 'bun:test'
import { groupOf } from '../src/disk.ts'

const fixture = new URL('../../../protocol/fixtures/disk-groups.jsonl', import.meta.url)

describe('groupOf', () => {
  it('groups a server folder as the real agent does', async () => {
    const lines = (await Bun.file(fixture).text()).split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const { entry, levelName, group } = JSON.parse(line)
      expect([entry, groupOf(entry, levelName)]).toEqual([entry, group])
    }
  })
})
