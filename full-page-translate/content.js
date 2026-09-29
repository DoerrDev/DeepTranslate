(() => {
  const SELECTOR = "p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,dd,dt,figcaption,summary,div,span,a";
  const BLOCK = "p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,dd,dt,figcaption,summary,div,ul,ol,table,pre,section,article";
  const SKIP = "script,style,noscript,code,pre,textarea,input,svg,math,[contenteditable=true],.dt-trans,#dt-toast,#dt-stats";

  let S = mergeSettings();
  function applySettings(v) {
    S = mergeSettings(v);
    document.documentElement.style.setProperty("--dt-color", S.textColor || "inherit");
    if (!S.showStats) document.getElementById("dt-stats")?.remove();
  }
  chrome.storage.local.get("settings").then(({ settings }) => {
    applySettings(settings);
    const host = location.hostname;
    if (S.autoSites.some((d) => host === d || host.endsWith("." + d))) start();
  });
  chrome.storage.onChanged.addListener((ch) => { if (ch.settings) applySettings(ch.settings.newValue); });

  let active = false, observer = null, mo = null, seq = 0;
  const pending = new Map();   // id -> element
  let queue = [], timer = null, running = 0;

  // ---------- 统计 ----------
  const stats = { cached: 0, items: 0, chars: 0, batches: 0, latency: 0, busy: 0, busyStart: 0, total: 0 };
  function resetStats() { Object.assign(stats, { cached: 0, items: 0, chars: 0, batches: 0, latency: 0, busy: 0, busyStart: 0, total: 0 }); }
  function showStats() {
    if (!S.showStats) return;
    let s = document.getElementById("dt-stats");
    if (!s) { s = document.createElement("div"); s.id = "dt-stats"; document.body.appendChild(s); }
    const busy = stats.busy + (running ? performance.now() - stats.busyStart : 0);
    const avg = stats.batches ? (stats.latency / stats.batches / 1000).toFixed(1) : "-";
    const cps = busy > 0 ? Math.round(stats.chars / (busy / 1000)) : 0;
    s.textContent = `已译 ${stats.items}/${stats.total} 段 · 平均 ${avg}s/批 · ${cps} 字/秒 · 缓存 ${stats.cached} · 进行中 ${running}`;
  }

  function toast(msg, ms = 3000) {
    let t = document.getElementById("dt-toast");
    if (!t) { t = document.createElement("div"); t.id = "dt-toast"; document.body.appendChild(t); }
    t.textContent = msg; t.style.display = "block";
    clearTimeout(t._h); t._h = setTimeout(() => (t.style.display = "none"), ms);
  }

  // ---------- 候选段落 ----------
  // 各语言的书写脚本，用于快速判断文本是否已是用户语言
  const SCRIPTS = {
    zh: /[一-鿿]/g, ja: /[぀-ヿ一-鿿]/g, ko: /[가-힯]/g,
    ru: /[Ѐ-ӿ]/g, uk: /[Ѐ-ӿ]/g, ar: /[؀-ۿ]/g, hi: /[ऀ-ॿ]/g, th: /[฀-๿]/g,
  };
  const baseLang = (c) => String(c || "").toLowerCase().split("-")[0];

  // 同步快速判断：字母太少、或主要由用户语言的脚本组成则跳过
  function needsTranslate(text) {
    if (text.length < 2) return false;
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (letters < 3) return false;
    const re = SCRIPTS[baseLang(S.userLang)];
    if (re) return letters - (text.match(re) || []).length > (text.match(re) || []).length * 2;
    return true;
  }

  // 异步语言检测（拉丁字母语言之间无法靠脚本区分）：可靠地检测为用户语言则跳过
  async function isUserLang(text) {
    try {
      const r = await chrome.i18n.detectLanguage(text.slice(0, 300));
      const top = r?.languages?.[0];
      return !!(r?.isReliable && top && baseLang(top.language) === baseLang(S.userLang));
    } catch { return false; }
  }

  // 叶子文本块：匹配 SELECTOR 且不含其他块级后代
  function isCandidate(el) {
    if (!el.matches(SELECTOR) || el.closest(SKIP) || el.dataset.dtDone) return false;
    if (el.querySelector(BLOCK)) return false;
    // 行内元素(span/a)若父级本身是叶子块，则交给父级整体处理
    if (el.matches("span,a") && el.parentElement) {
      const p = el.parentElement;
      if (p.matches(SELECTOR) && !p.closest(SKIP) && !p.querySelector(BLOCK)) return false;
    }
    const text = el.innerText?.trim();
    return !!text && needsTranslate(text);
  }

  function scan(root) {
    const list = root.matches?.(SELECTOR) ? [root] : [];
    list.push(...root.querySelectorAll(SELECTOR));
    const obs = observer;
    for (const el of list) {
      if (!isCandidate(el)) continue;
      el.dataset.dtDone = "1";
      isUserLang(el.innerText.trim()).then((skip) => {
        if (obs !== observer) return;   // 期间已还原或重开
        if (skip) { delete el.dataset.dtDone; return; }
        stats.total++; obs.observe(el);
      });
    }
  }

  // ---------- 队列与请求 ----------
  function enqueue(el, urgent) {
    urgent ? queue.unshift(el) : queue.push(el);
    clearTimeout(timer);
    timer = setTimeout(flush, 120);
  }

  function flush() {
    while (queue.length && running < S.concurrency) {
      const batch = []; let chars = 0;
      while (queue.length && batch.length < S.maxItems && chars < S.maxChars) {
        const el = queue.shift();
        if (!el.isConnected) continue;
        const text = el.innerText.trim();
        const id = ++seq;
        pending.set(id, el);
        const node = document.createElement("font");
        node.className = "dt-trans dt-loading"; node.textContent = "翻译中…";
        el.appendChild(node); el._dt = node;
        batch.push({ id, text }); chars += text.length;
      }
      if (batch.length) send(batch, chars);
    }
    showStats();
  }

  function send(batch, chars) {
    if (running++ === 0) stats.busyStart = performance.now();
    const t0 = performance.now();
    chrome.runtime.sendMessage({ type: "translate", items: batch }, (res) => {
      const now = performance.now();
      if (--running === 0) stats.busy += now - stats.busyStart;
      const err = chrome.runtime.lastError?.message || (res && !res.ok && res.error);
      const map = new Map((res?.translations || []).map((t) => [String(t.id), t.text]));
      for (const { id } of batch) {
        const el = pending.get(id); pending.delete(id);
        const node = el?._dt; if (!node) continue;
        node.classList.remove("dt-loading");
        if (map.has(String(id))) { node.textContent = map.get(String(id)); stats.items++; }
        else {
          node.classList.add("dt-error");
          node.title = "点击重试";
          node.textContent = "翻译失败：" + (err || "模型未返回该段") + "（点击重试）";
          node.onclick = () => { node.remove(); delete el._dt; enqueue(el, true); };
        }
      }
      if (!err) {
        stats.cached += res.cached || 0;
        if ((res.cached || 0) < batch.length) { stats.batches++; stats.latency += now - t0; stats.chars += chars; }
      }
      else toast("翻译出错：" + err, 6000);
      flush();
    });
  }

  // ---------- 全文翻译 ----------
  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight;
  }

  function start() {
    active = true;
    resetStats();
    // 可见区优先；上方留半屏、下方预读 1.5 屏，其余不翻译
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer.unobserve(e.target);
        enqueue(e.target, inViewport(e.target));
      }
    }, { rootMargin: `${Math.round(innerHeight * 0.5)}px 0px ${Math.round(innerHeight * 1.5)}px 0px` });
    scan(document.body);
    mo = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes)
        if (n.nodeType === 1 && !n.closest?.(".dt-trans,#dt-toast,#dt-stats")) scan(n);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    toast("全文翻译已开启 (Alt+A 还原；选中文字后按 Alt+A 只译该段)");
    showStats();
  }

  function clearAll() {
    document.querySelectorAll(".dt-trans").forEach((n) => n.remove());
    document.querySelectorAll("[data-dt-done]").forEach((e) => { delete e.dataset.dtDone; delete e._dt; });
  }

  function stop() {
    active = false;
    observer?.disconnect(); mo?.disconnect();
    queue = []; pending.clear();
    clearAll();
    document.getElementById("dt-stats")?.remove();
    toast("已还原原文");
  }

  // ---------- 选中段落翻译 ----------
  function leafBlockOf(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== document.body) {
      if (el.matches(SELECTOR) && !el.matches("span,a") && !el.querySelector(BLOCK) && !el.closest(".dt-trans")) return el;
      el = el.parentElement;
    }
    return null;
  }

  function selectedBlocks(range) {
    const leaf = leafBlockOf(range.commonAncestorContainer);
    if (leaf) return [leaf];
    const root = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    return [...root.querySelectorAll(SELECTOR)].filter(
      (el) => !el.matches("span,a") && !el.querySelector(BLOCK) && !el.closest(SKIP) && range.intersectsNode(el)
    );
  }

  function translateSelection(sel) {
    const blocks = selectedBlocks(sel.getRangeAt(0));
    // 已有译文则移除（再次按键=还原）
    const done = blocks.filter((el) => el._dt && el.isConnected);
    if (done.length) {
      done.forEach((el) => { el._dt.remove(); delete el._dt; delete el.dataset.dtDone; });
      return;
    }
    const todo = blocks.filter((el) => el.innerText?.trim() && needsTranslate(el.innerText.trim()));
    if (!todo.length) return toast("选中内容无需翻译");
    if (!document.getElementById("dt-stats")) resetStats();
    stats.total += todo.length;
    for (const el of todo) { el.dataset.dtDone = "1"; enqueue(el, true); }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "toggle") return;
    const sel = getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return translateSelection(sel);
    active ? stop() : start();
  });
})();
