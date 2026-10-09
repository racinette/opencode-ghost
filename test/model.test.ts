import { expect, test } from "bun:test"
import { createModelClient } from "../src/model"
import { parseOptions } from "../src/options"

test("sends an open native user turn and preserves suffix spaces", async () => {
  let body: unknown
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      expect(new URL(req.url).pathname).toBe("/completion")
      body = await req.json()
      return Response.json({ content: " next word\nsecond line", truncated: false })
    },
  })
  try {
    const predict = createModelClient(parseOptions({ endpoint: server.url.origin }))
    expect(await predict("current draft", new AbortController().signal)).toBe(" next word")
    expect(body).toEqual({
      prompt: "<|im_start|>user\ncurrent draft",
      n_predict: 8,
      temperature: 0.2,
      top_p: 0.95,
      stream: false,
      cache_prompt: true,
      stop: ["<|im_start|>", "<|im_end|>", "<|endoftext|>", "\n"],
    })
  } finally {
    server.stop(true)
  }
})

test.each([{ content: "  " }, { content: "\u001b[31m" }, { content: " suffix", truncated: true }])(
  "rejects unusable completion %j",
  async (body) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(body) })
    try {
      expect(
        await createModelClient(parseOptions({ endpoint: server.url.origin }))("draft", new AbortController().signal),
      ).toBe("")
    } finally {
      server.stop(true)
    }
  },
)

test("timeouts and HTTP failure reject without altering input", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await Bun.sleep(60)
      return new Response("error", { status: 503 })
    },
  })
  try {
    await expect(
      createModelClient(parseOptions({ endpoint: server.url.origin, request_timeout_ms: 10 }))(
        "draft",
        new AbortController().signal,
      ),
    ).rejects.toThrow()
    await expect(
      createModelClient(parseOptions({ endpoint: server.url.origin }))("draft", new AbortController().signal),
    ).rejects.toThrow("HTTP 503")
  } finally {
    server.stop(true)
  }
})

test("configuration defaults and validation", () => {
  expect(parseOptions(undefined).accept_key).toBe("right")
  expect(parseOptions({ endpoint: "http://localhost:8080/", accept_key: false }).endpoint).toBe("http://localhost:8080")
  for (const options of [
    { max_tokens: 0 },
    { endpoint: "file:///tmp/model" },
    { endpoint: "http://user:pass@localhost" },
    { debounce_ms: -1 },
    { double_press_ms: "300" },
  ])
    expect(() => parseOptions(options)).toThrow()
})

test("plain fallback prepends history and leaves the current user draft unfinished", async () => {
  let prompt: unknown
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json()
      prompt = body.prompt
      return Response.json({ content: " invalid settings" })
    },
  })
  try {
    const predict = createModelClient(parseOptions({ endpoint: server.url.origin, prompt_format: "plain" }))
    expect(
      await predict("Add tests for", new AbortController().signal, "User: Add validation.\n\nAssistant: Done."),
    ).toBe(" invalid settings")
    expect(prompt).toBe("User: Add validation.\n\nAssistant: Done.\n\nUser: Add tests for")
  } finally {
    server.stop(true)
  }
})

test("conversation cutoff is configurable, including zero and 50k", () => {
  expect(parseOptions(undefined).conversation_chars).toBe(10_000)
  expect(parseOptions({ conversation_chars: 50_000 }).conversation_chars).toBe(50_000)
  expect(parseOptions({ conversation_chars: 0 }).conversation_chars).toBe(0)
  expect(() => parseOptions({ conversation_chars: -1 })).toThrow()
  expect(() => parseOptions({ conversation_chars: 1.5 })).toThrow()
})

test("native history ends in an open current user turn rather than an assistant answer", async () => {
  let prompt: unknown
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      prompt = (await request.json()).prompt
      return Response.json({ content: " invalid settings" })
    },
  })
  try {
    const context = "<|im_start|>user\nAdd validation.<|im_end|>\n<|im_start|>assistant\nDone.<|im_end|>"
    const draft = "Add tests for"
    const predict = createModelClient(parseOptions({ endpoint: server.url.origin }))
    expect(await predict(draft, new AbortController().signal, context)).toBe(" invalid settings")
    expect(prompt).toBe(context + "\n<|im_start|>user\n" + draft)
  } finally {
    server.stop(true)
  }
})

test.each(["<|im_start|>", "<|im_end|>", "<|endoftext|>"])(
  "native %s never appears in ghost text even if a server ignores stops",
  async (boundary) => {
    let stops: unknown
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        stops = (await request.json()).stop
        return Response.json({ content: " suffix\nsecond line" + boundary + "assistant\nAnother turn" })
      },
    })
    try {
      const predict = createModelClient(parseOptions({ endpoint: server.url.origin, stop_on_newline: false }))
      expect(await predict("draft", new AbortController().signal)).toBe(" suffix\nsecond line")
      expect(stops).toEqual(["<|im_start|>", "<|im_end|>", "<|endoftext|>"])
    } finally {
      server.stop(true)
    }
  },
)

