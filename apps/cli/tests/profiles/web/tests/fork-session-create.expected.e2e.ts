/** Real shipped fork-Web session creation with both model-selectable delegation tools. */
import { request } from 'node:http'
import { expect, it } from 'vitest'
import { withDefaultWeb, webGet } from './default-web-process.ts'

it('creates distinct sessions in every fork preset through the shipped backend', async (test) => {
  await withDefaultWeb(test, async ({ url }) => {
    const auth = await webGet(url, test.signal)
    const cookie = auth.headers['set-cookie']?.[0]?.split(';', 1)[0]
    expect(cookie).toBeDefined()
    const ids = new Set<string>()
    for (const agentPreset of ['standard', 'ptc', 'cordis', 'standard']) {
      const body = await new Promise<string>((resolve, reject) => {
        const req = request(new URL('/api/session/create', url), {
          method: 'POST', agent: false, signal: test.signal,
          headers: { 'content-type': 'application/json', cookie: cookie! },
        }, (res) => {
          let text = ''
          res.setEncoding('utf8').on('data', (chunk: string) => { text += chunk })
          res.once('error', reject)
          res.once('end', () => { resolve(text) })
        })
        req.once('error', reject)
        req.end(JSON.stringify({
          type: 'client-request', rpcId: `create-${agentPreset}-${ids.size}`,
          method: 'session/create', payload: { args: { request: { agentPreset } } },
        }))
      })
      const reply = JSON.parse(body) as { result: { ok: boolean; value?: { sessionId: string; agentPreset: string } } }
      expect(reply.result.ok, body).toBe(true)
      expect(reply.result.value?.agentPreset).toBe(agentPreset)
      expect(reply.result.value?.sessionId).toBeTruthy()
      ids.add(reply.result.value!.sessionId)
    }
    expect(ids.size).toBe(4)
  }, 'fork-web')
})
