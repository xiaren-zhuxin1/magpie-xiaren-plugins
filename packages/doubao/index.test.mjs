// The parts of the Doubao provider that need no browser: what a turn sends, what
// a client fault becomes, and the conversation ids kept between calls.
import { test, expect, afterAll } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROVIDER, DoubaoPlugin, _internal as I } from "./index.mjs"

const home = mkdtempSync(join(tmpdir(), "doubao-test-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))

test("the provider is doubao-web, signed in as an api key held by the client", async () => {
  const plugin = await DoubaoPlugin({ client: {} }, {})
  expect(PROVIDER).toBe("doubao-web")
  expect(plugin.provider.id).toBe("doubao-web")
  expect(plugin.auth.provider).toBe("doubao-web")
  // the sign-in is the desktop client's own session: nothing to type
  expect(plugin.auth.methods.length).toBe(1)
  expect(plugin.auth.methods[0].type).toBe("api")
  // the vendor's own cap
  expect(plugin.auth.maxConcurrency).toBe(3)
  const tighter = await DoubaoPlugin({ client: {} }, { maxConcurrency: 1 })
  expect(tighter.auth.maxConcurrency).toBe(1)
  expect(typeof plugin.provider.models).toBe("function")
  expect(typeof plugin.auth.loader).toBe("function")
})

test("textOf reads a string, a list of parts, or nothing", () => {
  expect(I.textOf("plain")).toBe("plain")
  expect(I.textOf([{ text: "a" }, { text: "b" }])).toBe("ab")
  expect(I.textOf(["a", { text: "b" }])).toBe("ab")
  expect(I.textOf([{ type: "image" }])).toBe("")
  expect(I.textOf(null)).toBe("")
  expect(I.textOf(undefined)).toBe("")
  expect(I.textOf({ text: "not a list" })).toBe("")
})

test("a turn inside a known conversation sends only what the user just said", () => {
  const messages = [
    { role: "system", content: "be terse" },
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second question" },
  ]
  const turn = I.buildTurn(messages, "conv-1")
  expect(turn.needCreate).toBe(false)
  expect(turn.text).toBe("second question")
})

test("a first turn carries the system instruction and the history it has", () => {
  const messages = [
    { role: "system", content: "be terse" },
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second question" },
  ]
  const turn = I.buildTurn(messages, "")
  expect(turn.needCreate).toBe(true)
  expect(turn.text.includes("be terse")).toBe(true)
  expect(turn.text.includes("user: first question")).toBe(true)
  expect(turn.text.includes("assistant: first answer")).toBe(true)
  // the newest user turn is the message itself, not part of the history
  expect(turn.text.endsWith("second question")).toBe(true)
  expect(turn.text.split("second question").length).toBe(2)
})

test("a tool result goes back as its own turn, naming the tool that ran", () => {
  const turn = I.buildTurn([
    { role: "user", content: "read the file" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "read_file" } }] },
    { role: "tool", name: "read_file", tool_call_id: "c1", content: "the file says hello" },
  ], "conv-1")
  expect(turn.needCreate).toBe(false)
  expect(turn.text.includes("read_file")).toBe(true)
  expect(turn.text.includes("the file says hello")).toBe(true)
  // a tool result with no name falls back to its call id, not to a crash
  const unnamed = I.buildTurn([{ role: "tool", tool_call_id: "c9", content: "x" }], "conv-1")
  expect(unnamed.text.includes("c9")).toBe(true)
})

test("a client fault becomes the OpenAI-shaped error magpie routes on", async () => {
  const cases = [
    ["Invalid User ID", 401, "login_invalid"],
    ["permission denied for this model", 403, "model_forbidden"],
    ["conversation not found", 404, "conversation_lost"],
    ["too many requests", 429, "rate_limited"],
    ["service unavailable", 503, "sandbox_not_ready"],
  ]
  for (const [text, status, code] of cases) {
    const res = I.mapClientError(text)
    expect(res.status).toBe(status)
    const body = await res.json()
    expect(body.error.code).toBe(code)
    expect(body.error.type).toBe("doubao_error")
    // the vendor's own words are kept, cut
    expect(typeof body.error.message).toBe("string")
    expect(body.error.message.length).toBeGreaterThan(0)
  }
  // something unrecognised is still an error, never a success
  const other = I.mapClientError("something else entirely")
  expect(other.status).toBe(502)
  expect((await other.json()).error.code).toBe("client_error")
})

test("conversation ids are kept, dropped, and capped", () => {
  const file = join(home, "convs.json")
  const store = I.conversationStore(file)
  expect(store.get("k1")).toBe("")
  store.set("k1", "conv-1")
  expect(store.get("k1")).toBe("conv-1")
  // a second store over the same file reads what the first wrote
  expect(I.conversationStore(file).get("k1")).toBe("conv-1")
  store.drop("k1")
  expect(store.get("k1")).toBe("")
  expect(JSON.parse(readFileSync(file, "utf8")).k1).toBeUndefined()

  // 300 ids are kept, the oldest dropped: one per conversation, not per request
  for (let i = 0; i < 320; i++) store.set(`key-${i}`, `conv-${i}`)
  const kept = JSON.parse(readFileSync(file, "utf8"))
  expect(Object.keys(kept).length).toBe(300)
  expect(kept["key-0"]).toBeUndefined()
  expect(kept["key-319"].conversationId).toBe("conv-319")

  // a file that is not JSON is tolerated, not fatal
  writeFileSync(file, "{not json", "utf8")
  const broken = I.conversationStore(file)
  expect(broken.get("key-319")).toBe("")
})

test("the models offered without the client are a real row each", () => {
  const models = I.FALLBACK_MODELS
  expect(Object.keys(models).length).toBeGreaterThan(0)
  for (const [id, m] of Object.entries(models)) {
    expect(typeof id).toBe("string")
    expect(typeof m.name).toBe("string")
    expect(m.limit.context).toBeGreaterThan(0)
    expect(m.limit.output).toBeGreaterThan(0)
    expect(typeof m.mode).toBe("string")
  }
  // `models()` asks the client first; with none it serves this table, so every
  // entry has to carry what a row needs. (Asking here would wait on a CDP
  // connect — ten seconds for one assertion.)
  for (const m of Object.values(models)) {
    expect(Number.isFinite(m.limit.context)).toBe(true)
    expect(Number.isFinite(m.limit.output)).toBe(true)
  }
})