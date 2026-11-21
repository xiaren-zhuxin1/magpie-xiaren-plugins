// 豆包（Doubao 桌面客户端）作为 magpie provider —— 同时支持两种模式：
//
//   对话模式  POST /samantha/chat/completion   body: messages / completion_option / conversation_id / bot_id
//   工作模式  POST /chat/completion            body: client_meta / messages / option / chat_ability / user_context / ext
//                                             模型在 option.conversation_init_ext.model_item_key，mode_id=3
//
// 两种模式的 SSE 也不一样：
//   对话模式  data: {event_type: 2002|2010|2001|2003, event_data}
//   工作模式  命名事件 id/event/data：SSE_ACK / STREAM_CHUNK / CHUNK_DELTA / SSE_REPLY_END
//
// 两者都必须在已登录的客户端页面里发（服务端按客户端进程 + TLS 指纹放行，
// 外部 fetch 会被判未登录），所以统一经 CDP 在 doubao.com 页面里执行 fetch。

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const PROVIDER = "doubao-web"
const DEFAULT_PORT = Number(process.env.DOUBAO_DEBUG_PORT || 8333)
const BOT_ID = process.env.DOUBAO_BOT_ID || "7338286299411103781"
const APP =
  process.env.DOUBAO_APP ||
  join(process.env.LOCALAPPDATA || "", "Doubao", "Application", "app", "Doubao.exe")
const USER_DATA =
  process.env.DOUBAO_USER_DATA || join(process.env.LOCALAPPDATA || "", "Doubao", "User Data")
const POLL_MS = Number(process.env.DOUBAO_POLL_MS || 70)

const BASE_QUERY = [
  "aid=582478",
  "channel=win",
  "chromium_version=147.0.7727.149",
  "client_platform=pc_client",
  "device_platform=web",
  "doubao_device_platform=desktop",
  "doubao_pc_version=2.37.12",
  "language=zh",
  "pc_version=2.37.12",
  "pkg_type=release_version",
  "real_aid=582478",
  "region=CN",
  "runtime=web",
  "runtime_version=3.46.7",
  "samantha_web=1",
  "sys_region=CN",
  "use-olympus-account=1",
  "version_code=20800",
  "web_platform=desktop",
].join("&")

const FALLBACK_MODELS = {
  "doubao-auto": { name: "豆包（默认）", mode: "1", limit: { context: 128000, output: 8192 } },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 同一段对话前缀的请求排队：同一 conversation 并发会被服务端按 index 拧在一起。
const queues = new Map()
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve()
  const run = prev.then(fn, fn)
  queues.set(key, run.catch(() => {}))
  return run
}

function readLocalState() {
  try {
    return JSON.parse(readFileSync(join(USER_DATA, "Local State"), "utf8"))
  } catch {
    return {}
  }
}

function deviceIdOf() {
  const state = readLocalState()
  return state?.saman?.aha?.device?.device_id || state?.aha?.device?.device_id || ""
}

function webIdOf() {
  const state = readLocalState()
  return String(state?.saman?.web_id || state?.profile?.info_cache?.Default?.saman?.web_id || "")
}

// ---------- CDP ------------------------------------------------------------

