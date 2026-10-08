import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { registerManagedTextareaLayer } from "@opentui/keymap/addons/opentui"
import { appendSuffix, atEnd } from "../src/acceptance"
import { PromptController, type GhostPromptRef } from "../src/adapter"
import { parseOptions } from "../src/options"

async function fixture(
  options: Record<string, unknown> = {},
  suffix: string | ((calls: number) => string) = " world and more",
  readContext: () => string = () => "",
) {
  const app = await createTestRenderer({ width: 60, height: 10, useThread: false })
  const editor = new TextareaRenderable(app.renderer, { width: 60, height: 4 })
  app.renderer.root.add(editor)
  editor.setText("hello")
  editor.gotoBufferEnd()
  const traits = { owner: "opencode", role: "prompt", capture: ["tab"] as const }
  editor.traits = traits
  editor.focus()
  const keymap = createDefaultOpenTuiKeymap(app.renderer)
  const managed = registerManagedTextareaLayer(keymap, app.renderer, {})
  const field = keymap.registerLayerFields({
    "ghost.acceptable": (value, ctx) => ctx.activeWhen(() => typeof value === "function" && value()),
  })
  keymap.setData("opencode.mode", "base")
  let ghost = ""
  let predictions = 0
  const contexts: string[] = []
  const ref: GhostPromptRef = {
    get focused() {
      return editor.focused
    },
    get current() {
      return { input: editor.plainText, parts: [] }
    },
    get ghost() {
      return ghost
    },
    setGhost(text) {
      ghost = text
    },
    set(prompt) {
      editor.setText(prompt.input)
    },
    reset() {
      editor.setText("")
    },
    blur() {
      editor.blur()
    },
    focus() {
      editor.focus()
    },
    submit() {},
  }
  const props = { sessionID: "one", visible: true, disabled: false }
  const dialog = { open: false }
  const controller = new PromptController(
    { renderer: app.renderer, keymap, ui: { dialog } },
    ref,
    () => props,
    parseOptions({ debounce_ms: 0, ...options }),
    async (_input, _signal, context) => {
      contexts.push(context)
      predictions++
      return typeof suffix === "function" ? suffix(predictions) : suffix
    },
    undefined,
    readContext,
  )
  await Bun.sleep(30)
  await app.flush()
  return {
    app,
    editor,
    keymap,
    props,
    dialog,
    ref,
    controller,
    predictions: () => predictions,
    contexts,
    close() {
      controller.dispose()
      field()
      managed()
      app.renderer.destroy()
    },
  }
}

test("real managed Right Arrow navigates inside input, then accepts a word and the remainder", async () => {
  const f = await fixture()
  try {
    expect(f.ref.ghost).toBe(" world and more")
    f.editor.cursorOffset = 1
    f.app.mockInput.pressKey("ARROW_RIGHT")
    expect(f.editor.cursorOffset).toBe(2)
    expect(f.editor.plainText).toBe("hello")
    f.editor.gotoBufferEnd()
    f.app.mockInput.pressKey("ARROW_RIGHT")
    expect(f.editor.plainText).toBe("hello world")
    expect(f.ref.ghost).toBe(" and more")
    await Bun.sleep(20)
    expect(f.ref.ghost).toBe(" and more")
    f.app.mockInput.pressKey("ARROW_RIGHT")
    expect(f.editor.plainText).toBe("hello world and more")
    expect(f.ref.ghost).toBe("")
    expect(atEnd(f.editor)).toBe(true)
    await Bun.sleep(20)
    expect(f.ref.ghost).toBe(" world and more")
    expect(f.predictions()).toBe(2)
    f.editor.undo()
    expect(f.editor.plainText).not.toBe("hello world and more")
  } finally {
    f.close()
  }
})

test("two synchronous presses survive queued native notifications", async () => {
  const f = await fixture()
  try {
    f.app.mockInput.pressKey("ARROW_RIGHT")
    f.app.mockInput.pressKey("ARROW_RIGHT")
    await Bun.sleep(30)
    expect(f.editor.plainText).toBe("hello world and more")
    expect(f.ref.ghost).toBe(" world and more")
    expect(f.predictions()).toBe(2)
  } finally {
    f.close()
  }
})

