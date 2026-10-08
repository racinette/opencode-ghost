import { isEditBufferRenderable, type EditBufferRenderable, type KeyEvent } from "@opentui/core"
import type { TuiPluginApi, TuiPromptProps, TuiPromptRef } from "@opencode-ai/plugin/tui"
import { appendSuffix, atEnd } from "./acceptance"
import type { Options } from "./options"
import { CompletionScheduler, type Snapshot } from "./scheduler"

export type GhostPromptRef = TuiPromptRef & { readonly ghost: string; setGhost(text: string): void }
export function supportsGhost(ref: TuiPromptRef): ref is GhostPromptRef {
  return "setGhost" in ref && typeof ref.setGhost === "function" && "ghost" in ref
}

type PromptApi = Pick<TuiPluginApi, "renderer" | "keymap"> & {
  ui: { dialog: Pick<TuiPluginApi["ui"]["dialog"], "open"> }
}

export class PromptController {
  readonly scheduler: CompletionScheduler
  private editor?: EditBufferRenderable
  private editorCleanup?: () => void
  private cleanup: (() => void)[] = []
  private disposed = false
  private last?: { time: number; input: string; editor: EditBufferRenderable; revision: number }
  private accepting = false

  constructor(
    private api: PromptApi,
    private ref: GhostPromptRef,
    private props: () => TuiPromptProps,
    private options: Options,
    predict: (input: string, signal: AbortSignal, context: string) => Promise<string>,
    onError?: (error: unknown) => void,
    private readContext: () => string = () => "",
  ) {
    this.scheduler = new CompletionScheduler(
      {
        snapshot: () => this.snapshot(),
        ghost: () => ref.ghost,
        setGhost: (text) => ref.setGhost(text),
        append: (snapshot, text) => !!this.editor && appendSuffix(this.editor, snapshot.input, text),
      },
      predict,
      options.debounce_ms,
      onError,
    )
    const focus = () => this.refresh()
    api.renderer.on("focused_editor", focus)
    this.cleanup.push(() => api.renderer.off("focused_editor", focus))
    this.cleanup.push(api.keymap.on("state", focus))
    const match = options.accept_key ? api.keymap.createKeyMatcher(options.accept_key) : () => false
    this.cleanup.push(
      api.keymap.intercept("key", ({ event }) => {
        if (!match(event) || event.eventType === "repeat" || event.repeated) this.last = undefined
      }),
    )
    this.refresh()
  }

  private snapshot(): Snapshot {
    const props = this.props()
    const editor = this.editor
    const traits = editor?.traits as (EditBufferRenderable["traits"] & { owner?: string; role?: string }) | undefined
    return {
      identity: editor ?? this.ref,
      input: editor && !editor.isDestroyed ? editor.plainText : this.ref.current.input,
      parts: JSON.stringify(this.ref.current.parts),
      session: props.sessionID,
      context: this.readContext(),
      atEnd: !!editor && !editor.isDestroyed && atEnd(editor),
      eligible:
        !this.disposed &&
        !!editor &&
        !editor.isDestroyed &&
        this.ref.focused &&
        this.api.renderer.currentFocusedEditor === editor &&
        traits?.owner === "opencode" &&
        traits.role === "prompt" &&
        traits.status !== "SHELL" &&
        !traits.capture?.includes("navigate") &&
        props.visible !== false &&
        !props.disabled &&
        !this.api.ui.dialog.open &&
        this.api.keymap.getData("opencode.mode") === "base",
    }
  }

  refresh() {
    if (this.disposed) return
    const candidate = this.api.renderer.currentFocusedEditor
    if (
      candidate &&
      isEditBufferRenderable(candidate) &&
      candidate !== this.editor &&
      this.ref.focused &&
      candidate.plainText === this.ref.current.input
    )
      this.bind(candidate)
    if (!this.snapshot().eligible) this.last = undefined
    this.scheduler.refresh()
    if (this.last?.revision !== this.scheduler.revision) this.last = undefined
  }

  private bind(editor: EditBufferRenderable) {
    this.editorCleanup?.()
    this.editor = editor
    this.last = undefined
    let active = true
    let notifications = 0
    const content = () => {
      notifications++
      if (notifications !== 1) return
      // Native edits enqueue separate microtasks, all reading the final buffer.
      // Reconcile once after that batch, retaining the count for our own inserts.
      queueMicrotask(() => {
        const count = notifications
        notifications = 0
        if (!active || this.disposed) return
        if (!this.accepting && this.last?.input !== editor.plainText) this.last = undefined
        this.scheduler.changed(count)
        if (!this.accepting && this.last?.revision !== this.scheduler.revision) this.last = undefined
      })
    }
    const cursor = () => {
      if (!this.accepting && !atEnd(editor)) this.last = undefined
      this.refresh()
    }
    editor.editBuffer.on("content-changed", content)
    editor.editBuffer.on("cursor-changed", cursor)
    editor.on("traits-changed", cursor)
    const removeLayer = this.options.accept_key
      ? this.api.keymap.registerLayer({
          target: editor,
          priority: 10,
          "ghost.acceptable": () =>
            this.snapshot().eligible && !editor.hasSelection() && atEnd(editor) && this.scheduler.canAccept(),
          commands: [{ name: "ghost.accept", run: ({ event }) => this.accept(event) }],
          bindings: [{ key: this.options.accept_key, cmd: "ghost.accept" }],
        })
      : () => {}
    this.editorCleanup = () => {
      active = false
      editor.editBuffer.off("content-changed", content)
      editor.editBuffer.off("cursor-changed", cursor)
      editor.off("traits-changed", cursor)
      removeLayer()
    }
  }

  private accept(event: KeyEvent) {
    const editor = this.editor
    if (!editor || !this.snapshot().eligible || editor.hasSelection() || !atEnd(editor)) return false
    const now = performance.now()
    const all =
      !event.repeated &&
      event.eventType !== "repeat" &&
      this.last?.editor === editor &&
      this.last.input === editor.plainText &&
      now - this.last.time <= this.options.double_press_ms
    this.accepting = true
    try {
      if (!this.scheduler.accept(all)) return false
      this.last =
        all || !this.scheduler.canAccept()
          ? undefined
          : { time: now, input: editor.plainText, editor, revision: this.scheduler.revision }
      return true
    } finally {
      this.accepting = false
    }
  }

  dispose() {
    if (this.disposed) return
    this.scheduler.dispose()
    this.disposed = true
    this.editorCleanup?.()
    this.cleanup.forEach((fn) => fn())
    this.cleanup = []
  }
}