function createCdp(port) {
  let socket = null
  let seq = 0
  const waiting = new Map()
  let connecting = null
  let contextId = 0

  const list = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!r.ok) throw new Error(`CDP list ${r.status}`)
    return r.json()
  }

  const connect = async (url) => {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connect timeout")), 8000)
      ws.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connect failed")) }, { once: true })
    })
    ws.addEventListener("message", (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      const w = msg.id && waiting.get(msg.id)
      if (!w) return
      waiting.delete(msg.id)
      msg.error ? w.reject(new Error(JSON.stringify(msg.error))) : w.resolve(msg.result)
    })
    return ws
  }

  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (!socket) return reject(new Error("CDP not connected"))
      const id = ++seq
      waiting.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })

  const attach = async () => {
    if (socket && socket.readyState === 1) return socket
    const targets = await list()
    const frame =
      targets.find((t) => t.type === "iframe" && (t.url || "").includes("doubao.com")) ||
      targets.find((t) => (t.url || "").startsWith("https://www.doubao.com")) ||
      targets.find((t) => (t.url || "").includes("doubao.com"))
    if (frame?.webSocketDebuggerUrl) {
      socket = await connect(frame.webSocketDebuggerUrl)
      return socket
    }
    const page = targets.find((t) => t.type === "page" && (t.url || "").includes("doubao-chat"))
    if (!page?.webSocketDebuggerUrl) throw new Error("豆包客户端里没有可用的 doubao.com 页面（先打开一次对话）")
    socket = await connect(page.webSocketDebuggerUrl)
    const tree = await command("Page.getFrameTree")
    const frames = []
    const walk = (node) => {
      frames.push(node.frame)
      for (const c of node.childFrames || []) walk(c)
    }
    walk(tree.frameTree)
    const target = frames.find((f) => (f.url || "").startsWith("https://www.doubao.com"))
    if (!target) throw new Error("豆包客户端里没有 https://www.doubao.com 子页面")
    const world = await command("Page.createIsolatedWorld", { frameId: target.id, worldName: "magpie-doubao" })
    contextId = world.executionContextId
    return socket
  }

  const evaluate = async (expression, { awaitPromise = false } = {}) => {
    if (!connecting) connecting = attach().finally(() => { connecting = null })
    await connecting
    const params = { expression, returnByValue: true, awaitPromise }
    if (contextId) params.contextId = contextId
    const r = await command("Runtime.evaluate", params)
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "page evaluate failed")
    }
    return r.result?.value
  }

  return { evaluate }
}

// ---------- client lifecycle ----------------------------------------------

let clientStarted = false

async function portAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

async function hasClientProcess() {
  try {
    const { execFileSync } = await import("node:child_process")
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq Doubao.exe", "/NH"], { encoding: "utf8" })
    return /Doubao\.exe/i.test(out)
  } catch {
    return false
  }
}

async function ensureClient(port, log) {
  if (await portAlive(port)) return
  if (clientStarted) {
    for (let i = 0; i < 40; i += 1) {
      await sleep(250)
      if (await portAlive(port)) return
    }
  }
  if (!existsSync(APP)) throw new Error(`找不到豆包客户端：${APP}（用 DOUBAO_APP 指定）`)
  if (await hasClientProcess()) {
    throw new Error("豆包客户端已在运行但没有调试端口。请退出豆包，再由本插件启动（带 --remote-debugging-port）。")
  }
  log(`starting ${APP} --remote-debugging-port=${port}`, "info")
  const child = spawn(APP, [`--remote-debugging-port=${port}`], { detached: true, stdio: "ignore" })
  child.unref?.()
  clientStarted = true
  for (let i = 0; i < 60; i += 1) {
    await sleep(500)
    if (await portAlive(port)) return
  }
  throw new Error("豆包客户端启动后调试端口仍未就绪")
}

// ---------- model menu -----------------------------------------------------

async function fetchModelMenu(cdp) {
  const expr = `(async () => {
    const q = '${BASE_QUERY}';
    const r = await fetch('/alice/slot/action_bar_v3/brief_list?' + q, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Agw-Js-Conv': 'str' },
      body: JSON.stringify({ bot_id: '${BOT_ID}', language_code: 'zh' }), credentials: 'same-origin'
    });
    if (!r.ok) return '[]';
    const j = await r.json();
    const out = [];
    for (const e of (j.data && j.data.entry_list) || []) {
      const list = e && e.active_switch_conf && e.active_switch_conf.menu_conf && e.active_switch_conf.menu_conf.item_list;
      if (!Array.isArray(list)) continue;
      for (const it of list) {
        if (!it || !it.model_item_key || !it.name) continue;
        out.push({ key: String(it.model_item_key), name: String(it.name), mode: String(it.default_mode || '1'), effort: (it.reasoning_effort_config && it.reasoning_effort_config.option_list) || [] });
      }
    }
    return JSON.stringify(out);
  })()`
  const raw = await cdp.evaluate(expr, { awaitPromise: true })
  const list = JSON.parse(raw || "[]")
  return Array.isArray(list) ? list : []
}

