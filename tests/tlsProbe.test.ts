import { afterEach, describe, expect, it } from 'vitest'
import { closeOutboundDispatchers } from '../src/net/outboundDispatcher.js'
import { parseTlsObservation, probeTlsFingerprint } from '../src/admin/tlsProbe.js'

const fixture = {
  ip: '203.0.113.9:44321',
  http_version: 'h2',
  user_agent: 'test-agent',
  tls: {
    ja3: '771,4865-4866,0-11-10',
    ja3_hash: 'abcd',
    ja4: 't13d1516h2_8daaf6152771_02713d6af862',
    ja4_r: 't13d1516h2_002f',
    extensions: [
      { name: 'server_name (0)' },
      {
        name: 'application_layer_protocol_negotiation (16)',
        protocols: ['h2', 'http/1.1'],
      },
    ],
  },
}

describe('TLS observation parser', () => {
  afterEach(async () => {
    await closeOutboundDispatchers()
  })

  it('reads JA4, JA3, ALPN, and egress IP from a peet-style payload', () => {
    const obs = parseTlsObservation(fixture, 'sticky')
    expect(obs.ok).toBe(true)
    expect(obs.ja4).toBe(fixture.tls.ja4)
    expect(obs.ja3Hash).toBe('abcd')
    expect(obs.alpn).toEqual(['h2', 'http/1.1'])
    expect(obs.egressIp).toBe('203.0.113.9')
    expect(obs.httpVersion).toBe('h2')
  })

  it('compares sticky and direct observations without altering the dispatcher', async () => {
    const report = await probeTlsFingerprint({
      proxyUrl: 'http://127.0.0.1:9',
      compareDirect: true,
      url: 'https://tls.peet.ws/api/all',
      fetchImpl: async (_url, dispatcher) => ({
        status: 200,
        text: JSON.stringify({
          ...fixture,
          ip: dispatcher ? '203.0.113.9:111' : '198.51.100.8:222',
          tls: {
            ...fixture.tls,
            ja4: dispatcher ? 't13d_sticky_example' : 't13d_direct_example',
          },
        }),
      }),
    })
    expect(report.proxyKind).toBe('http')
    expect(report.sticky?.ja4).toBe('t13d_sticky_example')
    expect(report.sticky?.egressIp).toBe('203.0.113.9')
    expect(report.direct?.ja4).toBe('t13d_direct_example')
    expect(report.direct?.egressIp).toBe('198.51.100.8')
    expect(report.note).toMatch(/observe-only/i)
  })

  it('skips the network when the account has no sticky proxy', async () => {
    let calls = 0
    const report = await probeTlsFingerprint({
      compareDirect: false,
      fetchImpl: async () => {
        calls++
        return { status: 200, text: '{}' }
      },
    })
    expect(calls).toBe(0)
    expect(report.sticky?.ok).toBe(false)
    expect(report.direct).toBeUndefined()
  })
})
