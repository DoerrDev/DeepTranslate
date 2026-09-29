const $ = (id) => document.getElementById(id);

for (const [code, name] of LANGS) {
  $("userLang").append(new Option(`${name} (${code})`, code));
}

let targetLang;
async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  const st = mergeSettings(settings);
  targetLang.set(st.targetLang);
  $("userLang").value = st.userLang;
  const cmds = await chrome.commands.getAll();
  $("key").textContent = cmds.find((c) => c.name === "toggle-translate")?.shortcut || "未设置";
}

async function save() {
  const { settings } = await chrome.storage.local.get("settings");
  const st = mergeSettings(settings);
  st.targetLang = targetLang.get();
  st.userLang = $("userLang").value;
  await chrome.storage.local.set({ settings: st });
}
targetLang = initTargetLang($("targetLang"), save);
$("userLang").onchange = save;

$("toggle").onclick = async () => {
  await save();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { await chrome.tabs.sendMessage(tab.id, { type: "toggle" }); window.close(); }
  catch { $("toggle").textContent = "此页面不支持（或请刷新页面后重试）"; }
};
$("shortcut").onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: "chrome://extensions/shortcuts" }); };
$("options").onclick = () => chrome.runtime.openOptionsPage();
load();
