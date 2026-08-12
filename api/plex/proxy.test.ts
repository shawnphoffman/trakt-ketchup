import { describe, expect, it } from 'vitest'
import { isPrivate } from './proxy'

// The proxy will only fetch a plex.direct hostname that resolves to a public
// address. This is the check that keeps it from being used to probe private
// networks, so the ranges matter more than the happy path.
describe('isPrivate', () => {
  it('rejects RFC1918, loopback, link-local, and CGNAT', () => {
    for (const address of [
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.10',
      '127.0.0.1',
      '169.254.169.254', // cloud metadata endpoint
      '100.64.0.1',
      '0.0.0.0',
    ]) {
      expect(isPrivate(address), address).toBe(true)
    }
  })

  it('allows ordinary public addresses', () => {
    for (const address of ['172.104.29.70', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1']) {
      expect(isPrivate(address), address).toBe(false)
    }
  })

  it('handles IPv6, including v4-mapped forms', () => {
    expect(isPrivate('::1')).toBe(true)
    expect(isPrivate('fd00::1')).toBe(true) // unique-local
    expect(isPrivate('fe80::1')).toBe(true) // link-local
    expect(isPrivate('::ffff:10.0.0.1')).toBe(true)
    expect(isPrivate('2606:4700:4700::1111')).toBe(false)
  })

  it('treats anything unparseable as private', () => {
    expect(isPrivate('not-an-address')).toBe(true)
    expect(isPrivate('999.1.1.1')).toBe(true)
    expect(isPrivate('10.0.0')).toBe(true)
  })
})