test("plain fallback retains the original raw draft format when there is no history", async () => {
  let prompt: unknown
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      prompt = (await request.json()).prompt
      return Response.json({ content: " continuation" })
    },
  })
  try {
    await createModelClient(parseOptions({ endpoint: server.url.origin, prompt_format: "plain" }))(
      "raw draft",
      new AbortController().signal,
    )
    expect(prompt).toBe("raw draft")
  } finally {
    server.stop(true)
  }
})

test("native role tokens are the default and prompt_format is validated", () => {
  expect(parseOptions(undefined).prompt_format).toBe("chatml")
  expect(parseOptions({ prompt_format: "plain" }).prompt_format).toBe("plain")
  expect(() => parseOptions({ prompt_format: "invalid" })).toThrow("Invalid prompt_format")
})

test.each([
  { draft: "Hello", content: " world", expected: " world" },
  { draft: "Hello ", content: " world", expected: "world" },
  { draft: "Hello  ", content: "  world", expected: "world" },
  { draft: "Hello ", content: "world", expected: "world" },
  { draft: "Hello ", content: " world ", expected: "world " },
  { draft: "walk", content: "ing", expected: "ing" },
  { draft: "Code:\n  ", content: "  return value", expected: "  return value" },
  { draft: "Code:\n", content: "  return value", expected: "  return value" },
  { draft: "Hello ", content: "\n  next line", expected: "\n  next line" },
])("normalizes word separators without changing the draft or indentation: %j", async ({ draft, content, expected }) => {
  let sentPrompt: unknown
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      sentPrompt = (await request.json()).prompt
      return Response.json({ content })
    },
  })
  try {
    const predict = createModelClient(parseOptions({ endpoint: server.url.origin, stop_on_newline: false }))
    expect(await predict(draft, new AbortController().signal)).toBe(expected)
    expect(sentPrompt).toBe("<|im_start|>user\n" + draft)
  } finally {
    server.stop(true)
  }
})

test.each(["openai-completion", "openai-chat"])("%s sends model, auth, context and decodes suffix", async (backend) => {
  const variable = "GHOST_TEST_PROVIDER_KEY"
  process.env[variable] = "test-token"
  let received: any
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe(backend === "openai-chat" ? "/v1/chat/completions" : "/v1/completions")
      expect(request.headers.get("authorization")).toBe("Bearer test-token")
      expect(request.headers.get("x-api-key")).toBe("test-token")
      expect(request.headers.get("x-project")).toBe("example")
      received = await request.json()
      return Response.json({
        choices: [backend === "openai-chat" ? { message: { content: " suffix" } } : { text: " suffix" }],
      })
    },
  })
  try {
    const predict = createModelClient(
      parseOptions({
        backend,
        endpoint: server.url.origin + "/v1/",
        model: "example",
        api_key_env: variable,
        headers: { "x-project": "example" },
        headers_env: { "x-api-key": variable },
      }),
    )
    const context =
      backend === "openai-chat"
        ? JSON.stringify([{ role: "assistant", content: "Earlier response" }])
        : "Earlier response"
    expect(await predict("draft", new AbortController().signal, context)).toBe(" suffix")
    expect(received.model).toBe("example")
    expect(received.max_tokens).toBe(8)
    expect(received.n_predict).toBeUndefined()
    if (backend === "openai-chat") {
      expect(received.messages.slice(1)).toEqual([
        { role: "assistant", content: "Earlier response" },
        { role: "user", content: "draft" },
      ])
      expect(received.messages[0].content).toContain("Return only the text to append")
      expect(received.prompt).toBeUndefined()
    } else expect(received.prompt).toContain("draft")
  } finally {
    server.stop(true)
    delete process.env[variable]
  }
})

test("provider configuration rejects unsupported backends, missing models and invalid headers", () => {
  for (const options of [
    { backend: "unknown" },
    { backend: "openai-chat" },
    { backend: "openai-completion", model: "" },
    { headers: { authorization: 12 } },
    { headers_env: { "bad header": "KEY" } },
  ])
    expect(() => parseOptions(options)).toThrow()
})

test("missing authentication fails before sending a request", async () => {
  const predict = createModelClient(parseOptions({ api_key_env: "GHOST_TEST_MISSING_KEY" }))
  await expect(predict("draft", new AbortController().signal)).rejects.toThrow("Missing API key")
})

test.each([{ choices: [] }, { choices: [{ message: { content: null } }] }, { choices: [{ text: 3 }] }])(
  "malformed compatible responses fail safely: %j",
  async (response) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(response) })
    try {
      await expect(
        createModelClient(parseOptions({ backend: "openai-chat", model: "example", endpoint: server.url.origin }))(
          "draft",
          new AbortController().signal,
        ),
      ).rejects.toThrow("Invalid completion response")
    } finally {
      server.stop(true)
    }
  },
)
