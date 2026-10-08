import { expect, test } from "bun:test"
import { CompletionScheduler, type Snapshot } from "../src/scheduler"
import { wordPrefix } from "../src/acceptance"

function fixture(predict: (input: string, signal: AbortSignal, context: string) => Promise<string>, debounce = 0) {
  let state: Snapshot = { identity: {}, input: "hello", parts: "[]", eligible: true, atEnd: true, context: "" }
  let ghost = ""
  const scheduler = new CompletionScheduler(
    {
      snapshot: () => state,
      ghost: () => ghost,
      setGhost: (value) => {
        ghost = value
      },
      append: (snapshot, suffix) => {
        if (snapshot.input !== state.input) return false
        state = { ...state, input: state.input + suffix }
        return true
      },
    },
    predict,
    debounce,
  )
  return {
    scheduler,
    state: () => state,
    ghost: () => ghost,
    update: (patch: Partial<Snapshot>) => {
      state = { ...state, ...patch }
    },
    setGhost: (text: string) => {
      ghost = text
    },
  }
}
const tick = () => Bun.sleep(10)

test.each([
  [" world again", " world"],
  [" élan more", " élan"],
  ["  👨‍👩‍👧‍👦 next", "  👨‍👩‍👧‍👦"],
  ["中文世界", "中文"],
  [", next", ","],
  ["\n", "\n"],
])("word prefix %j preserves Unicode boundaries", (suffix, prefix) => expect(wordPrefix(suffix)).toBe(prefix))

test("debounce coalesces edits", async () => {
  const inputs: string[] = []
  const f = fixture(async (input) => {
    inputs.push(input)
    return " world"
  }, 20)
  try {
    f.scheduler.refresh()
    f.update({ input: "hello again" })
    f.scheduler.changed()
    await Bun.sleep(35)
    expect(inputs).toEqual(["hello again"])
    expect(f.ghost()).toBe(" world")
  } finally {
    f.scheduler.dispose()
  }
})

test("aborted requests cannot reappear after an away-and-back edit", async () => {
  const requests: { signal: AbortSignal; resolve: (suffix: string) => void }[] = []
  const f = fixture((_, signal) => new Promise((resolve) => requests.push({ signal, resolve })))
  try {
    f.scheduler.refresh()
    await tick()
    f.update({ input: "changed" })
    f.scheduler.changed()
    f.update({ input: "hello" })
    f.scheduler.changed()
    await tick()
    expect(requests[0]!.signal.aborted).toBe(true)
    requests[1]!.resolve(" fresh")
    await tick()
    requests[0]!.resolve(" stale")
    await tick()
    expect(f.ghost()).toBe(" fresh")
  } finally {
    f.scheduler.dispose()
  }
})

test("single-word acceptance retains remainder across its delayed edit event", async () => {
  let calls = 0
  const f = fixture(async () => {
    calls++
    return calls === 1 ? " world and more" : ""
  })
  try {
    f.scheduler.refresh()
    await tick()
    expect(f.scheduler.accept()).toBe(true)
    expect(f.state().input).toBe("hello world")
    expect(f.ghost()).toBe(" and more")
    f.scheduler.refresh()
    f.scheduler.changed()
    await tick()
    expect(f.ghost()).toBe(" and more")
    expect(f.scheduler.accept(true)).toBe(true)
    f.scheduler.changed()
    await tick()
    expect(f.state().input).toBe("hello world and more")
    expect(f.ghost()).toBe("")
    expect(calls).toBe(2)
  } finally {
    f.scheduler.dispose()
  }
})

test.each([
  { eligible: false },
  { parts: '["attachment"]' },
  { context: "updated conversation" },
  { session: "new" },
  { identity: {} },
])("context change %j clears and blocks old acceptance", async (patch) => {
  const f = fixture(async () => " world")
  try {
    f.scheduler.refresh()
    await tick()
    f.update(patch)
    f.scheduler.refresh()
    expect(f.ghost()).toBe("")
    expect(f.scheduler.accept()).toBe(false)
  } finally {
    f.scheduler.dispose()
  }
})

test("does not clear or accept another plugin's ghost", async () => {
  const f = fixture(async () => " owned")
  f.scheduler.refresh()
  await tick()
  f.setGhost(" external")
  expect(f.scheduler.accept()).toBe(false)
  f.scheduler.dispose()
  expect(f.ghost()).toBe(" external")
})