// ---------- conversations --------------------------------------------------

function conversationStore(file) {
  let data = {}
  try { data = JSON.parse(readFileSync(file, "utf8")) } catch { data = {} }
  const save = () => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(data, null, 1), "utf8")
    } catch {}
  }
  return {
    get(key) { return data[key]?.conversationId || "" },
    drop(key) { delete data[key]; save() },
    set(key, conversationId) {
      data[key] = { conversationId, at: Date.now() }
      const keys = Object.keys(data)
      if (keys.length > 300) {
        keys.sort((a, b) => (data[a].at || 0) - (data[b].at || 0))
        for (const k of keys.slice(0, keys.length - 300)) delete data[k]
      }
      save()
    },
  }
}

const convFile =
  process.env.DOUBAO_CONVERSATIONS || join(homedir(), ".config", "magpie", "doubao-web-conversations.json")

// ---------- helpers --------------------------------------------------------

const textOf = (content) => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("")
  return ""
}

// 文本工具协议：豆包不接受 OpenAI 的 tools，所以把工具清单写进提示，模型用
// <tool_call>{…}</tool_call> 回答，插件再还原成 tool_calls。
function toolsHeader(tools) {
  const lines = tools
    .map((t) => {
      const f = t?.function || t
      return `- ${f?.name}: ${f?.description || ""}；参数 ${JSON.stringify(f?.parameters || {})}`
    })
    .join("\n")
  return `你可以调用以下工具。调用时只输出 <tool_call>{"name":"工具名","arguments":{...}}</tool_call>，可以一次多个，不要解释、不要代码围栏。不需要工具时直接用自然语言回答。\n${lines}`
}

function parseToolCalls(text) {
  const out = []
  const seen = new Set()
  const re = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g
  let m
  while ((m = re.exec(String(text || "")))) {
    try {
      const j = JSON.parse(m[1])
      if (!j || !j.name) continue
      const key = j.name + JSON.stringify(j.arguments ?? {})
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name: String(j.name), arguments: typeof j.arguments === "string" ? j.arguments : JSON.stringify(j.arguments ?? {}) })
    } catch {}
  }
  return out
}

function stripToolCalls(text) {
  return String(text || "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/```(?:json)?\s*\{\s*"name"[\s\S]*?\}\s*```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function buildTurn(messages, conversationId) {
  const tail = messages[messages.length - 1]
  if (tail && tail.role === "tool") {
    const name = tail.name || tail.tool_call_id || "tool"
    return { text: `工具 ${name} 的结果：\n${textOf(tail.content)}`, needCreate: false }
  }
  const last = [...messages].reverse().find((m) => m.role === "user")
  const userText = textOf(last?.content)
  if (conversationId) return { text: userText, needCreate: false }
  const sys = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n").trim()
  const history = messages
    .filter((m) => m.role !== "system" && m !== last)
    .map((m) => `${m.role === "assistant" ? "assistant" : "user"}: ${textOf(m.content)}`)
    .filter((line) => line.trim().length > 3)
    .join("\n")
  const head = [sys ? `[系统指令，优先遵守]\n${sys}` : "", history ? `[此前对话]\n${history}` : "", userText]
    .filter(Boolean)
    .join("\n\n")
  return { text: head, needCreate: true }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } })
}

function openaiError(message, status, code) {
  return jsonResponse({ error: { message, type: "doubao_error", code: code ?? String(status) } }, status)
}

const sha1 = (s) => createHash("sha1").update(s).digest("hex")

