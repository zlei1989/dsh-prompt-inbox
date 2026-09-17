/**
 * Host 侧服务契约——本插件从 harness host 消费的精确 API 表面。
 *
 * 仅类型：实现由用户的 harness 提供（`@deepseek-ai/dsh-base` 等组合包）。
 * 插件在模块级 `inject` 里声明这些服务名，Cordis 会把插件纤程挂起，
 * 直到每个 provider 激活为止。在此把用到的字段窄化下来，是为了让
 * `src/host/` 不依赖任何 npm 运行时依赖（见 AGENT.md 约束）。
 */

/** harness web 服务器上的一条 HTTP 路由注册（`ctx.webServer`）。 */
export interface WebRouteLike {
  kind: 'exact' | 'prefix'
  /** 绝对路径，无尾斜杠。 */
  path: string
  /** 该处理器独占整个响应生命周期。 */
  handler(req: WebRequestLike, res: WebResponseLike): void | Promise<void>
}

/** 交给路由处理器的 Node 风格请求对象（只声明用到的字段与事件）。 */
export interface WebRequestLike {
  /** HTTP 方法：`/invoke` 只收 POST、`/asset` 只收 GET。 */
  method?: string
  /** 原始请求行目标（`/path?query`）；`/asset` 的 ref 从 query 里取。 */
  url?: string
  on(event: 'data', cb: (chunk: unknown) => void): void
  on(event: 'end' | 'close', cb: () => void): void
}

/**
 * 交给路由处理器的 Node 风格响应对象。
 * 插件只依赖这两个方法；客户端提前断开时 `writeHead`/`end` 可能抛错，
 * 调用方需自行兜住（见 routes.ts 的 respond / respondJson）。
 * `end` 接受字节是因为 `/asset` 要直接回附件内容（Node 的 `res.end` 亦然）。
 */
export interface WebResponseLike {
  writeHead(status: number, headers: Record<string, string>): void
  end(body: string | Uint8Array): void
}

/** harness web 服务器（`ctx.webServer`）。 */
export interface WebServerFace {
  register(route: WebRouteLike): () => void
  /** 监听端口（配置为 0 时是系统分配的实际端口）；元素来源用它拼同源 URL。 */
  port: number
}

/** 工具注册表（`ctx.tools`）。 */
export interface ToolsFace {
  register(tool: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      schema: Record<string, unknown>
      render(args: unknown, value: unknown): unknown[]
    }
    execute(args: unknown): Promise<unknown>
  }): () => void
}

/** 系统提示服务（`ctx.systemPrompt`）。 */
export interface SystemPromptFace {
  /**
   * 注册动态上下文段：每次组装提示都会回调 `text()` 取最新内容。
   * `order` 是普通整数；同一次组装内重名会在注册时抛错。
   */
  context(decl: { name: string; order: number; text: () => string }): () => void
}
