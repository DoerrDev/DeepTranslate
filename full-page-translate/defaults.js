// background / content / options 共用的默认设置
const DEFAULT_SETTINGS = {
  targetLang: "简体中文",  // 任意语言名称，直接写入提示词
  userLang: "zh",       // 我的语言(代码)：已是该语言的文本不翻译
  concurrency: 5,       // 同时进行的请求数
  maxItems: 20,         // 每批最多段落数
  maxChars: 4000,       // 每批最多字符数
  temperature: 0.2,
  textColor: "",        // 空 = 沿用原文颜色
  showStats: true,      // 左下角显示速度统计
  extraPrompt: "",      // 追加给模型的额外要求（如术语表）
  autoSites: [],        // 自动全文翻译的域名
};

function mergeSettings(s) {
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

// 常用语言 [代码, 名称]，仅作选项/联想，目标语言可自由输入
const LANGS = [
  ["zh", "简体中文"], ["zh-TW", "繁體中文"], ["en", "English"], ["ja", "日本語"], ["ko", "한국어"],
  ["fr", "Français"], ["de", "Deutsch"], ["es", "Español"], ["pt", "Português"], ["it", "Italiano"],
  ["ru", "Русский"], ["uk", "Українська"], ["ar", "العربية"], ["hi", "हिन्दी"], ["th", "ไทย"],
  ["vi", "Tiếng Việt"], ["id", "Bahasa Indonesia"], ["tr", "Türkçe"],
];

// 目标语言下拉框：sel 为 <select>，返回 {get,set}；不在列表里的旧值回落为默认语言
function initTargetLang(sel, onChange) {
  for (const [, name] of LANGS) sel.append(new Option(name, name));
  sel.onchange = () => onChange?.();
  return {
    get: () => sel.value,
    set(v) { sel.value = LANGS.some(([, n]) => n === v) ? v : DEFAULT_SETTINGS.targetLang; },
  };
}
