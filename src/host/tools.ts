/**
 * 模型面：`prompt_inbox_element` 工具 + 元素快照提示上下文段。
 *
 * 两件事读的是**同一个元素激活集**（`ElementRegistry`）：回弹某条草稿时，
 * `/invoke` 的 `draft-get` 把该草稿的元素快照载入激活集，提示段随后列出
 * 「编号 = 标签」，模型想知道某个编号究竟是什么就调工具按编号查。
 *
 * **能力边界（必须如实转述给模型，见 spec §3.4）**：`dsh-webpage-element-picker`
 * 只把元素的完整载荷（HTML、CSS 选择器、DOM 路径、属性、位置尺寸）留在它自己的
 * host 进程内存里，其 `/invoke` 面没有任何方法能把载荷交出来——唯一可按编号查询
 * 的方法只回 `{ domId, label, pageUrl }`。所以本插件存下的每条元素记录当前都是
 * `payload: null` + `degraded: true`，工具如实回报 `payloadAvailable: false`
 * 并附一句中文说明，**绝不编造** selector/HTML/rect 字段：一个被编出来的选择器
 * 比「拿不到」危险得多，模型会当它可信。
 *
 * 本文件是纯逻辑：不引 npm 运行时依赖，也不自己打日志。降级在这里是**对模型
 * 说的话**（走返回值），不是运维事件——今天每个元素都降级，对它打 WARN 只会
 * 把正常路径变成噪音。
 */

import type { ElementRegistry } from './element-registry.ts'
import type { ToolsFace } from './services.ts'

/** 工具名：提示段里按这个名字给模型指路，两处必须一致。 */
export const PROMPT_INBOX_TOOL_NAME = 'prompt_inbox_element'

/** 提示上下文段名：同一次组装内重名会在注册时抛错，所以只在这里定义一次。 */
export const PROMPT_INBOX_SECTION_NAME = 'prompt-inbox'

/**
 * 摘录取不到完整载荷时固定附给模型的说明。
 * 原文照抄 spec §3.4：它回答了「为什么只有摘要」，是这条能力边界唯一的解释。
 */
const SUMMARY_ONLY_NOTE =
  '当前只能提供摘要：完整 payload 被 dsh-webpage-element-picker 的插件边界挡住，未保存。'

/** 记录没有标签时的占位：留空会像一个「空标签」，写清楚反而省一轮追问。 */
const NO_LABEL = '（无标签）'

/**
 * 组装一段「这批 [DOMn] 是什么」的提示上下文。
 *
 * 返回空串是常态：没有激活元素时（绝大多数会话）不花一个上下文 token——
 * 组装侧会丢弃渲染为空的上下文条目（见 dsh-system-prompt 的
 * renderContextSections）；有元素时才列出编号与标签。
 *
 * 这里只说「能拿到什么」，不说「拿到的是什么」：细节归工具，一次调用一次查询。
 *
 * @param registry - 元素激活集（回弹草稿时载入，输入框清空时清空）。
 * @returns 多行提示文本；激活集为空时是 `''`。
 */
export function buildPromptSection(registry: ElementRegistry): string {
  const records = registry.list()
  if (records.length === 0) return ''

  const source = registry.sourceLabel()
  return [
    '草稿元素快照（用户消息中的 [DOMn] 与下列编号一一对应'
      + (source === '' ? '' : '，来源：' + source)
      + '）：',
    ...records.map(record => record.id + '=' + (record.label ? record.label : NO_LABEL)),
    '需要元素信息时调用 ' + PROMPT_INBOX_TOOL_NAME + ' 工具；当前只能提供编号/标签/来源页摘要。',
  ].join('\n')
}

/**
 * 注册 `prompt_inbox_element` 工具。
 *
 * 每次调用都**现查**激活集，而不是注册时拷一份快照：工具在插件激活时就注册好，
 * 而元素要等用户回弹草稿才出现，两者顺序不固定。
 *
 * @param options.tools - harness 工具注册表（`ctx.tools`）。
 * @param options.registry - 元素激活集。
 * @returns 撤销注册的清理器：直接作为 `ctx.effect` 的回调返回值，卸载时工具随之消失。
 */
export function registerPromptInboxTools(options: {
  tools: ToolsFace
  registry: ElementRegistry
}): () => void {
  const { tools, registry } = options

  return tools.register({
    name: PROMPT_INBOX_TOOL_NAME,
    // description 是模型判断「要不要调、能期待什么」的唯一依据，所以边界写在这里，
    // 而不是只写在返回值里：模型在调之前就该知道拿不到选择器/HTML/尺寸
    description: '按编号（形如 DOM14）读取草稿元素快照的摘要：编号、标签、来源页 URL。'
      + '当前只能返回摘要——完整 payload（HTML / CSS 选择器 / 属性 / 位置尺寸）被 '
      + 'dsh-webpage-element-picker 的插件边界挡住，未保存；返回值里的 payloadAvailable '
      + '会如实说明这一点，不要据此推断元素细节。',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '元素编号，形如 DOM14（见系统提示里的草稿元素快照）',
        },
      },
      required: ['id'],
    },
    output: {
      // 命中与未命中的形状不同，所以输出不设约束：harness 只接受受支持的 JSON Schema
      // 子集，而「注解式空 schema」正是它规定的「任意 JSON」写法
      schema: {},
      // 结构化值原样铺成 JSON 文本，模型读到的就是上面那些字段，中间不做二次加工
      render: (_args: unknown, value: unknown) => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args: unknown): Promise<unknown> => {
      const raw = (args as { id?: unknown } | null | undefined)?.id
      const id = typeof raw === 'string' ? raw.trim() : ''
      const record = registry.find(id)

      if (record === undefined) {
        // 未命中不是异常，而是「你记错了编号」：回一份可用编号清单，模型能自己
        // 改对再试。空集要写成 (无)，不能留一个空清单让模型以为工具坏了
        const available = registry.list().map(item => item.id)
        return {
          ok: false,
          error: '未找到元素 ' + (id === '' ? '(空)' : id)
            + '，可用编号: ' + (available.length > 0 ? available.join(', ') : '(无)'),
        }
      }

      const payload = record.payload
      // 判 nullish 而不是 `!== null`：记录里的 `payload` 键**缺失**时读出 undefined，
      // `undefined !== null` 会得出「可得」，而 render 的 JSON.stringify 又会把这个
      // undefined 字段整个丢掉——模型于是读到 `payloadAvailable: true` 却找不到 payload，
      // 正是本任务要防的那种谎报。（今天 element-source 恒写 payload: null，走不到；
      // 但它的文件头明说了将来可能换来源，所以这里必须按缺键也成立来写。）
      const payloadAvailable = payload != null
      return {
        ok: true,
        id: record.id,
        // 缺字段就不出现，而不是回一个 undefined/空串冒充「查到了」
        ...(record.label === undefined ? {} : { label: record.label }),
        ...(record.pageUrl === undefined ? {} : { pageUrl: record.pageUrl }),
        payload,
        // 由 payload 算出来，不写死：将来来源真能交出载荷时，工具不能谎报「没有」
        payloadAvailable,
        // 说明只在真拿不到时附上：payload 可得还回「只有摘要」是在反向误导
        ...(payloadAvailable ? {} : { note: SUMMARY_ONLY_NOTE }),
      }
    },
  })
}
