import type { TuiPluginApi, TuiPluginModule, TuiPromptProps, TuiPromptRef } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { PromptController, supportsGhost } from "./adapter"
import { conversationTail } from "./context"
import { createModelClient } from "./model"
import { parseOptions, type Options } from "./options"

function GhostPrompt(props: TuiPromptProps & { api: TuiPluginApi; options: Options; unsupported(): void }) {
  const [ref, setRef] = createSignal<TuiPromptRef>()
  const context = createMemo(() =>
    conversationTail(
      props.api.state,
      props.sessionID,
      props.options.conversation_chars,
      props.options.backend === "openai-chat" ? "messages" : props.options.prompt_format,
    ),
  )
  let controller: PromptController | undefined
  const dispose = () => controller?.dispose()
  const unregister = props.api.lifecycle.onDispose(dispose)
  onCleanup(() => {
    dispose()
    unregister()
  })
  createEffect(() => {
    const prompt = ref()
    prompt?.current.input
    JSON.stringify(prompt?.current.parts)
    props.sessionID
    context()
    props.visible
    props.disabled
    props.api.ui.dialog.open
    controller?.refresh()
  })
  const Prompt = props.api.ui.Prompt
  return (
    <Prompt
      sessionID={props.sessionID}
      visible={props.visible}
      disabled={props.disabled}
      onSubmit={props.onSubmit}
      right={props.right}
      hint={props.hint}
      showPlaceholder={props.showPlaceholder}
      placeholders={props.placeholders}
      ref={(value) => {
        dispose()
        controller = undefined
        if (value && supportsGhost(value)) {
          controller = new PromptController(
            props.api,
            value,
            () => props,
            props.options,
            createModelClient(props.options),
            props.options.debug
              ? (error) =>
                  props.api.ui.toast({
                    variant: "warning",
                    message: error instanceof Error ? error.message : "Completion failed",
                    duration: 1500,
                  })
              : undefined,
            context,
          )
        } else if (value) props.unsupported()
        setRef(value)
        props.ref?.(value)
      }}
    />
  )
}

const plugin: TuiPluginModule = {
  id: "opencode-ghost",
  async tui(api, input) {
    const options = parseOptions(input)
    if (!options.enabled) return
    let warned = false
    const unsupported = () => {
      if (warned) return
      warned = true
      api.ui.toast({
        variant: "warning",
        message: "opencode-ghost requires OpenCode's prompt ghost API",
        duration: 5000,
      })
    }
    api.keymap.registerLayerFields({
      "ghost.acceptable"(value, ctx) {
        ctx.activeWhen(() => typeof value === "function" && value() === true)
      },
    })
    api.slots.register({
      slots: {
        home_prompt(_ctx, props) {
          return (
            <GhostPrompt
              api={api}
              options={options}
              unsupported={unsupported}
              ref={props.ref}
              right={<api.ui.Slot name="home_prompt_right" />}
            />
          )
        },
        session_prompt(_ctx, props) {
          return (
            <GhostPrompt
              api={api}
              options={options}
              unsupported={unsupported}
              sessionID={props.session_id}
              visible={props.visible}
              disabled={props.disabled}
              onSubmit={props.on_submit}
              ref={props.ref}
              right={<api.ui.Slot name="session_prompt_right" session_id={props.session_id} />}
            />
          )
        },
      },
    })
  },
}
export default plugin