// 思考等级：brief_list 每个模型带 reasoning_effort_config.option_list，
// 名字是中文（低/中/高/极高/最高），level 是数字（3/4/5/6/7）—— 后者才发给
// 服务端。magpie 读模型行的 variants（键是等级名），值就是发下去的那个 effort。
const EFFORT_KEYS = { 低: "low", 中: "medium", 高: "high", 极高: "xhigh", 最高: "max" }
const EFFORT_BY_KEY = { low: "3", medium: "4", high: "5", xhigh: "6", max: "7", none: "" }

function variantsOf(efforts) {
  if (!Array.isArray(efforts) || !efforts.length) return undefined
  const out = {}
  for (const e of efforts) {
    const key = EFFORT_KEYS[String(e?.name ?? "").trim()]
    if (!key || e?.level === undefined) continue
    out[key] = { reasoning_effort: String(e.level) }
  }
  return Object.keys(out).length ? out : undefined
}

function effortOf(body) {
  const asked = body?.reasoning_effort ?? body?.reasoning?.effort ?? body?.reasoning
  if (asked === undefined || asked === null || asked === "") return ""
  const s = String(asked).trim().toLowerCase()
  if (/^\d+$/.test(s)) return s
  const mapped = EFFORT_BY_KEY[s]
  return mapped === undefined ? "" : mapped
}
const estimate = (text) => Math.max(0, Math.round(String(text || "").length / 1.6))

function registerPrefix(convs, model, messages, reply, conv, prefixKey) {
  if (!conv) return
  convs.set(prefixKey, conv)
  if (!reply) return
  convs.set(sha1(JSON.stringify([model, [...messages, { role: "assistant", content: reply }]])), conv)
}

function mapClientError(text) {
  const t = String(text)
  if (/登录|login invalid|user invalid|Invalid User ID|7100120/i.test(t))
    return openaiError("豆包登录失效，请在客户端里重新登录：" + t.slice(0, 200), 401, "login_invalid")
  if (/无权|not allowed|permission denied|TM\.000010051|forbidden|403/i.test(t))
    return openaiError("豆包账号对这个模型没有权限：" + t.slice(0, 200), 403, "model_forbidden")
  if (/会话不存在|conversation.*(not found|invalid)|7100(0|1)0|404/i.test(t))
    return openaiError("豆包会话已失效：" + t.slice(0, 200), 404, "conversation_lost")
  if (/限流|rate.?limit|too many|429|throttl/i.test(t))
    return openaiError("豆包限流：" + t.slice(0, 200), 429, "rate_limited")
  if (/sandbox|云电脑|未就绪|503|unavailable/i.test(t))
    return openaiError("豆包工作模式环境未就绪：" + t.slice(0, 200), 503, "sandbox_not_ready")
  if (/710010202|系统错误/.test(t)) return openaiError("豆包返回系统错误：" + t.slice(0, 200), 502, "client_error")
  return openaiError("豆包拒绝请求：" + t.slice(0, 300), 502, "client_error")
}

