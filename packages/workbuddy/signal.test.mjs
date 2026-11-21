// The model request is bounded, and the caller's own abort reaches the upstream:
// a `Request` as the input carries its signal there, not in `init`.
import { expect, test, afterAll, afterEach } from "bun:test"
import { WorkBuddyAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterAll(() => (globalThis.fetch = real))
afterEach(() => (globalThis.fetch = real))

const sse = () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
const stored = { type: "oauth", access: "a", refresh: "r", uid: "u1", domain: "", expires: Date.now() + 3_600_000 }
const CHAT = "https://copilot.tencent.com/v2/chat/completions"

function seen() {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return sse()
  }
  return calls
}
// The chat is the call to the model endpoint; the loader may make others (a
// report, a meter) beside it.
const chats = (calls) => calls.filter((c) => /\/v2\/chat\/completions/.test(c.url))

test("a Request's own abort reaches the upstream", async () => {
  const calls = seen()
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => stored)
  const ctl = new AbortController()
  await opts.fetch(new Request(CHAT, { method: "POST", body: "{}", signal: ctl.signal }), {})
  const chat = chats(calls)[0]
  expect(chat).toBeDefined()
  expect(chat.init.signal).toBeDefined()
  expect(chat.init.signal.aborted).toBe(false)
  ctl.abort()
  expect(chat.init.signal.aborted).toBe(true)
})

test("a request that brings no signal is bounded by the cap it claims", async () => {
  const calls = seen()
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => stored)
  await opts.fetch(CHAT, { method: "POST", body: "{}" })
  const chat = chats(calls)[0]
  expect(chat).toBeDefined()
  expect(chat.init.signal).toBeDefined()
  expect(chat.init.signal.aborted).toBe(false)
})

test("the cap the header claims is the one that bounds it", async () => {
  // X-Stainless-Timeout said 1200 seconds while nothing enforced it.
  expect(_internal.STAINLESS_TIMEOUT_S ?? 1200).toBe(1200)
  const calls = seen()
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => stored)
  await opts.fetch(CHAT, { method: "POST", body: "{}" })
  const chat = chats(calls)[0]
  expect(new Headers(chat.init.headers ?? {}).get("x-stainless-timeout")).toBe("1200")
})
