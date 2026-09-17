import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPromptSection, registerPromptInboxTools } from '../../src/host/tools.ts'
import { createElementRegistry } from '../../src/host/element-registry.ts'
import type { ElementRegistry } from '../../src/host/element-registry.ts'
import type { DraftElementRecord } from '../../src/shared/types.ts'

/**
 * 模型面（`src/host/tools.ts`）的用例。
 *
 * 前 5 条来自 Task 6 要求；其余补的是要求里写了、却没有断言能看见的行为：
 *   - 激活集为空时未命中的 `(无)` 分支；
 *   - `payloadAvailable` 是**算出来**的（写死 false 也能通过前 5 条），
 *     且 `payload` 键**缺失**时同样要判不可得（`!== null` 会在这里谎报）；
 *   - 工具对模型说的话（description/parameters/output.render）；
 *   - 提示段头部写出来源草稿（`sourceLabel()` 就是为此而加）。
 * 本插件的元素**当前恒为降级**（payload 拿不到），所以「如实回报不可得」是本
 * 文件最要紧的断言，而不是顺带一提：note 单独出现一个「摘要」字样不算说明，
 * 必须点出是谁挡住了载荷、载荷去哪了。
 */

function degraded(id: string, label?: string): DraftElementRecord {
  return { id, ...(label !== undefined ? { label } : {}), payload: null, degraded: true }
}

/** 工具声明的形状（与 `ToolsFace.register` 的入参一致，供只读断言用）。 */
interface RegisteredTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): unknown[] }
  execute(args: unknown): Promise<unknown>
}

/** 注册一次并取回工具声明：新增的用例只关心声明与 execute，不重复样板。 */
function captureTool(registry: ElementRegistry): RegisteredTool {
  let captured: RegisteredTool | undefined
  registerPromptInboxTools({
    tools: { register: (def) => { captured = def; return () => {} } },
    registry,
  })
  assert.ok(captured !== undefined, 'registerPromptInboxTools 必须调用一次 tools.register')
  return captured as unknown as RegisteredTool
}

test('激活集为空时提示段返回空串（不占上下文）', () => {
  assert.equal(buildPromptSection(createElementRegistry()), '')
})

test('提示段列出编号与标签，并说明 payload 不可得', () => {
  const registry = createElementRegistry()
  registry.activate([degraded('DOM14', '完全权限'), degraded('DOM15')], '草稿 drf_1')
  const text = buildPromptSection(registry)
  assert.match(text, /DOM14/)
  assert.match(text, /完全权限/)
  assert.match(text, /DOM15/)
  assert.match(text, /prompt_inbox_element/)
  // 用例名承诺了「说明 payload 不可得」：没有这一行，提示段悄悄去掉那句说明
  // 也照样绿——而模型会因此以为还能拿到选择器/HTML/尺寸
  assert.match(text, /只能提供编号\/标签\/来源页摘要/, '提示段必须写明当前只有摘要')
})

test('提示段头部写明这批元素来自哪条草稿', () => {
  const registry = createElementRegistry()
  registry.activate([degraded('DOM14', '完全权限')], '草稿 drf_1')
  // sourceLabel() 是 Task 3 专为这句措辞加的；不写出来源，模型无法把 [DOMn]
  // 归到某条草稿上
  assert.match(buildPromptSection(registry), /来源：草稿 drf_1/)
})

test('工具注册返回 disposer，注册名正确', () => {
  const registered: string[] = []
  const dispose = registerPromptInboxTools({
    tools: { register: (def) => { registered.push(def.name); return () => { registered.push('disposed:' + def.name) } } },
    registry: createElementRegistry(),
  })
  assert.deepEqual(registered, ['prompt_inbox_element'])
  dispose()
  assert.deepEqual(registered, ['prompt_inbox_element', 'disposed:prompt_inbox_element'])
})

test('工具命中时返回摘要并明确 payload 不可得', async () => {
  const registry = createElementRegistry()
  registry.activate([degraded('DOM14', '完全权限')], '草稿 drf_1')
  let execute: ((args: unknown) => Promise<unknown>) | undefined
  registerPromptInboxTools({
    tools: { register: (def) => { execute = def.execute; return () => {} } },
    registry,
  })
  const value = (await execute!({ id: 'DOM14' })) as { ok: boolean; id: string; label?: string; payloadAvailable: boolean; note?: string }
  assert.equal(value.ok, true)
  assert.equal(value.id, 'DOM14')
  assert.equal(value.label, '完全权限')
  assert.equal(value.payloadAvailable, false, '必须诚实报告 payload 不可得')
  // 只匹配 /不可得|摘要/ 会被一字编造的 note 骗过：这句说明的全部价值在于点出
  // 「谁挡住了载荷、载荷去哪了」，所以两处都要出现
  assert.match(String(value.note), /dsh-webpage-element-picker/, 'note 必须点出挡住载荷的来源')
  assert.match(String(value.note), /未保存/, 'note 必须说明载荷没有被保存')

  // 不得伪造字段：摘要模式下没有任何 selector/HTML/rect 可言，
  // 编一个出来比回「拿不到」更糟——模型会当它可信
  const raw = value as unknown as Record<string, unknown>
  assert.equal(raw.payload, null, '摘要模式下 payload 必须是 null，不得编造')
  for (const field of ['selector', 'html', 'rect', 'attributes']) {
    assert.equal(Object.hasOwn(raw, field), false, '不得伪造 ' + field + ' 字段')
  }
})

