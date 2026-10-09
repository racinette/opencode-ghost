import { chatml, completionPrompt } from "./context"
import { record, type Options } from "./options"

export function createModelClient(options: Options) {
  return async (prompt: string, signal: AbortSignal, context = ""): Promise<string> => {
    signal.throwIfAborted()
    const boundaries =
      options.backend !== "openai-chat" && options.prompt_format === "chatml"
        ? [chatml.start, chatml.end, chatml.eot]
        : []
    const stop = [...boundaries, ...(options.stop_on_newline ? ["\n"] : [])]
    const headers = new Headers(options.headers)
    for (const [name, variable] of Object.entries(options.headers_env)) {
      const value = process.env[variable]
      if (!value) throw new Error(`Missing environment variable for header ${name}`)
      headers.set(name, value)
    }
    if (options.api_key_env) {
      const key = process.env[options.api_key_env]
      if (!key) throw new Error("Missing API key environment variable")
      headers.set("Authorization", `Bearer ${key}`)
    }
    headers.set("Content-Type", "application/json")
    const common = {
      temperature: options.temperature,
      top_p: options.top_p,
      stream: false,
      ...(stop.length ? { stop } : {}),
    }
    const chat = options.backend === "openai-chat"
    const path = options.backend === "llamacpp" ? "/completion" : chat ? "/chat/completions" : "/completions"
    const body =
      options.backend === "llamacpp"
        ? {
            ...common,
            prompt: completionPrompt(context, prompt, options.prompt_format),
            n_predict: options.max_tokens,
            cache_prompt: true,
          }
        : chat
          ? {
              ...common,
              model: options.model,
              max_tokens: options.max_tokens,
              messages: [
                {
                  role: "system",
                  content:
                    "Continue the user's unfinished draft. Return only the text to append, including any needed leading whitespace. Do not repeat the draft, answer it, explain, or wrap the continuation in quotes. Earlier messages provide context only.",
                },
                ...(context ? JSON.parse(context) : []),
                { role: "user", content: prompt },
              ],
            }
          : {
              ...common,
              model: options.model,
              max_tokens: options.max_tokens,
              prompt: completionPrompt(context, prompt, options.prompt_format),
            }
    const response = await fetch(`${options.endpoint}${path}`, {
      method: "POST",
      headers,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.request_timeout_ms)]),
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`Model server returned HTTP ${response.status}`)
    const data: unknown = await response.json()
    if (!record(data)) throw new Error("Invalid completion response")
    let content: unknown = data.content
    if (options.backend !== "llamacpp") {
      const choice: unknown = Array.isArray(data.choices) ? data.choices[0] : undefined
      content = record(choice) ? (chat && record(choice.message) ? choice.message.content : choice.text) : undefined
    }
    if (typeof content !== "string") throw new Error("Invalid completion response")
    if (data.truncated === true) return ""
    // The endpoint returns a suffix, not the prompt.
    const text = boundaries.reduce((text, boundary) => text.split(boundary, 1)[0]!, content)
    let suffix = options.stop_on_newline ? text.split(/[\r\n]/, 1)[0]! : text
    // A draft's existing word separator is enough. Keep indentation on blank
    // lines and leading spaces when the draft still needs a word separator.
    const lastLine = prompt.slice(prompt.lastIndexOf("\n") + 1)
    if (prompt.endsWith(" ") && /\S/.test(lastLine)) suffix = suffix.replace(/^ +/, "")
    if (!suffix.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(suffix)) return ""
    return suffix
  }
}
