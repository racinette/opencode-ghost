import { chatml, completionPrompt } from "./context"
import { record, type Options } from "./options"

export function createModelClient(options: Options) {
  return async (prompt: string, signal: AbortSignal, context = ""): Promise<string> => {
    signal.throwIfAborted()
    const boundaries = options.prompt_format === "chatml" ? [chatml.start, chatml.end, chatml.eot] : []
    const stop = [...boundaries, ...(options.stop_on_newline ? ["\n"] : [])]
    const response = await fetch(`${options.endpoint}/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.request_timeout_ms)]),
      body: JSON.stringify({
        prompt: completionPrompt(context, prompt, options.prompt_format),
        n_predict: options.max_tokens,
        temperature: options.temperature,
        top_p: options.top_p,
        stream: false,
        cache_prompt: true,
        ...(stop.length ? { stop } : {}),
      }),
    })
    if (!response.ok) throw new Error(`Model server returned HTTP ${response.status}`)
    const data: unknown = await response.json()
    if (!record(data) || typeof data.content !== "string") throw new Error("Invalid raw completion response")
    if (data.truncated === true) return ""
    // Preserve leading spaces. The endpoint already returns a suffix, not the prompt.
    const text = boundaries.reduce((text, boundary) => text.split(boundary, 1)[0]!, data.content)
    const suffix = options.stop_on_newline ? text.split(/[\r\n]/, 1)[0]! : text
    if (!suffix.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(suffix)) return ""
    return suffix
  }
}
