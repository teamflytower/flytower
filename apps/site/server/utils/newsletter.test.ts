import { describe, expect, test } from 'bun:test'
import { CONSENT, CONSENT_VERSION, normaliseEmail, sameOrigin } from './newsletter'

describe('normaliseEmail', () => {
  test('trims and lower-cases', () => {
    expect(normaliseEmail('  Alex@Example.COM ')).toBe('alex@example.com')
  })
  test('refuses what is not an address', () => {
    for (const bad of [
      '',
      'alex',
      'alex@',
      '@example.com',
      'alex@example',
      'a b@example.com',
      42,
      null,
    ])
      expect(normaliseEmail(bad)).toBeNull()
  })
  test('refuses control characters and over-long addresses', () => {
    expect(normaliseEmail('alex@example.com\n')).toBe('alex@example.com')
    expect(normaliseEmail('al\u0000ex@example.com')).toBeNull()
    expect(normaliseEmail(`${'a'.repeat(250)}@example.com`)).toBeNull()
  })
})

describe('sameOrigin', () => {
  const url = new URL('https://flytower.dev/api/newsletter/subscribe')
  test('accepts our own pages only', () => {
    expect(sameOrigin('https://flytower.dev', url)).toBe(true)
    expect(sameOrigin('https://evil.example', url)).toBe(false)
    expect(sameOrigin(undefined, url)).toBe(false)
    expect(sameOrigin('not a url', url)).toBe(false)
  })
})

test('the current consent wording exists', () => {
  expect(CONSENT[CONSENT_VERSION]).toBeTruthy()
})
