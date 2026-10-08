import { expect, test } from "bun:test"
import type { Part, TextPart } from "@opencode-ai/sdk/v2"
import { createMemo, createRoot, createSignal } from "solid-js"
import { conversationTail } from "../src/context"

function text(messageID: string, value: string, extra: Partial<TextPart> = {}): TextPart {
  return { id: messageID + "-part", sessionID: "active", messageID, type: "text", text: value, ...extra }
}
function fixture() {
  const messages = [
    { id: "one", sessionID: "active", role: "user" as const },
    { id: "two", sessionID: "active", role: "assistant" as const },
  ]
  const parts: Record<string, Part[]> = {
    one: [text("one", "Add validation.")],
    two: [text("two", "Validation is implemented.")],
  }
  return {
    messages,
    parts,
    state: {
      session: { messages: () => messages, get: () => ({}) },
      part: (id: string) => parts[id] ?? [],
    },
  }
}

test("serializes user and assistant text, then keeps exactly the last N characters", () => {
  const f = fixture()
  expect(conversationTail(f.state, "active", 10_000, "plain")).toBe(
    "User: Add validation.\n\nAssistant: Validation is implemented.",
  )
  expect(conversationTail(f.state, "active", 15, "plain")).toBe("is implemented.")
})

test("the cutoff may start inside a message without splitting Unicode characters", () => {
  const f = fixture()
  f.parts.two = [text("two", "Prefix 🙂中é")]
  expect(conversationTail(f.state, "active", 3, "plain")).toBe("🙂中é")
})

test("no session or disabled context uses no conversation state", () => {
  const unavailable = {
    session: {
      messages() {
        throw new Error("unavailable")
      },
      get() {
        throw new Error("unavailable")
      },
    },
    part() {
      throw new Error("unavailable")
    },
  }
  expect(conversationTail(unavailable, undefined, 10_000, "plain")).toBe("")
  expect(conversationTail(unavailable, "active", 0, "plain")).toBe("")
})

test("excludes ignored, synthetic, reasoning, tool output, and another session", () => {
  const f = fixture()
  f.parts.two = [
    text("two", "ignored", { ignored: true }),
    text("two", "synthetic", { synthetic: true }),
    { id: "thought", sessionID: "active", messageID: "two", type: "reasoning", text: "reasoning", time: { start: 0 } },
    {
      id: "tool",
      sessionID: "active",
      messageID: "two",
      type: "tool",
      callID: "call",
      tool: "bash",
      state: {
        status: "completed",
        input: {},
        output: "tool output",
        title: "command",
        metadata: {},
        time: { start: 0, end: 1 },
      },
    },
    text("two", "other-session part", { sessionID: "other" }),
    text("two", "actual response"),
  ]
  f.messages.push({ id: "foreign", sessionID: "other", role: "user" })
  f.parts.foreign = [text("foreign", "other conversation", { sessionID: "other" })]
  expect(conversationTail(f.state, "active", 10_000, "plain")).toBe(
    "User: Add validation.\n\nAssistant: actual response",
  )
})

test("reverted messages are omitted using the same timeline cutoff as OpenCode", () => {
  const f = fixture()
  const state = { ...f.state, session: { ...f.state.session, get: () => ({ revert: { messageID: "two" } }) } }
  expect(conversationTail(state, "active", 10_000, "plain")).toBe("User: Add validation.")
})

test("reactive conversation text updates the memo but an unchanged retained tail stays stable", () => {
  createRoot((dispose) => {
    try {
      const f = fixture()
      const [response, setResponse] = createSignal("First response")
      const state = { ...f.state, part: (id: string) => (id === "two" ? [text(id, response())] : f.state.part(id)) }
      const tail = createMemo(() => conversationTail(state, "active", 8, "plain"))
      expect(tail()).toBe("response")
      setResponse("Changed response")
      expect(tail()).toBe("response")
      setResponse("Final result")
      expect(tail()).toBe("l result")
    } finally {
      dispose()
    }
  })
})

test("defaults to complete native user and assistant turns", () => {
  const f = fixture()
  expect(conversationTail(f.state, "active", 10_000)).toBe(
    "<|im_start|>user\nAdd validation.<|im_end|>\n<|im_start|>assistant\nValidation is implemented.<|im_end|>",
  )
})

test("native cutoff retains the newest Unicode text with a full role header and closing token", () => {
  const f = fixture()
  f.parts.two = [text("two", "Prefix 🙂中é")]
  const frame = "<|im_start|>assistant\n<|im_end|>"
  const tail = conversationTail(f.state, "active", frame.length + 3)
  expect(tail).toBe("<|im_start|>assistant\n🙂中é<|im_end|>")
  expect(Array.from(tail).length).toBe(frame.length + 3)
  expect(conversationTail(f.state, "active", frame.length)).toBe("")
})

test("all native cutoff positions keep role-token boundaries intact and stay within the character cap", () => {
  const f = fixture()
  const full = conversationTail(f.state, "active", 10_000)
  for (let cap = 1; cap <= full.length + 1; cap++) {
    const tail = conversationTail(f.state, "active", cap)
    expect(Array.from(tail).length).toBeLessThanOrEqual(cap)
    expect(tail === "" || /^(?:<\|im_start\|>(?:user|assistant)\n[^<]*<\|im_end\|>\n?)+$/.test(tail)).toBe(true)
  }
})
