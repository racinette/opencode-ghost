export type PromptFormat = "chatml" | "plain"

export type Options = {
  enabled: boolean
  endpoint: string
  prompt_format: PromptFormat
  conversation_chars: number
  debounce_ms: number
  max_tokens: number
  temperature: number
  top_p: number
  request_timeout_ms: number
  stop_on_newline: boolean
  accept_key: string | false
  double_press_ms: number
  debug: boolean
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseOptions(value: unknown): Options {
  if (value !== undefined && !record(value)) throw new Error("Plugin options must be an object")
  const input = value ?? {}
  function number(name: string, fallback: number, min: number, max: number, integer = false) {
    const item = input[name] ?? fallback
    if (
      typeof item !== "number" ||
      !Number.isFinite(item) ||
      item < min ||
      item > max ||
      (integer && !Number.isInteger(item))
    )
      throw new Error(`Invalid ${name}`)
    return item
  }
  function boolean(name: string, fallback: boolean) {
    const item = input[name] ?? fallback
    if (typeof item !== "boolean") throw new Error(`Invalid ${name}`)
    return item
  }
  const endpoint = input.endpoint ?? "http://127.0.0.1:8080"
  if (typeof endpoint !== "string") throw new Error("Invalid endpoint")
  const url = new URL(endpoint)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Endpoint must be an HTTP(S) base URL without credentials, query, or fragment")
  const accept = input.accept_key ?? "right"
  if (accept !== false && (typeof accept !== "string" || !accept.trim())) throw new Error("Invalid accept_key")
  const format = input.prompt_format ?? "chatml"
  if (format !== "chatml" && format !== "plain") throw new Error("Invalid prompt_format; use chatml or plain")
  return {
    prompt_format: format,
    enabled: boolean("enabled", true),
    endpoint: url.href.replace(/\/$/, ""),
    conversation_chars: number("conversation_chars", 10_000, 0, Number.MAX_SAFE_INTEGER, true),
    debounce_ms: number("debounce_ms", 250, 0, 5000, true),
    max_tokens: number("max_tokens", 8, 1, 64, true),
    temperature: number("temperature", 0.2, 0, 2),
    top_p: number("top_p", 0.95, 0, 1),
    request_timeout_ms: number("request_timeout_ms", 2000, 1, 30000, true),
    stop_on_newline: boolean("stop_on_newline", true),
    accept_key: accept,
    double_press_ms: number("double_press_ms", 300, 50, 1000, true),
    debug: boolean("debug", false),
  }
}
