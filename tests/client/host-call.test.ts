/**
 * `host-call` 的用例：请求形状、信封透传、HTTP 失败与资产 URL 拼接。
 *
 * 只桩掉 `fetch` 与 `console`——被测模块本身不认识 React/DOM，Node 里跑的是真身。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INVOKE_PATH, assetUrl, hostCall } from '../../src/client/host-call.ts'

/** 记录请求的 fetch 替身。 */
function stubFetch(answer: { ok: boolean; status?: number; json?: () => unknown }) {
  const original = globalThis.fetch
  const calls: { url: string; init: RequestInit }[] = []
  globalThis.fetch = ((url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit })
    return Promise.resolve({
      ok: answer.ok,
      status: answer.status ?? (answer.ok ? 200 : 500),
      json: () => Promise.resolve(answer.json?.()),
    })
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('hostCall 同源 POST /invoke，信封原样返回', async () => {
  const stub = stubFetch({ ok: true, json: () => ({ ok: true, records: [] }) })
  try {
    const result = await hostCall('draft-list')
    assert.deepEqual(result, { ok: true, records: [] })
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0]?.url, INVOKE_PATH)
    assert.equal(stub.calls[0]?.init.method, 'POST')
    assert.deepEqual(JSON.parse(String(stub.calls[0]?.init.body)), { method: 'draft-list', params: {} })
    assert.deepEqual(stub.calls[0]?.init.headers, { 'Content-Type': 'application/json' })
  } finally {
    stub.restore()
  }
})

test('hostCall 把 params 放进信封的 params 字段', async () => {
  const stub = stubFetch({ ok: true, json: () => ({ ok: true }) })
  try {
    await hostCall('draft-save', { payload: { text: 'hi' } })
    assert.deepEqual(JSON.parse(String(stub.calls[0]?.init.body)), {
      method: 'draft-save',
      params: { payload: { text: 'hi' } },
    })
  } finally {
    stub.restore()
  }
})

test('hostCall 对 HTTP 非 2xx 抛错（业务失败仍是 200，不走这条）', async () => {
  const stub = stubFetch({ ok: false, status: 503 })
  try {
    await assert.rejects(() => hostCall('draft-list'), /HTTP 503/)
  } finally {
    stub.restore()
  }
})

test('hostCall 对耗时 >500ms 记一条 INFO', async () => {
  const stub = stubFetch({ ok: true, json: () => ({ ok: true }) })
  const originalNow = Date.now
  const infos: string[] = []
  const originalInfo = console.info
  // hostCall 只读两次时钟：入口的 startedAt、拿到响应后的 cost。
  // 两次读数差 600ms → 必然走「>500ms 记 INFO」那条分支。
  const readings = [0, 600]
  Date.now = () => readings.shift() ?? 600
  console.info = (msg?: unknown) => { infos.push(String(msg)) }
  try {
    await hostCall('draft-list')
    assert.deepEqual(infos, ['[dsh-prompt-inbox] [INFO] host 调用 draft-list 耗时 600ms'])
  } finally {
    stub.restore()
    Date.now = originalNow
    console.info = originalInfo
  }
})

test('assetUrl 对 ref 做 URL 编码（ref 里的 / 不能漏出去）', () => {
  assert.equal(
    assetUrl('sha256/ab/' + 'f'.repeat(64) + '.bin'),
    '/dsh-prompt-inbox/asset?ref=sha256%2Fab%2F' + 'f'.repeat(64) + '.bin',
  )
})
