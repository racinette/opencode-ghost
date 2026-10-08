import type { Message, Part } from "@opencode-ai/sdk/v2"
import type { PromptFormat } from "./options"

export const chatml = { start: "<|im_start|>", end: "<|im_end|>", eot: "<|endoftext|>" }

type ConversationState = {
  session: {
    messages(sessionID: string): ReadonlyArray<Pick<Message, "id" | "sessionID" | "role">>
    get(sessionID: string): { revert?: { messageID: string } } | undefined
  }
  part(messageID: string): ReadonlyArray<Part>
}

function turn(role: "user" | "assistant", text: string, format: PromptFormat) {
  return format === "chatml"
    ? `${chatml.start}${role}\n${text}${chatml.end}`
    : `${role === "user" ? "User" : "Assistant"}: ${text}`
}

export function completionPrompt(context: string, draft: string, format: PromptFormat) {
  if (format === "chatml") return `${context ? context + "\n" : ""}${chatml.start}user\n${draft}`
  return context ? `${context}\n\nUser: ${draft}` : draft
}

/** The active session's conversation tail, with complete native role boundaries. */
export function conversationTail(
  state: ConversationState,
  sessionID: string | undefined,
  characters: number,
  format: PromptFormat = "chatml",
) {
  if (!sessionID || characters === 0) return ""
  const messages = state.session.messages(sessionID)
  const revert = state.session.get(sessionID)?.revert?.messageID
  const index = revert ? messages.findIndex((message) => message.id === revert) : -1
  const turns = (index === -1 ? messages : messages.slice(0, index))
    .filter((message) => message.sessionID === sessionID)
    .flatMap((message) => {
      const text = state
        .part(message.id)
        .filter((part) => part.sessionID === sessionID && part.type === "text" && !part.synthetic && !part.ignored)
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
      return text.trim() ? [{ role: message.role, text }] : []
    })
  if (format === "plain") {
    return Array.from(turns.map((item) => turn(item.role, item.text, format)).join("\n\n"))
      .slice(-characters)
      .join("")
  }
  const retained: string[] = []
  let remaining = characters
  for (const item of turns.toReversed()) {
    // Keep the newest text, reserving room for its full header, closing token,
    // and separator. A cutoff trims only the oldest retained message's body.
    const framing = turn(item.role, "", format).length + (retained.length ? 1 : 0)
    if (remaining <= framing) break
    const text = Array.from(item.text)
    const tail = text.slice(-Math.min(text.length, remaining - framing))
    retained.unshift(turn(item.role, tail.join(""), format))
    remaining -= framing + tail.length
    if (tail.length < text.length) break
  }
  return retained.join("\n")
}