test('工具未命中时回可用编号清单', async () => {
  const registry = createElementRegistry()
  registry.activate([degraded('DOM1')], '草稿 drf_1')
  let execute: ((args: unknown) => Promise<unknown>) | undefined
  registerPromptInboxTools({
    tools: { register: (def) => { execute = def.execute; return () => {} } },
    registry,
  })
  const value = (await execute!({ id: 'DOM9' })) as { ok: boolean; error?: string }
  assert.equal(value.ok, false)
  assert.match(String(value.error), /DOM1/)
})

test('激活集为空时未命中，可用编号明确回 (无)', async () => {
  const tool = captureTool(createElementRegistry())
  const value = (await tool.execute({ id: 'DOM9' })) as { ok: boolean; error?: string }
  // 「未命中」不能只说未命中：没有清单，模型只能瞎猜编号
  assert.equal(value.ok, false)
  assert.match(String(value.error), /DOM9/)
  assert.match(String(value.error), /\(无\)/, '空激活集要写成 (无)，不能留空')
})

test('payload 非 null 时如实回报可得，且不附「只有摘要」的说明', async () => {
  const registry = createElementRegistry()
  // 今天每个元素都是降级的，但 payloadAvailable 必须由 payload 算出来：
  // 写死 false 会让将来真拿到 payload 时工具谎报「没有」
  registry.activate(
    [{ id: 'DOM7', label: '有载荷', pageUrl: 'http://127.0.0.1:3080/', payload: { selector: '#a' }, degraded: false }],
    '草稿 drf_2',
  )
  const tool = captureTool(registry)
  const value = (await tool.execute({ id: 'DOM7' })) as {
    ok: boolean
    pageUrl?: string
    payload?: unknown
    payloadAvailable: boolean
    note?: string
  }
  assert.equal(value.ok, true)
  assert.equal(value.payloadAvailable, true, 'payloadAvailable 必须由 payload 算出，不能硬编码 false')
  assert.deepEqual(value.payload, { selector: '#a' }, '拿得到 payload 就要原样交出去')
  assert.equal(value.pageUrl, 'http://127.0.0.1:3080/', '摘要里的来源页要透传')
  assert.equal('note' in value, false, 'payload 可得时回「只有摘要」是在反向误导模型')
})

test('payload 键缺失（不是显式 null）也判不可得，且照样附上说明', async () => {
  // 判 nullish 而不是 `!== null`：缺键时读出 undefined，`undefined !== null` 会得出
  // 「可得」，而 render 的 JSON.stringify 又把这个 undefined 字段整个丢掉——模型读到
  // `payloadAvailable: true` 却找不到任何 payload。这正是本任务要防的谎报。
  //
  // 该形状经 activate 进注册集（与真实链路一致：记录由客户端提交后载入），只在类型上
  // 跨不过去——`DraftElementRecord.payload` 是必填键（任务要求核实这一点）——所以用
  // 单点断言式的 cast 注入；运行时形状就是「对象没有 payload 键」。
  const absentPayload = {
    id: 'DOM21',
    label: '缺键元素',
    degraded: true,
  } as unknown as DraftElementRecord
  assert.equal(Object.hasOwn(absentPayload, 'payload'), false, '本用例的前提就是 payload 键不存在')
  assert.equal('payload' in absentPayload, false)

  const registry = createElementRegistry()
  registry.activate([absentPayload], '草稿 drf_3')
  assert.equal(registry.find('DOM21'), absentPayload, '缺键记录必须原样进激活集（工具经注册集取到它）')

  const tool = captureTool(registry)
  const value = (await tool.execute({ id: 'DOM21' })) as { ok: boolean; payloadAvailable: boolean; note?: string }
  assert.equal(value.ok, true)
  assert.equal(value.payloadAvailable, false, 'payload 键缺失必须判不可得，不得因 undefined !== null 谎报可得')
  assert.match(String(value.note), /dsh-webpage-element-picker/, '回报不可得时必须点出挡住载荷的来源')
  assert.match(String(value.note), /未保存/, '回报不可得时必须说明载荷没有被保存')
  // 走到模型眼前的形态：render 的 JSON.stringify 会丢掉 undefined 字段，
  // 所以「回一个 undefined 冒充 payload」是看不见的——只能靠上面的 note 解释缺了什么
  const rendered = tool.output.render({ id: 'DOM21' }, value) as Array<{ text: string }>
  assert.equal('payload' in (JSON.parse(rendered[0]!.text) as Record<string, unknown>), false)
})

test('工具声明对模型诚实：描述说明只有摘要，参数要 string id，render 出 JSON 文本', () => {
  const tool = captureTool(createElementRegistry())
  assert.equal(tool.name, 'prompt_inbox_element')
  // description 是模型决定「要不要调、能期待什么」的唯一依据：不写明只有摘要，
  // 模型会以为调用后能拿到选择器/HTML
  assert.match(tool.description, /摘要/)
  assert.match(tool.description, /未保存|不可得/)
  assert.match(tool.description, /DOM14/)

  const parameters = tool.parameters as {
    type?: string
    properties?: Record<string, { type?: string }>
    required?: string[]
  }
  assert.equal(parameters.type, 'object')
  assert.equal(parameters.properties?.id?.type, 'string')
  assert.deepEqual(parameters.required, ['id'])

  // 输出不设约束（命中与未命中形状不同），render 把结构化值原样铺成 JSON 文本
  assert.deepEqual(tool.output.schema, {})
  assert.deepEqual(tool.output.render({ id: 'DOM1' }, { ok: false, error: 'x' }), [
    { type: 'text', text: JSON.stringify({ ok: false, error: 'x' }, null, 2) },
  ])
})
