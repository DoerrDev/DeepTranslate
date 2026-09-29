// 负责：快捷键/图标点击 -> 通知 content；接收翻译请求（缓存 + 重试 + 调用 LLM）
importScripts("defaults.js");

function buildPrompt(st) {
  return `你是专业的翻译引擎。将用户给出的 JSON 数组中每个 text 翻译成${st.targetLang}。
规则：
1. 只输出一个 JSON 对象，格式严格为 {"translations":[{"id":<原id>,"text":"<译文>"}]}，不要输出任何其他内容、不要使用代码块。
2. id 必须与输入一一对应，数量一致。
3. 保持专有名词、代码、URL、数字原样；译文自然流畅。
4. 如果某段本身无需翻译，text 原样返回。
5. 数组中的各段来自同一网页且按顺序相连，请结合上下文翻译，并保持术语前后一致。` +
    (st.extraPrompt ? `\n6. 额外要求：${st.extraPrompt}` : "");
}

// ---------- 快捷键 ----------
function toggle(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "toggle" }).catch(() => {});
}
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "toggle-translate") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) toggle(tab.id);
});

// ---------- IndexedDB 译文缓存 ----------
const STORE = "t", CACHE_LIMIT = 30000;
let dbp;
function db() {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open("dt-cache", 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
async function cacheGet(keys) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, "readonly"), s = tx.objectStore(STORE), out = new Map();
    keys.forEach((k) => { s.get(k).onsuccess = (e) => e.target.result && out.set(k, e.target.result); });
    tx.oncomplete = () => res(out);
    tx.onerror = () => rej(tx.error);
  });
}
async function cachePut(entries) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, "readwrite"), s = tx.objectStore(STORE);
    entries.forEach(([k, v]) => s.put(v, k));
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function cacheClear() {
  const d = await db();
  return new Promise((res) => { const tx = d.transaction(STORE, "readwrite"); tx.objectStore(STORE).clear(); tx.oncomplete = res; });
}
async function cachePrune() {
  const d = await db();
  const n = await new Promise((res) => { const r = d.transaction(STORE).objectStore(STORE).count(); r.onsuccess = () => res(r.result); });
  if (n > CACHE_LIMIT) await cacheClear();
}
cachePrune().catch(() => {});

async function hash(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------- LLM 调用 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseJson(s) {
  s = s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error("无法解析模型返回的 JSON");
}

async function callLLM(items, cfg, st) {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90000);
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
          body: JSON.stringify({
            model: cfg.model,
            temperature: st.temperature,
            messages: [
              { role: "system", content: buildPrompt(st) },
              { role: "user", content: JSON.stringify(items) },
            ],
          }),
        });
      } finally { clearTimeout(timer); }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        err.retry = res.status === 429 || res.status >= 500;
        err.wait = (Number(res.headers.get("retry-after")) || 0) * 1000;
        throw err;
      }
      const content = (await res.json()).choices?.[0]?.message?.content;
      if (!content) throw new Error("模型返回为空");
      const out = parseJson(content).translations;
      if (!Array.isArray(out)) throw new Error("返回格式不含 translations 数组");
      return out;
    } catch (e) {
      lastErr = e;
      if (e.retry === false || attempt === 2) break;
      await sleep(e.wait || 1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

// 翻译一组 {id,text}：先查缓存、按文本去重，再调用模型，缺失的段落补请求一次
async function translate(items, { noCache = false } = {}) {
  const { config, settings } = await chrome.storage.local.get(["config", "settings"]);
  const st = mergeSettings(settings);
  if (!config || !config.baseUrl || !config.apiKey || !config.model) {
    chrome.runtime.openOptionsPage();
    throw new Error("未配置 AI：请在选项页导入 secret.properties");
  }

  // 去重：相同文本只翻译一次
  const byText = new Map();
  for (const it of items) {
    if (!byText.has(it.text)) byText.set(it.text, []);
    byText.get(it.text).push(it.id);
  }
  const uniq = [...byText.keys()];
  const keys = await Promise.all(uniq.map((t) => hash([st.targetLang, config.model, st.extraPrompt, t].join("\n"))));

  const result = new Map();   // text -> 译文
  const cacheHit = new Set();
  let cached = 0;
  if (!noCache) {
    try {
      const hit = await cacheGet(keys);
      uniq.forEach((t, i) => { const h = hit.get(keys[i]); if (h) { result.set(t, h.v); cacheHit.add(t); cached += byText.get(t).length; } });
    } catch {}
  }

  let todo = uniq.filter((t) => !result.has(t));
  for (let round = 0; round < 2 && todo.length; round++) {
    const req = todo.map((t, i) => ({ id: i, text: t }));
    const out = await callLLM(req, config, st);
    const map = new Map(out.map((o) => [String(o.id), o.text]));
    todo.forEach((t, i) => { const v = map.get(String(i)); if (typeof v === "string" && v) result.set(t, v); });
    todo = todo.filter((t) => !result.has(t));
  }

  if (!noCache) {
    const puts = [];
    uniq.forEach((t, i) => { if (result.has(t) && !cacheHit.has(t)) puts.push([keys[i], { v: result.get(t), t: Date.now() }]); });
    if (puts.length) cachePut(puts).catch(() => {});
  }

  const translations = [];
  for (const [text, ids] of byText) if (result.has(text)) ids.forEach((id) => translations.push({ id, text: result.get(text) }));
  return { translations, cached };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "translate" || msg.type === "test") {
    translate(msg.items, { noCache: msg.type === "test" })
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.type === "clearCache") {
    cacheClear().then(() => sendResponse({ ok: true }));
    return true;
  }
});
