// auth.refresh: magpie renews a browser sign-in ahead of time, through the
// same one-refresh-at-a-time as a request's, and saves what it gives.
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error(
      "run with HOME=$(mktemp -d) bun test (on Windows set USERPROFILE to a temp dir: "
      + "node:os homedir() follows USERPROFILE there, not HOME)",
    )
  ;({ WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal } = await import("./index.mjs"))
})
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
globalThis.fetch = offline
afterAll(() => (globalThis.fetch = real))
afterEach(() => {
  globalThis.fetch = offline
  _internal.renewing.clear()
  _internal.renewed.clear()
  _internal.seenIdentities?.clear()
})

const ok = (data) => new Response(JSON.stringify({ code: 0, msg: "ok", data }))

// serve answers WorkBuddy's refresh (after gate, when given) and chats.
function serve(answer, gate) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    calls.push({ url: u, headers: new Headers(init?.headers) })
    if (u.pathname === "/v2/plugin/auth/token/refresh") {
      if (gate) await gate
      return answer(init)
    }
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  return calls
}
const refreshes = (calls) => calls.filter((c) => c.url.pathname === "/v2/plugin/auth/token/refresh")
const soon = () => Date.now() + 3 * 60 * 1000 // within the lead, past EARLY_MS
const auth = (over = {}) => ({ type: "oauth", access: "old", refresh: "r1", expires: soon(), uid: "u1", domain: "", ...over })
const NEW = { accessToken: "new", refreshToken: "r2", expiresIn: 3600, refreshExpiresIn: 7200 }

test("auth.refresh renews and gives the new fields, saving nothing itself", async () => {
  const calls = serve(() => ok(NEW))
  const sets = []
  const hooks = await WorkBuddyAIAuthPlugin({ client: { auth: { set: async (x) => sets.push(x) } } })
  expect(hooks.auth.refreshLead).toBeGreaterThanOrEqual(60 * 1000)
  expect(hooks.auth.rotating).toBe(true)
  const got = await hooks.auth.refresh(auth(), "workbuddy-ai")
  expect(got.access).toBe("new")
  expect(got.refresh).toBe("r2")
  expect(got.expires).toBeGreaterThan(Date.now() + 3500 * 1000)
  expect(got.refreshExpiresAt).toBeGreaterThan(Date.now() + 7100 * 1000)
  expect("type" in got).toBe(false)
  expect("uid" in got).toBe(false)
  expect(sets).toEqual([])
  const r = refreshes(calls)
  expect(r.length).toBe(1)
  expect(r[0].url.origin).toBe("https://www.workbuddy.ai")
  expect(r[0].headers.get("x-refresh-token")).toBe("r1")
})

test("auth.refresh and a request's refresh at once spend the refresh token once", async () => {
  let open
  const gate = new Promise((ok) => (open = ok))
  const calls = serve(() => ok(NEW), gate)
  const sets = []
  const hooks = await WorkBuddyAuthPlugin({ client: { auth: { set: async (x) => sets.push(x) } } })
  const stored = auth({ expires: Date.now() + 30 * 1000 }) // stale for a request too
  const opts = await hooks.auth.loader(async () => stored)
  const req = opts.fetch("https://copilot.tencent.com/v2/chat/completions", { method: "POST", body: "{}" })
  const hook = hooks.auth.refresh(stored, "workbuddy")
  await new Promise((ok) => setTimeout(ok, 10))
  open()
  const [res, got] = await Promise.all([req, hook])
  expect(res.status).toBe(200)
  expect(got.access).toBe("new")
  expect(refreshes(calls).length).toBe(1)
  // saved at most once: by the request when it spent the token, else by
  // magpie, from what the hook gave
  expect(sets.length).toBeLessThanOrEqual(1)
  const chat = calls.find((c) => c.url.pathname === "/v2/chat/completions")
  expect(chat.headers.get("authorization")).toBe("Bearer new")
})

