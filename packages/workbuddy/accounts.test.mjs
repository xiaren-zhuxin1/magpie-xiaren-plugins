// Two accounts of one site, and an account the vendor is refusing: the two cases
// the record key and the window card got wrong.
import { test, expect, afterEach } from "bun:test"
import { WorkBuddyAuthPlugin, _internal as I } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  I.seenIdentities.clear()
  I.renewing.clear()
  I.renewed.clear()
})

const site = Object.values(I.SITES)[0]

function serving() {
  const calls = []
  let n = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), refresh: new Headers(init?.headers ?? {}).get("x-refresh-token") })
    n += 1
    return new Response(JSON.stringify({ code: 0, msg: "ok", data: { accessToken: `a${n}`, refreshToken: `r${n}`, expiresIn: 3600 } }),
      { headers: { "content-type": "application/json" } })
  }
  return calls
}

const stale = (uid, refresh) => ({ type: "oauth", access: "old", refresh, uid, expires: Date.now() - 1000 })

test("two accounts of one site never write the one record key: the second keeps its tokens in memory", async () => {
  const calls = serving()
  const written = []
  const client = { auth: { set: async (x) => written.push({ id: x.path.id, uid: x.body?.uid }) } }

  const ash = await I.fresh(site, client, stale("u-ash", "r-ash"))
  expect(ash.access).toBe("a1")
  expect(written).toEqual([{ id: site.id, uid: "u-ash" }])

  // A second account of the same site: the site's own key is Ash's record, so
  // writing there would replace it. Its tokens are kept, not dropped.
  const blair = await I.fresh(site, client, stale("u-blair", "r-blair"))
  expect(blair.access).toBe("a2")
  expect(written.length).toBe(1)
  expect(written[0].uid).toBe("u-ash")
  // past the minute a saved result answers for, Blair's kept result still answers
  for (const [, v] of I.renewed) v.at -= 2 * 60 * 1000
  const again = await I.fresh(site, client, stale("u-blair", "r-blair"))
  expect(again.access).toBe("a2")
  expect(calls.length).toBe(2)
})

test("an account the vendor is refusing shows its window even with no answered row of its own", () => {
  const now = Date.parse("2026-11-02T12:00:00+08:00")
  const win = I.FREE_WINDOW_AI
  const soon = now + 12 * 3600 * 1000
  const refusal = {
    provider: win.provider,
    providerAccount: "me@example.com",
    model: win.model,
    status: 429,
    t: new Date(now - 60_000).toISOString(),
    restUntil: soon,
  }
  const card = I.freeWindowOf([refusal], "me@example.com", now, win)
  expect(card).not.toBeNull()
  expect(card.used).toBe(100)
  expect(card.resetsAt).toBe(new Date(soon).toISOString())
  // a refusal whose window has already passed opens nothing
  expect(I.freeWindowOf([{ ...refusal, restUntil: now - 1000 }], "me@example.com", now, win)).toBeNull()
})

test("a China-build domain is named by the AI build, workbuddy.cn included", () => {
  const ai = { ...site, ai: true }
  expect(I.otherSite(ai, { domain: "www.workbuddy.cn" })).toBe(I.SITES.workbuddy.name)
  expect(I.otherSite(ai, { domain: "copilot.tencent.com" })).toBe(I.SITES.workbuddy.name)
  expect(I.otherSite(ai, { domain: "www.workbuddy.ai" })).toBe("")
})
