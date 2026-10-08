import { record } from "../src/options"

// Deterministic transport fixture for UI demonstrations without a model.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.GHOST_DEMO_PORT ?? 8081),
  async fetch(request) {
    if (new URL(request.url).pathname !== "/completion" || request.method !== "POST")
      return new Response("Not found", { status: 404 })
    const body: unknown = await request.json()
    if (!record(body) || typeof body.prompt !== "string") return new Response("Invalid prompt", { status: 400 })
    await Bun.sleep(100)
    return Response.json({ content: " with a short local suggestion", truncated: false })
  },
})
console.log(`Deterministic demo completion server: ${server.url.origin}`)