function uuid() {
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")
  return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`
}

// ---------- page-side stream runners --------------------------------------

function workStartScript(sid, query, payload) {
  return `(() => {
    window.__magpieDoubao = window.__magpieDoubao || {};
    const id = ${JSON.stringify(sid)};
    const state = window.__magpieDoubao[id] = { buf: "", sent: 0, done: false, err: null, conv: "", final: "", delta: false };
    (async () => {
      try {
        const ac = new AbortController();
        window.__magpieDoubaoAbort = window.__magpieDoubaoAbort || {};
        window.__magpieDoubaoAbort[id] = () => ac.abort();
        const r = await fetch("/chat/completion?" + ${JSON.stringify(query)}, {
          method: "POST",
          headers: { "content-type": "application/json", "Agw-Js-Conv": "str" },
          body: ${JSON.stringify(JSON.stringify(payload))},
          credentials: "same-origin",
          signal: ac.signal
        });
        if (!r.ok || !r.body) { state.err = "HTTP " + r.status + " " + (await r.text()).slice(0, 800); state.done = true; return; }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let tail = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          tail += dec.decode(value, { stream: true });
          let i;
          while ((i = tail.indexOf("\\n\\n")) >= 0) {
            const block = tail.slice(0, i); tail = tail.slice(i + 2);
            const evLine = block.split("\\n").find((l) => l.startsWith("event:"));
            const dataLine = block.split("\\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const ev = evLine ? evLine.slice(6).trim() : "";
            let o; try { o = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
            if (ev === "SSE_ACK") {
              const m = o && o.ack_client_meta;
              if (m && m.conversation_id && !state.conv) state.conv = String(m.conversation_id);
            }
            if (ev === "CHUNK_DELTA" && o && typeof o.text === "string" && o.text) {
              state.delta = true;
              state.buf += o.text;
            }
            if (ev === "STREAM_CHUNK" && o && Array.isArray(o.patch_op) && !state.delta) {
              for (const op of o.patch_op) {
                const blocks = op && op.patch_value && op.patch_value.content_block;
                if (!Array.isArray(blocks)) continue;
                for (const b of blocks) {
                  if (!b || b.block_type !== 10000) continue;
                  const t = b.content && b.content.text_block && b.content.text_block.text;
                  if (typeof t === "string" && t) state.buf += t;
                }
              }
            }
            if (ev === "SSE_REPLY_END") {
              if (o && o.end_type === 1 && o.msg_finish_attr && o.msg_finish_attr.brief) state.final = String(o.msg_finish_attr.brief);
              if (o && o.end_type === 2) state.done = true;
            }
            if (ev === "STREAM_ERROR" || ev === "SSE_ERROR") state.err = JSON.stringify(o).slice(0, 300);
          }
          if (state.done) break;
        }
        state.done = true;
      } catch (e) {
        state.err = String((e && e.message) || e);
        state.done = true;
      }
    })();
    return "ok";
  })()`
}

function chatStartScript(sid, query, payload) {
  return `(() => {
    window.__magpieDoubao = window.__magpieDoubao || {};
    const id = ${JSON.stringify(sid)};
    const state = window.__magpieDoubao[id] = { buf: "", sent: 0, done: false, err: null, conv: "", final: "", delta: false };
    (async () => {
      try {
        const ac = new AbortController();
        window.__magpieDoubaoAbort = window.__magpieDoubaoAbort || {};
        window.__magpieDoubaoAbort[id] = () => ac.abort();
        const r = await fetch("/samantha/chat/completion?" + ${JSON.stringify(query)}, {
          method: "POST",
          headers: { "content-type": "application/json", "Agw-Js-Conv": "str" },
          body: ${JSON.stringify(JSON.stringify(payload))},
          credentials: "same-origin",
          signal: ac.signal
        });
        if (!r.ok || !r.body) { state.err = "HTTP " + r.status + " " + (await r.text()).slice(0, 800); state.done = true; return; }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let tail = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          tail += dec.decode(value, { stream: true });
          let i;
          while ((i = tail.indexOf("\\n\\n")) >= 0) {
            const block = tail.slice(0, i); tail = tail.slice(i + 2);
            const line = block.split("\\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            let o; try { o = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (!o || o.event_type === undefined) continue;
            let ed = o.event_data;
            if (typeof ed === "string") { try { ed = JSON.parse(ed); } catch {} }
            if (ed && ed.conversation_id && !state.conv) state.conv = String(ed.conversation_id);
            if (o.event_type === 2001) {
              const c = ed && ed.message && ed.message.content;
              if (typeof c === "string") { let t = ""; try { t = JSON.parse(c).text || ""; } catch { t = c; } if (t) state.buf += t; }
              else if (c && typeof c.text === "string") state.buf += c.text;
            }
            if (o.event_type === 2003) state.done = true;
            if (o.event_type === 2004 || o.event_type === 2005) {
              const m = ed && (ed.message || ed.toast || ed.err_msg);
              if (m) state.err = typeof m === "string" ? m : JSON.stringify(m).slice(0, 300);
            }
          }
          if (state.done) break;
        }
        state.done = true;
      } catch (e) {
        state.err = String((e && e.message) || e);
        state.done = true;
      }
    })();
    return "ok";
  })()`
}

const pollScript = (sid) => `(() => {
  const s = window.__magpieDoubao && window.__magpieDoubao[${JSON.stringify(sid)}];
  if (!s) return JSON.stringify({ missing: true });
  const chunk = s.buf.slice(s.sent);
  s.sent = s.buf.length;
  const out = { chunk, done: s.done, err: s.err, conv: s.conv, final: s.final };
  if (s.done) { delete window.__magpieDoubao[${JSON.stringify(sid)}]; }
  return JSON.stringify(out);
})()`

// ---------- request handling ----------------------------------------------

async function streamTurn(cdp, sid, script, opts) {
  const started = await cdp.evaluate(script)
  if (started !== "ok") throw new Error("豆包页面没有接受请求：" + String(started))
  const abort = opts.signal
  let acc = ""
  let final = ""
  let conv = opts.known
  let err = null
  const maxIter = opts.stream ? 1800 : 900
  for (let i = 0; i < maxIter; i += 1) {
    await sleep(POLL_MS)
    if (abort?.aborted) {
      try {
        await cdp.evaluate(
          `(() => { const f = window.__magpieDoubaoAbort && window.__magpieDoubaoAbort[${JSON.stringify(sid)}]; if (f) f(); delete (window.__magpieDoubaoAbort || {})[${JSON.stringify(sid)}]; return "aborted" })()`,
        )
      } catch {}
      break
    }
    let s
    try { s = JSON.parse(await cdp.evaluate(pollScript(sid))) } catch (e) { err = String(e?.message || e); break }
    if (s.missing) break
    if (s.chunk) {
      acc += s.chunk
      if (opts.onChunk) opts.onChunk(s.chunk)
    }
    if (s.final) final = s.final
    if (s.conv) conv = s.conv
    if (s.err) { err = s.err; break }
    if (s.done) break
  }
  if (!acc && final) acc = final
  return { acc, final, conv, err }
}

async function handleChat(cdp, convs, input, init, log) {
  const url = typeof input === "string" ? input : input?.url ?? String(input)
  if (!/chat\/completions/.test(url)) return openaiError("unsupported path " + url, 404, "unsupported")
  let body
  try {
    const raw = init?.body instanceof ReadableStream ? await new Response(init.body).text() : init?.body
    body = typeof raw === "string" ? JSON.parse(raw) : raw ?? {}
  } catch {
    return openaiError("bad request body", 400, "bad_request")
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (!messages.length) return openaiError("messages is empty", 400, "bad_request")

  const model = String(body.model || "doubao-auto").split("/").pop()
  const stream = body.stream !== false
  const mode = log.modelMode?.(model) || "1"
  const effort = effortOf(body)
  const wantsTools = !!log.toolsProtocol && Array.isArray(body.tools) && body.tools.length > 0

  const prefixKey = sha1(JSON.stringify([model, messages.slice(0, -1)]))
  const known = convs.get(prefixKey)
  const turn = buildTurn(messages, known)
  if (wantsTools) turn.text = `${toolsHeader(body.tools)}\n\n用户请求：${turn.text}`

  const device = deviceIdOf()
  const query = [BASE_QUERY, `device_id=${encodeURIComponent(device)}`, `tea_uuid=${encodeURIComponent(device)}`, `fp=verify_${encodeURIComponent(device)}`].join("&")

  const sid = "db" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

  let script
  if (mode === "3") {
    // 工作模式：/chat/completion，模型在 option.conversation_init_ext
    const lid = uuid()
    const payload = {
      client_meta: {
        conversation_id: turn.needCreate ? "" : known,
        local_conversation_id: "local_16" + String(Date.now()).slice(-14),
        bot_id: BOT_ID,
        last_section_id: "",
        last_message_index: null,
        local_permissions: [],
      },
      messages: [
        {
          local_message_id: lid,
          content_block: [
            {
              block_type: 10000,
              block_id: uuid(),
              parent_id: "",
              content: { text_block: { text: turn.text, icon_url: "", icon_url_dark: "", summary: "" }, pc_event_block: "" },
              meta_info: [],
              extra_info: {},
              append_fields: [],
            },
          ],
          message_status: 0,
        },
      ],
      option: {
        send_message_scene: "",
        create_time_ms: Date.now(),
        collect_id: "",
        is_audio: false,
        answer_with_suggest: false,
        agent_mode: 1,
        tts_switch: false,
        need_deep_think: 10001,
        click_clear_context: false,
        from_suggest: false,
        is_regen: false,
        is_replace: false,
        is_from_click_option: false,
        is_from_click_softlink: false,
        disable_sse_cache: false,
        select_text_action: "",
        is_select_text: false,
        resend_for_regen: false,
        scene_type: 0,
        unique_key: uuid(),
        start_seq: 0,
        need_create_conversation: turn.needCreate,
        conversation_init_option: { project_id: "", need_ack_conversation: true },
        conversation_init_ext: { model_item_key: model, reasoning_effort: effort || "5", mode_id: "3" },
        regen_query_id: [],
        edit_query_id: [],
        regen_instruction: "",
        no_replace_for_regen: false,
        message_from: 0,
        shared_app_name: "",
        shared_app_id: "",
        sse_recv_event_options: { support_chunk_delta: true },
        support_lazy_fetch_stream: true,
        is_ai_playground: false,
        is_old_user: true,
      },
      chat_ability: {},
      user_context: [],
      ext: {
        agent_mode: "1",
        bot_id: BOT_ID,
        bot_source: "BotStudio",
        brief: turn.text.slice(0, 60),
        chat_next: "1",
        client_report_scene: "gui",
        cot_switch: "10001",
        is_finish: "1",
        input_skill: JSON.stringify({ skill_id: "0", skill_type: 0 }),
      },
    }
    script = workStartScript(sid, query, payload)
  } else {
    // 对话模式：/samantha/chat/completion
    const payload = {
      messages: [{ role: "user", content: JSON.stringify({ text: turn.text }), content_type: 2001 }],
      completion_option: {
        is_regen: false,
        with_suggest: false,
        need_create_conversation: turn.needCreate,
        launch_stage: 1,
        event_id: "0",
        ...(effort ? { reasoning_effort: effort } : {}),
      },
      conversation_id: turn.needCreate ? "0" : known,
      local_conversation_id: "local_16" + String(Date.now()).slice(-14),
      bot_id: BOT_ID,
    }
    script = chatStartScript(sid, query, payload)
  }

  let emit = null
  if (stream) {
    const enc = new TextEncoder()
    const created = Math.floor(Date.now() / 1000)
    const streamBody = new ReadableStream({
      async start(controller) {
        const push = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
        push({ id: "chatcmpl-" + sid, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })
        let res
        try {
          res = await enqueue(prefixKey, () =>
            streamTurn(cdp, sid, script, {
              stream: true,
              signal: init?.signal,
              known,
              onChunk: wantsTools
                ? undefined
                : (chunk) =>
                    push({ id: "chatcmpl-" + sid, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] }),
            }),
          )
        } catch (e) {
          res = { err: String(e?.message || e), acc: "", conv: known }
        }
        const calls = wantsTools && !res.err ? parseToolCalls(res.acc) : []
        const visible = calls.length ? stripToolCalls(res.acc) : res.acc
        registerPrefix(convs, model, messages, visible, res.conv || known, prefixKey)
        if (res.err) {
          push({ error: { message: res.err, type: "doubao_error" } })
        } else {
          if (wantsTools && visible) {
            push({ id: "chatcmpl-" + sid, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: visible }, finish_reason: null }] })
          }
          if (calls.length) {
            push({
              id: "chatcmpl-" + sid,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: calls.map((c, i) => ({
                      index: i,
                      id: "call_" + sid + "_" + i,
                      type: "function",
                      function: { name: c.name, arguments: c.arguments },
                    })),
                  },
                  finish_reason: null,
                },
              ],
            })
          }
          push({
            id: "chatcmpl-" + sid,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }],
          })
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"))
        controller.close()
      },
    })
    return new Response(streamBody, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    })
  }

  let res
  try {
    res = await enqueue(prefixKey, () => streamTurn(cdp, sid, script, { stream: false, signal: init?.signal, known }))
  } catch (e) {
    return openaiError(String(e?.message || e), 502, "client_error")
  }
  if (res.err) return mapClientError(res.err)
  const calls = wantsTools ? parseToolCalls(res.acc) : []
  const visible = calls.length ? stripToolCalls(res.acc) : res.acc
  registerPrefix(convs, model, messages, visible, res.conv || known, prefixKey)
  const prompt = estimate(turn.text)
  const completion = estimate(res.acc)
  return jsonResponse({
    id: "chatcmpl-" + sid,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: visible,
          ...(calls.length
            ? {
                tool_calls: calls.map((c, i) => ({
                  id: "call_" + sid + "_" + i,
                  type: "function",
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        },
        finish_reason: calls.length ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  })
}

// ---------- plugin ---------------------------------------------------------

export const DoubaoPlugin = async ({ client } = {}, options = {}) => {
  const logFn = (message, level = "info") => {
    try { void client?.app?.log?.({ body: { service: "doubao", level, message } })?.catch?.(() => {}) } catch {}
  }
  const port = Number(options?.port || DEFAULT_PORT)
  const toolsProtocol = options?.toolsProtocol !== false
  const cdp = createCdp(port)
  const convs = conversationStore(convFile)
  let ready = null
  let menu = { at: 0, list: [] }

  const ensure = async () => {
    if (!ready) ready = ensureClient(port, logFn).finally(() => { ready = null })
    await ready
    return cdp
  }

  const modeOf = (modelId) => {
    const hit = menu.list.find((m) => m.key === modelId)
    return hit?.mode || (String(modelId).startsWith("person-") || modelId === "9" || modelId === "5" || modelId === "seed-lite-7b" ? "3" : "1")
  }

  const modelRow = (m) => {
  const variants = variantsOf(m.effort)
  return {
    name: m.name,
    limit: { context: 128000, output: 8192 },
    tool_call: toolsProtocol,
    attachment: false,
    reasoning: !!variants,
    ...(variants ? { variants } : {}),
    modalities: { input: ["text"], output: ["text"] },
  }
}

  return {
    provider: {
      id: PROVIDER,
      async models() {
        try {
          if (Date.now() - menu.at > 10 * 60_000 || !menu.list.length) {
            const conn = await ensure()
            menu = { at: Date.now(), list: await fetchModelMenu(conn) }
            if (menu.list.length) logFn(`model menu (${menu.list.length}): ${menu.list.map((m) => `${m.name}[${m.mode}]`).join(" / ")}`, "info")
          }
          if (menu.list.length) return Object.fromEntries(menu.list.map((m) => [m.key, modelRow(m)]))
        } catch (e) {
          logFn(`model menu unavailable: ${e?.message || e}`, "warn")
        }
        return Object.fromEntries(Object.entries(FALLBACK_MODELS).map(([id, m]) => [id, modelRow(m)]))
      },
    },
    auth: {
      provider: PROVIDER,
      methods: [{ type: "api", label: "本机豆包客户端（已登录即可，随便填）", placeholder: "local" }],
      maxConcurrency: Number(options?.maxConcurrency || 3),
      async loader(getAuth) {
        try { await getAuth() } catch {}
        logFn.modelMode = modeOf
        logFn.toolsProtocol = toolsProtocol
        return {
          baseURL: "https://doubao.local/v1",
          async fetch(input, init = {}) {
            const conn = await ensure()
            return handleChat(conn, convs, input, init, logFn)
          },
        }
      },
      async usage() {
        return { windows: [] }
      },
    },
  }
}

export const _internal = { buildTurn, textOf, conversationStore, mapClientError, FALLBACK_MODELS }