test("disposal cancels and ignores late responses", async () => {
  let resolve!: (text: string) => void
  const f = fixture(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  f.scheduler.refresh()
  await tick()
  f.scheduler.dispose()
  resolve(" late")
  await tick()
  expect(f.ghost()).toBe("")
})

test("matching typing consumes the ghost without inference, even after a reactive refresh", async () => {
  const inputs: string[] = []
  const f = fixture(async (input) => {
    inputs.push(input)
    return " My name is"
  })
  f.update({ input: "Hello!" })
  try {
    f.scheduler.refresh()
    await tick()
    f.update({ input: "Hello! My" })
    f.scheduler.refresh()
    f.scheduler.changed()
    await tick()
    expect(f.ghost()).toBe(" name is")
    expect(inputs).toEqual(["Hello!"])
    expect(f.scheduler.canAccept()).toBe(true)
    f.update({ input: "Hello! My name" })
    f.scheduler.changed()
    await tick()
    expect(f.ghost()).toBe(" is")
    expect(inputs).toEqual(["Hello!"])
    f.update({ input: "Hello! My name is" })
    f.scheduler.changed()
    expect(f.ghost()).toBe("")
    await tick()
    expect(inputs).toEqual(["Hello!", "Hello! My name is"])
  } finally {
    f.scheduler.dispose()
  }
})

test.each(["hello friend", "hello world again plus more"])(
  "divergence or typing beyond the ghost predicts from %j",
  async (input) => {
    const inputs: string[] = []
    const f = fixture(async (prompt) => {
      inputs.push(prompt)
      return " world again"
    })
    try {
      f.scheduler.refresh()
      await tick()
      f.update({ input })
      f.scheduler.changed()
      expect(f.ghost()).toBe("")
      await tick()
      expect(inputs).toEqual(["hello", input])
    } finally {
      f.scheduler.dispose()
    }
  },
)

test.each([
  { input: "hell" },
  { input: "heXllo" },
  { input: "hello w", atEnd: false },
  { input: "hello w", session: "two" },
  { input: "hello w", parts: '["attachment"]' },
])("non-append or changed-context edit %j does not consume the old ghost", async (patch) => {
  const inputs: string[] = []
  const f = fixture(async (input) => {
    inputs.push(input)
    return " world again"
  })
  try {
    f.scheduler.refresh()
    await tick()
    f.update(patch)
    f.scheduler.changed()
    expect(f.ghost()).toBe("")
    await tick()
    expect(inputs).toEqual(["hello", patch.input])
  } finally {
    f.scheduler.dispose()
  }
})

test("matching characters consume Unicode suffixes exactly without modifying real text", async () => {
  const f = fixture(async () => " 中文👨‍👩‍👧‍👦 élan")
  try {
    f.scheduler.refresh()
    await tick()
    f.update({ input: "hello 中文👨‍👩‍👧‍👦" })
    f.scheduler.changed()
    expect(f.ghost()).toBe(" élan")
    expect(f.state().input).toBe("hello 中文👨‍👩‍👧‍👦")
    f.update({ input: "hello 中文👨‍👩‍👧‍👦 é" })
    f.scheduler.changed()
    expect(f.ghost()).toBe("lan")
  } finally {
    f.scheduler.dispose()
  }
})

test("backspace after matching typing invalidates instead of resurrecting consumed text", async () => {
  const f = fixture(async () => " world again", 20)
  try {
    f.scheduler.refresh()
    await Bun.sleep(30)
    f.update({ input: "hello wor" })
    f.scheduler.changed()
    expect(f.ghost()).toBe("ld again")
    f.update({ input: "hello wo" })
    f.scheduler.changed()
    expect(f.ghost()).toBe("")
    expect(f.scheduler.canAccept()).toBe(false)
  } finally {
    f.scheduler.dispose()
  }
})

test("only the current generation can extend after exhaustion", async () => {
  const requests: { input: string; signal: AbortSignal; resolve: (suffix: string) => void }[] = []
  const f = fixture((input, signal) => new Promise((resolve) => requests.push({ input, signal, resolve })))
  try {
    f.scheduler.refresh()
    await tick()
    requests[0]!.resolve(" world")
    await tick()
    f.update({ input: "hello world" })
    f.scheduler.changed()
    await tick()
    expect(requests[1]!.input).toBe("hello world")
    f.update({ input: "hello world!" })
    f.scheduler.changed()
    await tick()
    expect(requests[1]!.signal.aborted).toBe(true)
    requests[2]!.resolve(" fresh")
    await tick()
    requests[1]!.resolve(" stale")
    await tick()
    expect(f.ghost()).toBe(" fresh")
  } finally {
    f.scheduler.dispose()
  }
})

test("conversation changes supersede requests even when the current draft is unchanged", async () => {
  const requests: { context: string; signal: AbortSignal; resolve: (suffix: string) => void }[] = []
  const f = fixture((_, signal, context) => new Promise((resolve) => requests.push({ context, signal, resolve })))
  f.update({ context: "Assistant: Old answer" })
  try {
    f.scheduler.refresh()
    await tick()
    f.update({ context: "Assistant: New answer" })
    f.scheduler.refresh()
    await tick()
    expect(requests[0]!.context).toBe("Assistant: Old answer")
    expect(requests[0]!.signal.aborted).toBe(true)
    expect(requests[1]!.context).toBe("Assistant: New answer")
    requests[1]!.resolve(" fresh")
    await tick()
    requests[0]!.resolve(" stale")
    await tick()
    expect(f.ghost()).toBe(" fresh")
  } finally {
    f.scheduler.dispose()
  }
})