test("a slow second press accepts only another word", async () => {
  const f = await fixture({ double_press_ms: 50 })
  try {
    f.app.mockInput.pressKey("ARROW_RIGHT")
    await Bun.sleep(70)
    f.app.mockInput.pressKey("ARROW_RIGHT")
    expect(f.editor.plainText).toBe("hello world and")
    expect(f.ref.ghost).toBe(" more")
  } finally {
    f.close()
  }
})

test("intervening navigation resets double press", async () => {
  const f = await fixture()
  try {
    f.app.mockInput.pressKey("ARROW_RIGHT")
    f.app.mockInput.pressKey("ARROW_LEFT")
    f.app.mockInput.pressKey("ARROW_RIGHT")
    f.app.mockInput.pressKey("ARROW_RIGHT")
    expect(f.editor.plainText).toBe("hello world and")
  } finally {
    f.close()
  }
})

test.each(["autocomplete", "shell", "dialog", "hidden", "disabled", "blur", "selection"])(
  "%s keeps ghost acceptance out of native input",
  async (mode) => {
    const f = await fixture()
    try {
      if (mode === "autocomplete") f.keymap.setData("opencode.mode", "autocomplete")
      if (mode === "shell") f.editor.traits = { ...f.editor.traits, status: "SHELL" }
      if (mode === "dialog") f.dialog.open = true
      if (mode === "hidden") f.props.visible = false
      if (mode === "disabled") f.props.disabled = true
      if (mode === "blur") f.editor.blur()
      if (mode === "selection") f.editor.setSelection(0, 3)
      f.controller.refresh()
      f.app.mockInput.pressKey("ARROW_RIGHT")
      expect(f.editor.plainText).toBe("hello")
      if (mode !== "selection") expect(f.ref.ghost).toBe("")
    } finally {
      f.close()
    }
  },
)

test("native append preserves middle cursor, attachment marks, and undo", async () => {
  const f = await fixture()
  try {
    f.editor.setText("中🙂\nhello")
    f.editor.cursorOffset = 2
    const cursor = f.editor.cursorOffset
    const mark = f.editor.extmarks.create({ start: 0, end: 2, virtual: false })
    const before = f.editor.extmarks.get(mark)
    expect(appendSuffix(f.editor, f.editor.plainText, " suffix")).toBe(true)
    expect(f.editor.plainText).toBe("中🙂\nhello suffix")
    expect(f.editor.cursorOffset).toBe(cursor)
    expect(f.editor.extmarks.get(mark)).toEqual(before)
    f.editor.undo()
    expect(f.editor.plainText).toBe("中🙂\nhello")
    f.editor.setSelection(0, 2)
    expect(appendSuffix(f.editor, f.editor.plainText, " bad")).toBe(false)
  } finally {
    f.close()
  }
})

test("ordinary backspace clears ghost and remains a real deletion", async () => {
  const f = await fixture({ debounce_ms: 40 })
  try {
    await Bun.sleep(50)
    expect(f.ref.ghost).toBe(" world and more")
    f.app.mockInput.pressBackspace()
    await Bun.sleep(10)
    expect(f.editor.plainText).toBe("hell")
    expect(f.ref.ghost).toBe("")
  } finally {
    f.close()
  }
})

test("disposal clears owned ghost and removes all additive editor listeners", async () => {
  const f = await fixture()
  try {
    const count = f.editor.editBuffer.listenerCount("content-changed")
    f.controller.dispose()
    f.controller.dispose()
    expect(f.ref.ghost).toBe("")
    expect(f.editor.editBuffer.listenerCount("content-changed")).toBe(count - 1)
    f.app.mockInput.pressKey("ARROW_RIGHT")
    expect(f.editor.plainText).toBe("hello")
  } finally {
    f.close()
  }
})

test("session change resets the quick-press sequence even with identical input", async () => {
  const f = await fixture()
  try {
    f.app.mockInput.pressKey("ARROW_RIGHT")
    f.props.sessionID = "two"
    f.controller.refresh()
    await Bun.sleep(25)
    f.app.mockInput.pressKey("ARROW_RIGHT")
    expect(f.editor.plainText).toBe("hello world world")
    expect(f.ref.ghost).toBe(" and more")
  } finally {
    f.close()
  }
})

