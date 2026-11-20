// Кнопка «Скачать» в шапке альбома, плейлиста и исполнителя на Яндекс Музыке.
// Встаёт в ряд кнопок шапки («Слушать», «Нравится», «…») и берёт оформление у соседней кнопки,
// поэтому выглядит как родная. На ней же виден ход загрузки: поиск треков → очередь → «12 / 40» → итог.
(() => {
  if (window.__ymdButton) return;
  window.__ymdButton = true;

  const { parseLink, keyOfLink, isActive } = EXT;
  // ряд кнопок шапки; у обёртки вокруг него класс CommonPageHeader_controlsContainer — её не берём
  const ROW = '[class*="CommonPageHeader_controls__"]';
  const IDLE_TITLE = "Скачать через Yandex Music Downloader";
  const SHOW_RESULT = 12000; // итог виден столько, потом кнопка снова «Скачать»

  // что скачивать с этой страницы; /album/1/track/2 — это страница альбома с выделенным треком
  function pageTarget() {
    const l = parseLink(location.href);
    if (!l || l.kind === "collection") return null;
    if (l.kind === "track" && l.album) return { kind: "album", album: l.album };
    return l;
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.ymd = "download";
  btn.title = IDLE_TITLE;
  const ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" style="flex:none">' +
    '<path fill="currentColor" d="M11 3h2v9.6l3.3-3.3 1.4 1.4L12 16.4l-5.7-5.7 1.4-1.4 3.3 3.3V3zM5 19h14v2H5z"/></svg>';
  const label = document.createElement("span");
  let inner = null; // обёртка как у соседней кнопки (у сайта текст лежит во вложенном span)

  // оформление — классы соседней кнопки с текстом («Трейлер», «Нравится»), иначе своё
  function styleLike(row) {
    const sample = row.querySelector('[data-test-id="TRAILER_BUTTON"]') || row.querySelector('[data-test-id="LIKE_BUTTON"]') ||
      [...row.querySelectorAll("button")].find((b) => b !== btn && !/PLAY_BUTTON/.test(b.dataset.testId || ""));
    btn.textContent = "";
    if (sample) {
      btn.className = sample.className;
      const span = sample.querySelector(":scope > span");
      inner = document.createElement("span");
      if (span) inner.className = span.className;
      btn.removeAttribute("style");
    } else {
      inner = document.createElement("span");
      Object.assign(btn.style, {
        display: "inline-flex", alignItems: "center", height: "40px", padding: "0 16px", border: "0",
        borderRadius: "999px", background: "#ffcc00", color: "#151515", font: "600 14px/1 system-ui, sans-serif",
        cursor: "pointer",
      });
    }
    Object.assign(inner.style, { display: "inline-flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap" });
    inner.innerHTML = ICON;
    inner.append(label);
    btn.append(inner);
    btn.style.fontVariantNumeric = "tabular-nums";
    paint();
  }

  // ---------------------------------------------------------------- прогресс на кнопке
  let jobKey = null;   // задача этой страницы
  let job = null;      // её последнее состояние
  let resultTimer = null;
  let isArtist = false;

  function view(s) {
    if (!s) return { text: isArtist ? "Скачать альбомы" : "Скачать", title: IDLE_TITLE };
    const more = " Нажмите, чтобы открыть вкладку загрузок.";
    switch (s.phase) {
      case "collect": {
        const m = /(\d+) трек/.exec(s.text || "");
        return { text: m ? `Найдено: ${m[1]}` : "Ищу треки…", title: (s.text || "Ищу треки") + more };
      }
      case "queued":
        return { text: "В очереди", title: (s.found != null ? `Найдено треков: ${s.found}. ` : "") + "Ждёт своей очереди во вкладке загрузок." + more };
      case "folder":
        return { text: "Выберите папку", title: "Откройте вкладку загрузок и выберите папку для сохранения." + more };
      case "sync":
        return { text: "Сверяю…", title: (s.text || "Сверяю с уже скачанным") + more };
      case "download": {
        const all = s.total || 0, ok = (s.done || 0) + (s.failed || 0);
        return { text: `Скачиваю ${s.done} / ${all}`, fill: all ? ok / all : 1,
          title: `Скачано ${s.done} из ${all}` + (s.failed ? `, ошибок: ${s.failed}` : "") + "." + more };
      }
      case "done":
        if (s.failed) return { text: `Готово, ошибок: ${s.failed}`, tone: "warn", title: `Скачано ${s.done} из ${s.total}. Что не скачалось — во вкладке загрузок.` };
        if (!s.fresh) return { text: "✓ Новых треков нет", tone: "ok", title: `Всё уже было в папке (треков: ${s.total}).` };
        return { text: `✓ Скачано: ${s.fresh}`, tone: "ok", title: `Всего треков в папке: ${s.done}.` };
      case "cancelled":
        return { text: "Отменено", title: "Загрузку отменили. Уже скачанное осталось в папке." };
      case "removed":
        return { text: "Убрано из очереди", title: "Загрузку убрали из очереди во вкладке загрузок." };
      case "failed":
      case "error":
        return { text: "Ошибка", tone: "bad", title: s.text || "Что-то пошло не так" };
    }
    return { text: "Скачать", title: IDLE_TITLE };
  }

  const TONES = { ok: ["#1a7f37", "#fff"], warn: ["#9a6700", "#fff"], bad: ["#b3261e", "#fff"] };

  function paint() {
    clearTimeout(resultTimer);
    let s = job;
    // итог показываем недолго — потом кнопка снова «Скачать»
    if (s && !isActive(s)) {
      const left = SHOW_RESULT - (Date.now() - (s.at || 0));
      if (left <= 0) s = null;
      else resultTimer = setTimeout(paint, left);
    }
    const v = view(s);
    label.textContent = v.text;
    btn.title = v.title;
    btn.setAttribute("aria-label", v.text);
    const tone = TONES[v.tone];
    btn.style.backgroundColor = tone ? tone[0] : "";
    btn.style.color = tone ? tone[1] : "";
    // заполнение кнопки слева направо — как полоса прогресса
    btn.style.backgroundImage = v.fill != null
      ? `linear-gradient(to right, rgba(127,127,127,.35) ${Math.round(v.fill * 100)}%, transparent 0)` : "";
  }

  async function follow(key) {
    if (key === jobKey) return;
    jobKey = key;
    job = null;
    if (key) {
      const got = await chrome.storage.local.get("job:" + key).catch(() => ({}));
      if (jobKey === key) job = got["job:" + key] || null;
    }
    paint();
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || !jobKey || !ch["job:" + jobKey]) return;
    job = ch["job:" + jobKey].newValue || null;
    paint();
  });

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!chrome.runtime || !chrome.runtime.id) {
      label.textContent = "Обновите страницу (F5)";
      return;
    }
    const t = pageTarget();
    if (!t) return;
    // уже идёт — показываем, где именно
    if (isActive(job)) {
      chrome.runtime.sendMessage({ type: "open" });
      return;
    }
    if (t.kind !== "artist") {
      job = { phase: "collect", text: "Ищу треки…", at: Date.now() };
      paint();
    }
    chrome.runtime.sendMessage({ type: "download", url: location.href, job: t.kind === "artist" ? null : jobKey });
  });
  for (const ev of ["mousedown", "mouseup", "pointerdown", "pointerup"]) btn.addEventListener(ev, (e) => e.stopPropagation());

  // ---------------------------------------------------------------- место в шапке
  const visible = (el) => el && el.getClientRects().length > 0;

  function ensureButton() {
    const t = pageTarget();
    if (!t) {
      btn.remove();
      return;
    }
    isArtist = t.kind === "artist";
    follow(isArtist ? null : keyOfLink(t));
    const row = [...document.querySelectorAll(ROW)].find(visible);
    if (!row) return;
    if (btn.parentElement === row) return;
    styleLike(row);
    // сразу после «Трейлер» (или «Слушать»): там кнопки с текстом, дальше — значки
    const anchor = [...row.children].find((c) => c.querySelector && c.matches('[data-test-id="TRAILER_BUTTON"]'))
      || [...row.children].find((c) => c.matches && c.matches('[data-test-id="PLAY_BUTTON"]'));
    row.insertBefore(btn, anchor ? anchor.nextSibling : null);
  }

  // сайт перерисовывает страницу без перезагрузки — следим и возвращаем кнопку на место
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      try { ensureButton(); } catch { /* страница в процессе перерисовки */ }
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();
})();
