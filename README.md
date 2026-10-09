# opencode-ghost

Local prompt completion for OpenCode, with llama.cpp or OpenAI-compatible completion servers. Suggestions appear as muted text after your draft, using the current input and recent conversation as context.

Pause while typing to see a suggestion. With the cursor at the end of your input, press **Right Arrow** to accept one word. Press it again within **300 ms** to accept the rest. A slower press accepts another word. Inside the draft, Right Arrow moves the cursor normally.

Typing or pasting text that matches the suggestion consumes it without another model request. When the suggestion runs out, the plugin requests a continuation. Backspace, edits inside the draft, and text that diverges from the suggestion trigger a fresh prediction. Moving the cursor keeps the suggestion at the end of the full draft.

Suggestions stay inactive during command and file autocomplete, shell mode, and dialogs. Accepting text never submits your prompt.

## Setup

Requires Bun, OpenCode with prompt ghost API support (`ghost` and `setGhost` on the prompt reference), and a supported completion endpoint. The plugin works with OpenCode's normal backend or an alternative backend such as the Codex bridge; neither requires the other. The setup below uses llama.cpp.

Clone the plugin anywhere and install its dependencies:

```sh
git clone https://github.com/racinette/opencode-ghost.git
cd opencode-ghost
bun install
```

On macOS, install llama.cpp with `brew install llama.cpp`. Start the model server in a separate terminal:

```sh
llama-server -hf ggml-org/Qwen3.5-0.8B-Base-GGUF:Q8_0 \
  --host 127.0.0.1 --port 8080 -c 4096
```

The first run downloads the model. Keep the server running while using OpenCode.

Add the plugin to your project's `.opencode/tui.json`, replacing the path with the absolute path to your clone. Preserve any existing plugin entries:

```json
{
  "plugin": [
    [
      "/absolute/path/opencode-ghost/src/index.tsx",
      {
        "endpoint": "http://127.0.0.1:8080",
        "conversation_chars": 10000,
        "prompt_format": "chatml"
      }
    ]
  ]
}
```

Start `opencode` in your project, type a draft, and pause. Suggestions appear after the input even when the cursor is elsewhere; move to the end to accept them.

## Other completion providers

Choose `backend: "llamacpp"` (the default), `"openai-completion"`, or `"openai-chat"`. Compatible backends require a `model`. Set `endpoint` to the API base URL including its version prefix, for example `https://provider.example/v1`; the plugin appends `/completions` or `/chat/completions`. llama.cpp appends `/completion`.

For example, use these plugin options with a chat-completion provider:

```json
{
  "backend": "openai-chat",
  "endpoint": "https://provider.example/v1",
  "model": "your-model-name",
  "api_key_env": "GHOST_API_KEY",
  "request_timeout_ms": 10000
}
```

Set `GHOST_API_KEY` in the environment before starting OpenCode. `api_key_env` reads a bearer token from that variable; it does not contain the token itself. Local endpoints can omit authentication. `headers` supplies literal custom headers, such as a project identifier. `headers_env` maps header names to environment-variable names for secret headers, for example `{"x-api-key": "GHOST_API_KEY"}`. Environment headers override literal headers; bearer authentication overrides an Authorization header. Missing configured secrets fail the request without sending it. Redirects are rejected.

Text-completion backends use `prompt_format`. Chat-completion backends send structured user/assistant history and the current draft, with a system instruction requesting only the text to append; `prompt_format` does not affect chat messages. No assistant-prefill extension is required.

Completion quality, spacing, latency, and instruction following vary by model and provider. We have not established that chat models are better or worse for this task. Try models with your own drafts and conversation context. Protocol compatibility is tested with local fixtures; it is not a quality benchmark or a claim that every hosted provider/model supports these parameters. The compatible adapters use non-streaming requests with `max_tokens`, `temperature`, `top_p`, and optional `stop`; models requiring a different API or parameter set are not supported by these adapters.

Remote endpoints receive your draft and retained conversation. Hosted services may charge for requests, including predictions superseded by further typing.

## Configuration

Options have defaults except `model`, which is required for OpenAI-compatible backends.