test("auth.refresh after a request renewed the token gives that one", async () => {
  const calls = serve(() => ok(NEW))
  const hooks = await WorkBuddyAuthPlugin({ client: { auth: { set: async () => {} } } })
  const stored = auth({ expires: Date.now() + 30 * 1000 })
  await _internal.fresh(_internal.SITES.workbuddy, null, stored)
  const got = await hooks.auth.refresh(stored, "workbuddy")
  expect(got.access).toBe("new")
  expect(refreshes(calls).length).toBe(1)
})

test("a refresh token past its end is said plainly, the account not marked", async () => {
  const calls = serve(() => ok(NEW))
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const e = await hooks.auth.refresh(auth({ refreshExpiresAt: Date.now() - 1000 }), "workbuddy").catch((e) => e)
  expect(e).toBeInstanceOf(Error)
  expect(e.signIn).toBeUndefined()
  expect(e.message).toContain("signed out")
  expect(refreshes(calls).length).toBe(0)
})

test("a refresh that fails throws plainly, and the next one tries again", async () => {
  let fail = true
  serve(() => (fail ? new Response("busy", { status: 502 }) : ok(NEW)))
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const e = await hooks.auth.refresh(auth(), "workbuddy").catch((e) => e)
  expect(e).toBeInstanceOf(Error)
  expect(e.signIn).toBeUndefined()
  expect(e.message).toContain("WorkBuddy token refresh")
  fail = false
  expect((await hooks.auth.refresh(auth(), "workbuddy")).access).toBe("new")
})

test("nothing to renew with gives nothing", async () => {
  const calls = serve(() => ok(NEW))
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  expect(await hooks.auth.refresh(auth({ refresh: "" }), "workbuddy")).toBeUndefined()
  expect(await hooks.auth.refresh({ type: "oauth", source: "desktop", refresh: "", access: "", expires: 0, uid: "u" }, "workbuddy")).toBeUndefined()
  expect(await hooks.auth.refresh({ type: "api", key: "k" }, "workbuddy")).toBeUndefined()
  expect(refreshes(calls).length).toBe(0)
})

test("what a renewal kept for the old token is dropped once it can no longer answer", async () => {
  // `renewed` holds the credential a rotation gave, so the old refresh token's
  // holder takes that instead of spending it. It is only useful for a minute, and
  // nothing else ever took an entry out: every rotation left a spent refresh token
  // and an access token in memory for the life of the process.
  serve(() => ok(NEW))
  const stale = Date.now() - 2 * 60 * 1000
  _internal.renewed.set("workbuddy\nr0", { next: { access: "old", refresh: "r0" }, at: stale })
  const hooks = await WorkBuddyAuthPlugin({ client: { auth: { set: async () => ({}) } } })
  const got = await hooks.auth.refresh(auth(), "workbuddy")
  expect(got.refresh).toBe("r2")
  expect(_internal.renewed.has("workbuddy\nr0")).toBe(false)
  expect(_internal.renewed.size).toBe(1)
})

test("a renewal whose record could not be written is kept, not dropped a minute later", async () => {
  // The record write is best effort: a locked file or a full disk fails it. The
  // new tokens are then the only copy there is, and the record still holds a
  // refresh token this renewal already spent — dropping them a minute later is
  // how a healthy account used to end up marked expired.
  const calls = serve(() => ok(NEW))
  const site = Object.values(_internal.SITES)[0]
  const locked = { auth: { set: async () => { throw new Error("auth.json is locked") } } }
  const stale = { type: "oauth", access: "old", refresh: "r-locked", uid: "u1", domain: "", expires: Date.now() - 1000 }

  const first = await _internal.fresh(site, locked, stale)
  expect(first.access).toBe("new")
  // past the minute a saved result answers for
  for (const [, v] of _internal.renewed) v.at -= 2 * 60 * 1000
  expect(_internal.renewed.size).toBe(1)
  // the same account asks again: the kept result answers, the spent token is not spent twice
  const again = await _internal.fresh(site, locked, stale)
  expect(again.access).toBe("new")
  expect(refreshes(calls).length).toBe(1)
})