test("reported autorepeat accepts another word rather than the whole remainder", async () => {
  const f = await fixture()
  try {
    f.app.mockInput.pressKey("ARROW_RIGHT")
    f.app.renderer.keyInput.processParsedKey({
      name: "right",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      raw: "\u001b[C",
      sequence: "\u001b[C",
      number: false,
      eventType: "repeat",
      source: "kitty",
      repeated: true,
    })
    expect(f.editor.plainText).toBe("hello world and")
    expect(f.ref.ghost).toBe(" more")
  } finally {
    f.close()
  }
})

test("actual typing and matching paste retain the remainder without extra inference", async () => {
  const f = await fixture()
  try {
    await f.app.mockInput.typeText(" wor")
    await Bun.sleep(20)
    expect(f.editor.plainText).toBe("hello wor")
    expect(f.ref.ghost).toBe("ld and more")
    expect(f.predictions()).toBe(1)
    f.app.mockInput.pasteBracketedText("ld and")
    await Bun.sleep(20)
    expect(f.ref.ghost).toBe(" more")
    expect(f.predictions()).toBe(1)
    f.app.mockInput.pressKey("ARROW_RIGHT")
    expect(f.editor.plainText).toBe("hello world and more")
    expect(f.ref.ghost).toBe("")
    await Bun.sleep(20)
    expect(f.predictions()).toBe(2)
    expect(f.ref.ghost).toBe(" world and more")
  } finally {
    f.close()
  }
})

test("typing through the entire suggestion requests exactly one continuation", async () => {
  const f = await fixture()
  try {
    await f.app.mockInput.typeText(" world and more")
    await Bun.sleep(20)
    expect(f.editor.plainText).toBe("hello world and more")
    expect(f.predictions()).toBe(2)
  } finally {
    f.close()
  }
})

test("typing inside repeated real text still recomputes instead of consuming", async () => {
  const f = await fixture({ debounce_ms: 40 }, "a tail")
  try {
    await Bun.sleep(50)
    f.editor.setText("aaa")
    await Bun.sleep(50)
    expect(f.ref.ghost).toBe("a tail")
    f.editor.cursorOffset = 1
    await f.app.mockInput.typeText("a")
    await Bun.sleep(10)
    expect(f.editor.plainText).toBe("aaaa")
    expect(f.ref.ghost).toBe("")
    expect(f.controller.scheduler.canAccept()).toBe(false)
  } finally {
    f.close()
  }
})

test("incremental matching typing consumes each character without inference", async () => {
  const f = await fixture()
  try {
    await f.app.mockInput.typeText(" wor", 3)
    await Bun.sleep(20)
    expect(f.ref.ghost).toBe("ld and more")
    expect(f.predictions()).toBe(1)
  } finally {
    f.close()
  }
})

test("a new suggestion after exhausting one word starts a fresh acceptance sequence", async () => {
  const f = await fixture({}, (calls) => (calls === 1 ? " word" : " another lengthy suggestion"))
  try {
    f.app.mockInput.pressKey("ARROW_RIGHT")
    await Bun.sleep(20)
    expect(f.ref.ghost).toBe(" another lengthy suggestion")
    f.app.mockInput.pressKey("ARROW_RIGHT")
    expect(f.editor.plainText).toBe("hello word another")
    expect(f.ref.ghost).toBe(" lengthy suggestion")
  } finally {
    f.close()
  }
})

test("conversation updates invalidate a retained typed prefix and reach the next model request", async () => {
  let context = "Assistant: Old answer"
  const f = await fixture({}, " world and more", () => context)
  try {
    await f.app.mockInput.typeText(" wor")
    await Bun.sleep(20)
    expect(f.ref.ghost).toBe("ld and more")
    expect(f.contexts).toEqual(["Assistant: Old answer"])
    context = "Assistant: New answer"
    f.controller.refresh()
    expect(f.ref.ghost).toBe("")
    await Bun.sleep(20)
    expect(f.contexts).toEqual(["Assistant: Old answer", "Assistant: New answer"])
    expect(f.ref.ghost).toBe(" world and more")
    expect(f.editor.plainText).toBe("hello wor")
  } finally {
    f.close()
  }
})
