const $ = (id) => document.getElementById(id);
const CFG = ["baseUrl", "apiKey", "model"];
const TEXT = ["userLang", "textColor", "extraPrompt"];
const NUM = ["concurrency", "maxItems", "maxChars", "temperature"];
const ALIASES = {
  baseUrl: ["baseurl", "base_url", "base-url", "url", "endpoint", "api.url", "api_url", "apiurl", "host_api", "api_host", "host"],
  apiKey: ["apikey", "api_key", "api-key", "key", "token", "api_token", "apitoken"],
  model: ["model", "model_name", "modelname"],
};

function parseProps(text) {
  const kv = {};
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const m = line.match(/^([^=:]+?)\s*[=:]\s*(.*)$/);
    if (m) kv[m[1].trim().toLowerCase()] = m[2].trim();
  }
  const cfg = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    // 精确别名优先，其次以别名结尾的键 (如 POE_TOKEN)
    const hit = Object.keys(kv).find((k) => names.includes(k)) ||
                Object.keys(kv).find((k) => names.some((n) => k.endsWith("." + n) || k.endsWith("_" + n)));
    if (hit) cfg[field] = kv[hit];
  }
  return cfg;
}

for (const [code, name] of LANGS) {
  $("userLang").append(new Option(`${name} (${code})`, code));
}

const targetLang = initTargetLang($("targetLang"));

function msg(t, kind = "") {
  $("msg").textContent = t;
  $("msg").className = "msg " + kind;
}

function fill(config, settings) {
  for (const k of CFG) if (config?.[k]) $(k).value = config[k];
  if (!settings) return;
  targetLang.set(settings.targetLang);
  for (const k of [...TEXT, ...NUM]) $(k).value = settings[k];
  $("autoSites").value = settings.autoSites.join("\n");
  $("showStats").checked = settings.showStats;
}

function collect() {
  const config = Object.fromEntries(CFG.map((k) => [k, $(k).value.trim()]));
  const settings = { ...DEFAULT_SETTINGS };
  for (const k of TEXT) settings[k] = $(k).value.trim() || DEFAULT_SETTINGS[k];
  settings.targetLang = targetLang.get();
  settings.textColor = $("textColor").value.trim();
  settings.extraPrompt = $("extraPrompt").value.trim();
  for (const k of NUM) {
    const v = Number($(k).value);
    settings[k] = Number.isFinite(v) && $(k).value !== "" ? v : DEFAULT_SETTINGS[k];
  }
  settings.autoSites = $("autoSites").value.split(/\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  settings.showStats = $("showStats").checked;
  return { config, settings };
}

$("file").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  fill(parseProps(await f.text()));
  msg("已解析，请核对后点保存");
};
$("save").onclick = async () => {
  await chrome.storage.local.set(collect());
  msg("✓ 已保存", "ok");
};
$("test").onclick = async () => {
  await chrome.storage.local.set(collect());
  msg("测试中…");
  const t0 = performance.now();
  const res = await chrome.runtime.sendMessage({ type: "test", items: [{ id: 1, text: "Hello, world! This is a connection test." }] });
  if (res.ok) msg(`✓ 连接成功 ${((performance.now() - t0) / 1000).toFixed(1)}s：${res.translations[0]?.text ?? "（无返回）"}`, "ok");
  else msg("✗ " + res.error, "err");
};
$("clear").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "clearCache" });
  msg("✓ 缓存已清空", "ok");
};
chrome.storage.local.get(["config", "settings"]).then(({ config, settings }) => fill(config, mergeSettings(settings)));