| Option               | Default                   | Meaning                                               |
| -------------------- | ------------------------- | ----------------------------------------------------- |
| `backend`            | `"llamacpp"`              | llama.cpp, `"openai-completion"`, or `"openai-chat"`  |
| `model`              | unset                     | Required model name for compatible backends           |
| `api_key_env`        | unset                     | Environment variable containing bearer token          |
| `headers`            | `{}`                      | Literal custom HTTP headers                           |
| `headers_env`        | `{}`                      | Header names mapped to secret environment variables   |
| `enabled`            | `true`                    | Enable the plugin                                     |
| `endpoint`           | `"http://127.0.0.1:8080"` | Backend HTTP base URL                                 |
| `prompt_format`      | `"chatml"`                | Native ChatML role tokens; `"plain"` uses role labels |
| `conversation_chars` | `10000`                   | Maximum conversation characters; `0` disables history |
| `debounce_ms`        | `100`                     | Delay after editing before requesting a suggestion    |
| `max_tokens`         | `8`                       | Maximum generated tokens, from 1 to 64                |
| `temperature`        | `0.2`                     | Sampling temperature                                  |
| `top_p`              | `0.95`                    | Nucleus sampling cutoff                               |
| `request_timeout_ms` | `2000`                    | Request timeout in milliseconds                       |
| `stop_on_newline`    | `true`                    | End suggestions at the first newline                  |
| `accept_key`         | `"right"`                 | Acceptance binding; `false` disables it               |
| `double_press_ms`    | `300`                     | Window for the second press to accept the rest        |
| `debug`              | `false`                   | Show request errors as temporary notifications        |

The acceptance binding applies only at the end of the draft with a visible suggestion and no selection. Other keys reset the double-press sequence. Word boundaries follow Unicode segmentation; leading punctuation or symbols are accepted one grapheme at a time. Leading whitespace is preserved. Reported keyboard autorepeat does not accept the entire suggestion; terminals that send indistinguishable repeated keypresses may behave like a double press.

## Conversation context

Each request includes your full draft and up to `conversation_chars` Unicode characters from the end of the active session's cached conversation. User and assistant messages retain their roles. Reasoning, tool output, synthetic or ignored text, and reverted turns are excluded. The plugin reads OpenCode's cached messages without fetching older history or adding files and directory listings.

The default `chatml` format uses native role tokens and leaves the current user turn open so the model continues your draft:

```text
<|im_start|>user
Previous request<|im_end|>
<|im_start|>assistant
Previous response<|im_end|>
<|im_start|>user
Current unfinished draft
```

For chat backends, the limit counts message bodies and role names, excluding JSON transport overhead; trimming preserves structured roles. For text backends, role headers and closing tokens count toward the history limit. When a message needs trimming, only its body is cut; a limit too small to fit a complete frame with text omits history. Your current draft is kept in full outside this limit. Role and end markers are excluded from suggestions.

The default framing matches the Qwen model in the setup example. For models that do not use ChatML, set `prompt_format` to `"plain"` to use `User:` and `Assistant:` labels. Plain mode keeps the final N characters of the transcript, so its cutoff can fall inside a label. Without history, plain mode sends the draft alone. Text-completion backends do not detect chat templates automatically. Chat-completion backends send structured roles for the server to template.

Increase `conversation_chars` to retain more history. The character limit is separate from the model's token context limit: larger values may require a larger server context (`-c`). Requests reported as truncated are discarded. Changes to the retained conversation invalidate existing suggestions and pending predictions.

## Privacy and compatibility

The plugin sends your draft and retained conversation to the configured endpoint. The default is a server on your own machine. Suggestions are not persisted, and the plugin has no telemetry. It does not download models or start the server.

If the server is unavailable or returns unusable output, normal typing continues without a suggestion. Obsolete responses are discarded. Acceptance preserves the editor's undo history and attachment marks.

The plugin uses OpenCode's home and session prompt slots. Another plugin replacing those slots may take precedence. OpenCode versions without prompt ghost API support show a one-time compatibility notification.

## Development

```sh
bun run check
```

This runs the typecheck and tests for the model client, conversation formatting, suggestion scheduling, and native editor interactions.

To measure request latency with a running model server:

```sh
bun run benchmark
```

Set `GHOST_ENDPOINT` to benchmark another endpoint. Timings exclude the typing debounce and model startup.

For a deterministic UI demo without a model:

```sh
bun run demo-server
```

Set the plugin endpoint to `http://127.0.0.1:8081`. The demo server returns a fixed suggestion.
