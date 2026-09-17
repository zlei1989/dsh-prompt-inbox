import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPickerElementSource } from '../../src/host/element-source.ts'
import { createElementRegistry } from '../../src/host/element-registry.ts'
import type { DraftElementRecord } from '../../src/shared/types.ts'

test('picker 摘要命中时返回 label 与 pageUrl，且标 degraded', async () => {
  const source = createPickerElementSource({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: (async () => new Response(JSON.stringify({
      ok: true,
      items: [{ domId: 'DOM14', label: '完全权限', pageUrl: 'http://127.0.0.1:3080/' }],
    }))) as typeof fetch,
  })
  const [hit] = await source.lookup(['DOM14'])
  assert.equal(hit?.id, 'DOM14')
  assert.equal(hit?.label, '完全权限')
  assert.equal(hit?.pageUrl, 'http://127.0.0.1:3080/')
  assert.equal(hit?.payload, null)
  assert.equal(hit?.degraded, true, '拿不到完整 payload，必须标 degraded')
})

test('picker 未装/请求失败时只留 id，仍标 degraded', async () => {
  const source = createPickerElementSource({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch,
  })
  const [miss] = await source.lookup(['DOM99'])
  assert.equal(miss?.id, 'DOM99')
  assert.equal(miss?.label, undefined)
  assert.equal(miss?.degraded, true)
})

test('picker 返回 ok:false 时同样降级而不是抛错', async () => {
  const source = createPickerElementSource({
    baseUrl: 'http://127.0.0.1:3080',
    // 判别性输入：ok:false 却带着成功形状的 items——不看 ok 标志的实现会采信它
    fetchImpl: (async () => new Response(JSON.stringify({
      ok: false,
      error: '未知方法',
      items: [{ domId: 'DOM1', label: '不应被采用' }],
    }))) as typeof fetch,
  })
  const [miss] = await source.lookup(['DOM1'])
  assert.equal(miss?.id, 'DOM1')
  assert.equal(miss?.label, undefined, 'ok:false 的响应体不得被采用')
  assert.equal(miss?.degraded, true)
})

test('picker 返回非 2xx 时降级，且不采用响应体', async () => {
  const warns: string[] = []
  const source = createPickerElementSource({
    baseUrl: 'http://127.0.0.1:3080',
    // 判别性输入：HTTP 500，但响应体是成功形状——没有 !res.ok 守卫就会采信它
    fetchImpl: (async () => new Response(JSON.stringify({
      ok: true,
      items: [{ domId: 'DOM1', label: '失败响应里的数据' }],
    }), { status: 500 })) as typeof fetch,
    // 全文件唯一传 onWarn 的用例：降级告警的文案与条数在这里被固定
    onWarn: (msg) => { warns.push(msg) },
  })
  const [miss] = await source.lookup(['DOM1'])
  assert.equal(miss?.id, 'DOM1')
  assert.equal(miss?.label, undefined, '非 2xx 的响应体不得被采用')
  assert.equal(miss?.degraded, true)
  assert.deepEqual(warns, ['picker 摘要请求返回 HTTP 500，元素降级为仅编号'])
})

test('lookup 保持请求顺序', async () => {
  const source = createPickerElementSource({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: (async () => new Response(JSON.stringify({
      ok: true,
      items: [{ domId: 'DOM2', label: 'b' }, { domId: 'DOM1', label: 'a' }],
    }))) as typeof fetch,
  })
  const out = await source.lookup(['DOM1', 'DOM2'])
  assert.deepEqual(out.map((r) => r.id), ['DOM1', 'DOM2'])
})

test('lookup([]) 不发请求，直接得到空数组', async () => {
  let calls = 0
  const source = createPickerElementSource({
    baseUrl: 'http://127.0.0.1:3080',
    // 早返回一旦被删掉，这里就会被调用：抛错与计数都能观测到
    fetchImpl: (async () => {
      calls += 1
      throw new Error('lookup([]) 不得发起请求')
    }) as typeof fetch,
  })
  const out = await source.lookup([])
  assert.deepEqual(out, [])
  assert.equal(calls, 0, '空输入必须在发请求之前早返回')
})

function element(id: string, degraded = true): DraftElementRecord {
  return { id, payload: null, degraded }
}

test('registry 激活后可查，clear 后为空', () => {
  const registry = createElementRegistry()
  registry.activate([element('DOM1'), element('DOM2')], '草稿 drf_1')
  assert.equal(registry.list().length, 2)
  assert.equal(registry.find('DOM1')?.id, 'DOM1')
  registry.clear()
  assert.equal(registry.list().length, 0)
  assert.equal(registry.find('DOM1'), undefined)
})

test('registry 记录来源标签，clear 后重置为空', () => {
  const registry = createElementRegistry()
  assert.equal(registry.sourceLabel(), '', '初始来源标签为空')
  registry.activate([element('DOM1')], '草稿 drf_1')
  assert.equal(registry.sourceLabel(), '草稿 drf_1', 'activate 的第二个实参必须被记录')
  registry.activate([element('DOM9')], '草稿 drf_2')
  assert.equal(registry.sourceLabel(), '草稿 drf_2', '再次激活必须替换来源标签')
  registry.clear()
  assert.equal(registry.sourceLabel(), '', 'clear 必须同时重置来源标签')
})

test('registry 激活会替换上一批（同一时刻只有一组激活元素）', () => {
  const registry = createElementRegistry()
  registry.activate([element('DOM1')], '草稿 A')
  registry.activate([element('DOM9')], '草稿 B')
  assert.equal(registry.find('DOM1'), undefined)
  assert.deepEqual(registry.list().map((r) => r.id), ['DOM9'])
})

test('registry 按 id 去重，保留先出现的', () => {
  const registry = createElementRegistry()
  registry.activate([element('DOM1', false), element('DOM1', true)], '草稿 A')
  assert.equal(registry.list().length, 1)
  assert.equal(registry.list()[0]?.degraded, false)
})
