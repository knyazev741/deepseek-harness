/** Full-response parsing rejects incomplete wire data before presenting any SDK chunks. */
import { beforeEach, expect, it, vi } from 'vitest'
import { fetchCompleteResponse } from '../src/complete-response.ts'

const transport = vi.hoisted(() => vi.fn<typeof fetch>())
vi.mock('@knyazevai/dsh-http-proxy', () => ({ fetchWithStreamTimeout: transport }))
beforeEach(() => transport.mockReset())

const request = { body: '{"stream":true,"stream_options":{"include_usage":true}}' }
const message = { role: 'assistant', content: 'answer' }
function completion(choice: object = { message, finish_reason: 'stop' }): string {
  return JSON.stringify({ choices: [choice] })
}
async function receive(body: BodyInit | null, status = 200) {
  transport.mockResolvedValueOnce(new Response(body, { status }))
  return fetchCompleteResponse('https://provider.test/v1/chat/completions', request, 1000, 4096)
}

it.each([
  ['no body', null, 204],
  ['invalid UTF-8', new Uint8Array([0xff]), 200],
  ['invalid JSON', '{', 200],
  ['null JSON', 'null', 200],
  ['no choices', '{}', 200],
  ['empty choices', '{"choices":[]}', 200],
  ['no message', completion({ finish_reason: 'stop' }), 200],
  ['no role', completion({ message: {}, finish_reason: 'stop' }), 200],
  ['non-string content', completion({ message: { ...message, content: [] }, finish_reason: 'stop' }), 200],
  ['non-array tool calls', completion({ message: { ...message, tool_calls: {} }, finish_reason: 'stop' }), 200],
  ['tool without id', completion({ message: { ...message, tool_calls: [{}] }, finish_reason: 'tool_calls' }), 200],
  ['tool without function', completion({ message: { ...message, tool_calls: [{ id: 'c', type: 'function' }] }, finish_reason: 'tool_calls' }), 200],
  ['unknown tool type', completion({ message: { ...message, tool_calls: [{ id: 'c', type: 'unknown' }] }, finish_reason: 'tool_calls' }), 200],
  ['tool without arguments', completion({ message: { ...message, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f' } }] }, finish_reason: 'tool_calls' }), 200],
] as const)('rejects %s', async (_label, body, status) => {
  await expect(receive(body, status)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
})

it.each([undefined, null, '', 1])('requires an explicit terminal reason: %s', async (finish_reason) => {
  await expect(receive(completion({ message, finish_reason }))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
})

it('retains custom tool fields and strips stale HTTP framing', async () => {
  transport.mockResolvedValueOnce(new Response(completion({ index: 0, finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'custom-one', type: 'custom', custom: { name: 'apply_patch', input: 'patch' } }],
  } }), { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '123' } }))
  const response = await fetchCompleteResponse('https://provider.test/v1/chat/completions', request, 1000, 4096)
  expect(response.headers.get('content-encoding')).toBeNull()
  expect(response.headers.get('content-length')).toBeNull()
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  expect(await response.text()).toContain('"custom":{"name":"apply_patch","input":"patch"}')
})

it('assigns the positional index when a complete choice omits it', async () => {
  const response = await receive(completion())
  expect(await response.text()).toContain('"index":0')
})

it.each([undefined, { body: new Uint8Array() }, { body: '{' }, { body: '[]' }])('rejects an unusable SDK request body', async (init) => {
  await expect(fetchCompleteResponse('https://provider.test', init, 1000, 4096)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  expect(transport).not.toHaveBeenCalled()
})
