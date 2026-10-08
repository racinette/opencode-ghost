import { createModelClient } from "../src/model"
import { parseOptions } from "../src/options"

const options = parseOptions({
  endpoint: process.env.GHOST_ENDPOINT ?? "http://127.0.0.1:8080",
  request_timeout_ms: 30000,
})
const predict = createModelClient(options)
const prompts = [
  "Please help me fix the bug in",
  "Add a unit test that verifies",
  "Explain why this function returns",
  "Refactor the error handling so that",
  "Помоги исправить ошибку в",
]
// Warm-up keeps model startup out of the recorded request timings.
await predict(prompts[0]!, new AbortController().signal)
const results = []
for (const prompt of prompts) {
  const start = performance.now()
  const suffix = await predict(prompt, new AbortController().signal)
  results.push({ prompt, suffix, milliseconds: Math.round(performance.now() - start) })
}
console.log(JSON.stringify({ options, results }, null, 2))
