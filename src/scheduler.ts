import { wordPrefix } from "./acceptance"

export type Snapshot = {
  identity: object
  input: string
  parts: string
  context: string
  session?: string
  eligible: boolean
  atEnd: boolean
}

export type PromptHost = {
  snapshot(): Snapshot | undefined
  ghost(): string
  setGhost(text: string): void
  append(snapshot: Snapshot, text: string): boolean
}

type Suggestion = { snapshot: Snapshot; generation: number; suffix: string }

function sameContext(a: Snapshot | undefined, b: Snapshot | undefined) {
  return (
    a?.identity === b?.identity &&
    a?.parts === b?.parts &&
    a?.context === b?.context &&
    a?.session === b?.session &&
    a?.eligible === b?.eligible
  )
}

function same(a: Snapshot | undefined, b: Snapshot | undefined) {
  return sameContext(a, b) && a?.input === b?.input
}

export class CompletionScheduler {
  private generation = 0
  private timer?: ReturnType<typeof setTimeout>
  private abort?: AbortController
  private observed?: Snapshot
  private suggestion?: Suggestion
  private disposed = false
  private accepting = false
  private ownNotifications = 0
  private ownSnapshot?: Snapshot

  constructor(
    private host: PromptHost,
    private predict: (input: string, signal: AbortSignal, context: string) => Promise<string>,
    private debounce: number,
    private onError: (error: unknown) => void = () => {},
  ) {}

  refresh() {
    if (this.disposed || this.accepting) return
    const snapshot = this.host.snapshot()
    // Text changes are reconciled by additive native content notifications.
    // Solid effects and cursor notifications may report the same edit first.
    if (sameContext(snapshot, this.observed)) return
    this.changed()
  }

  /** Force a revision even if coalesced native events now see the same text. */
  changed(notifications = 1) {
    if (this.disposed) return
    if (this.accepting) {
      this.ownNotifications = Math.max(0, this.ownNotifications - notifications)
      return
    }
    // Native insertText queues one notification per insertion, including rapid accepts.
    if (this.ownNotifications >= notifications && same(this.host.snapshot(), this.ownSnapshot)) {
      this.ownNotifications -= notifications
      return
    }
    this.ownNotifications = 0
    const snapshot = this.host.snapshot()
    const item = this.suggestion
    const added =
      item && snapshot?.input.startsWith(item.snapshot.input) ? snapshot.input.slice(item.snapshot.input.length) : ""
    const consume =
      !!item &&
      item.generation === this.generation &&
      this.host.ghost() === item.suffix &&
      snapshot?.eligible &&
      snapshot.atEnd &&
      sameContext(snapshot, item.snapshot) &&
      added.length > 0 &&
      item.suffix.startsWith(added)
    this.invalidate()
    this.observed = snapshot
    if (consume && item && snapshot) {
      const remaining = item.suffix.slice(added.length)
      if (remaining) {
        this.suggestion = { snapshot, generation: this.generation, suffix: remaining }
        this.host.setGhost(remaining)
        return
      }
    }
    this.schedule()
  }

  private schedule() {
    if (!this.observed?.eligible || !this.observed.input.trim()) return
    const snapshot = this.observed
    const generation = this.generation
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run(snapshot, generation)
    }, this.debounce)
  }

  private current(snapshot: Snapshot, generation: number) {
    return !this.disposed && generation === this.generation && snapshot.eligible && same(snapshot, this.host.snapshot())
  }

  private async run(snapshot: Snapshot, generation: number) {
    if (!this.current(snapshot, generation)) return
    const abort = new AbortController()
    this.abort = abort
    try {
      const suffix = await this.predict(snapshot.input, abort.signal, snapshot.context)
      if (!suffix || !this.current(snapshot, generation)) return
      this.suggestion = { snapshot, generation, suffix }
      this.host.setGhost(suffix)
    } catch (error) {
      if (!abort.signal.aborted && this.current(snapshot, generation)) this.onError(error)
    } finally {
      if (this.abort === abort) this.abort = undefined
    }
  }

  get revision() {
    return this.generation
  }

  canAccept() {
    const item = this.suggestion
    return !!item && this.current(item.snapshot, item.generation) && this.host.ghost() === item.suffix
  }

  accept(all = false) {
    const item = this.suggestion
    if (!item || !this.canAccept()) return false
    const prefix = all ? item.suffix : wordPrefix(item.suffix)
    this.accepting = true
    this.ownNotifications++
    try {
      if (!this.host.append(item.snapshot, prefix)) {
        this.ownNotifications--
        return false
      }
      this.invalidate()
      this.observed = this.host.snapshot()
      this.ownSnapshot = this.observed
      const remaining = item.suffix.slice(prefix.length)
      if (remaining && this.observed?.eligible) {
        this.suggestion = { snapshot: this.observed, generation: this.generation, suffix: remaining }
        this.host.setGhost(remaining)
      } else {
        this.schedule()
      }
      return true
    } finally {
      this.accepting = false
    }
  }

  private invalidate() {
    this.generation++
    clearTimeout(this.timer)
    this.timer = undefined
    this.abort?.abort()
    this.abort = undefined
    if (this.suggestion && this.host.ghost() === this.suggestion.suffix) this.host.setGhost("")
    this.suggestion = undefined
  }

  dispose() {
    if (this.disposed) return
    this.invalidate()
    this.disposed = true
  }
}
