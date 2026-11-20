// Вкладка загрузок, вторая часть: поле ссылок «Скачать следующие альбомы и плейлисты»
// и список «Мои загрузки» — скачанные альбомы и плейлисты в выбранной папке с кнопками «Обновить».
// Пользуется общим из downloader.js и files.js: $, root, ensureRoot, hasPermission, loadRoot, readJson, INFO_DIR, INFO_FILE.

const { isActive, keyOf, plural } = EXT;
const openedAt = Date.now();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ------------------------------------------------------------ работа с сайтом — по одной
// Списки альбомов и плейлистов идут через одну вкладку Яндекс Музыки: не запускаем их одновременно.
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

// Ставит задачи в очередь сразу все — строками, которые можно двигать и убирать.
// Треки у каждой собираются, когда до неё доходит черёд.
async function queueLinks(items) {
  const r = await chrome.runtime.sendMessage({ type: "queueLinks", items }).catch(() => null);
  return r || { added: 0, skipped: items.length };
}

const listAlbums = (artist) => serial(() => chrome.runtime.sendMessage({ type: "listAlbums", artist }));
const listPlaylists = (owner) => serial(() => chrome.runtime.sendMessage({ type: "listPlaylists", owner }));

// Что показывать о задаче по её состоянию (как на кнопке «Скачать» на сайте)
function jobLabel(s) {
  if (!s) return null;
  switch (s.phase) {
    case "collect": return { text: s.text || "Ищу треки…" };
    case "queued": return { text: "В очереди" };
    case "folder": return { text: "Ждёт выбора папки" };
    case "sync": return { text: "Сверяю с уже скачанным…" };
    case "download": return { text: `Скачиваю ${s.done} из ${s.total}` + (s.failed ? `, ошибок: ${s.failed}` : "") };
    case "done":
      if (s.failed) return { text: `Готово, не скачалось: ${s.failed}`, tone: "warn" };
      return { text: s.fresh ? `Готово, новых треков: ${s.fresh}` : "Новых треков нет", tone: "ok" };
    case "cancelled": return { text: "Отменено", tone: "warn" };
    case "removed": return { text: "Убрано из очереди", tone: "warn" };
    case "failed":
    case "error": return { text: s.text || "Ошибка", tone: "warn" };
  }
  return null;
}

// ------------------------------------------------------------ вкладки «Загрузки» / «Мои загрузки»
function showTab(name) {
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === name);
  $("tab-loads").hidden = name !== "loads";
  $("tab-library").hidden = name !== "library";
  try { localStorage.setItem("tab", name); } catch { /* без запоминания */ }
  if (name === "library") openLibrary();
}
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));

// ------------------------------------------------------------ поле ссылок
const linksBox = $("links");

function addLinkRow(value = "") {
  const row = el("div", "lrow");
  row.innerHTML = `<div class="lline"><input type="text" spellcheck="false" autocomplete="off"
    placeholder="Ссылка на альбом, плейлист, трек или исполнителя"><span class="lkind" hidden></span>
    <button class="lx" type="button" title="Убрать" aria-label="Убрать">×</button></div>
    <p class="lmsg" hidden></p><div class="lpick" hidden></div>`;
  row.info = null;
  row.seq = 0;
  const input = row.querySelector("input");
  input.value = value;
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => inspectRow(row), 500);
    row.classList.toggle("filled", !!input.value.trim());
    ensureEmptyRow();
  });
  // несколько ссылок за раз (через пробел или с новой строки) — каждая в свою строку
  input.addEventListener("paste", (e) => {
    const many = (e.clipboardData.getData("text") || "").split(/\s+/).filter(Boolean);
    if (many.length < 2) return;
    e.preventDefault();
    input.value = many[0];
    row.classList.add("filled");
    inspectRow(row);
    let after = row;
    for (const v of many.slice(1)) {
      const r = addLinkRow(v);
      after.after(r);
      after = r;
      inspectRow(r);
    }
    ensureEmptyRow();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(timer);
      inspectRow(row);
    }
  });
  row.querySelector(".lx").addEventListener("click", () => {
    row.remove();
    ensureEmptyRow();
    updateSend();
  });
  row.classList.toggle("filled", !!value);
  linksBox.append(row);
  return row;
}

// внизу всегда есть пустая строка для следующей ссылки
function ensureEmptyRow() {
  const rows = [...linksBox.children];
  const last = rows[rows.length - 1];
  if (!last || last.querySelector("input").value.trim()) addLinkRow();
}

// ссылка в первой пустой строке (или в новой) — и сразу разбор
function putLink(url) {
  const empty = [...linksBox.children].find((r) => !r.querySelector("input").value.trim());
  const row = empty || addLinkRow();
  row.querySelector("input").value = url;
  row.classList.add("filled");
  ensureEmptyRow();
  inspectRow(row);
  return row;
}

async function inspectRow(row) {
  const v = row.querySelector("input").value.trim();
  const seq = ++row.seq;
  const kind = row.querySelector(".lkind");
  const msg = row.querySelector(".lmsg");
  const pick = row.querySelector(".lpick");
  row.info = null;
  kind.hidden = !v;
  kind.textContent = "…";
  kind.className = "lkind";
  msg.hidden = true;
  pick.hidden = true;
  pick.textContent = "";
  updateSend();
  if (!v) return;
  const info = await chrome.runtime.sendMessage({ type: "inspect", url: v }).catch((e) => ({ error: String(e.message || e) }));
  if (seq !== row.seq) return; // ссылку успели поменять
  if (!info || info.error) {
    kind.textContent = "Не подходит";
    kind.className = "lkind bad";
    msg.textContent = (info && info.error) || "Не удалось разобрать ссылку.";
    msg.hidden = false;
    return;
  }
  row.info = info;
  kind.textContent = info.label || "Ссылка";
  updateSend();
  if (info.kind === "artist") loadAlbums(row, info.artist, seq);
  if (info.kind === "collection") loadPlaylists(row, info.owner, seq);
}

// список с галочками: groups — [{ title, items: [{ url, title, meta, checked }] }]
function showPicker(row, allLabel, groups) {
  const pick = row.querySelector(".lpick");
  pick.hidden = false;
  pick.textContent = "";
  const boxes = [];
  const head = el("label", "lall");
  const all = document.createElement("input");
  all.type = "checkbox";
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  head.append(all, ` ${allLabel} (${count})`);
  const list = el("div", "lopts");
  const sync = () => {
    all.checked = boxes.every((x) => x.checked);
    all.indeterminate = !all.checked && boxes.some((x) => x.checked);
    updateSend();
  };
  for (const g of groups) {
    if (!g.items.length) continue;
    if (g.title) list.append(el("div", "lgroup", g.title));
    for (const it of g.items) {
      const opt = el("label", "lopt");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = it.checked !== false;
      cb.dataset.url = it.url;
      cb.dataset.title = it.title;
      cb.addEventListener("change", sync);
      opt.append(cb, el("span", "lname", it.title), el("small", null, it.meta || ""));
      list.append(opt);
      boxes.push(cb);
    }
  }
  all.addEventListener("change", () => {
    boxes.forEach((x) => { x.checked = all.checked; });
    all.indeterminate = false;
    updateSend();
  });
  pick.append(head, list);
  sync();
}

const TYPE = { single: "сингл", compilation: "сборник", podcast: "подкаст", audiobook: "аудиокнига" };

async function loadAlbums(row, artist, seq) {
  const msg = row.querySelector(".lmsg");
  msg.textContent = "Ищу альбомы исполнителя…";
  msg.hidden = false;
  const r = await listAlbums(artist).catch((e) => ({ error: String(e.message || e) }));
  if (seq !== row.seq) return;
  if (!r || r.error || !r.albums) {
    msg.textContent = "Не удалось получить альбомы: " + ((r && r.error) || "нет ответа") + ". Попробуйте ещё раз — нажмите Enter в поле ссылки.";
    return;
  }
  if (!r.albums.length) {
    msg.textContent = "У этого исполнителя не нашлось альбомов.";
    return;
  }
  msg.textContent = r.artist ? `Исполнитель: ${r.artist}` : "";
  msg.hidden = !r.artist;
  const item = (a) => ({
    url: a.url, title: a.title, checked: !a.also,
    meta: [a.year, TYPE[a.type], a.tracks ? `${a.tracks} ${plural(a.tracks, "трек", "трека", "треков")}` : ""].filter(Boolean).join(" · "),
  });
  showPicker(row, "Все альбомы и синглы", [
    { title: "", items: r.albums.filter((a) => !a.also).map(item) },
    { title: "Сборники и совместные (не отмечены)", items: r.albums.filter((a) => a.also).map(item) },
  ]);
}

async function loadPlaylists(row, owner, seq) {
  const msg = row.querySelector(".lmsg");
  msg.textContent = "Ищу плейлисты…";
  msg.hidden = false;
  const r = await listPlaylists(owner).catch((e) => ({ error: String(e.message || e) }));
  if (seq !== row.seq) return;
  if (!r || r.error || !r.playlists) {
    msg.textContent = "Не удалось получить плейлисты: " + ((r && r.error) || "нет ответа") + ". Попробуйте ещё раз — нажмите Enter в поле ссылки.";
    return;
  }
  if (!r.playlists.length) {
    msg.textContent = "Плейлистов не нашлось (или они скрыты — войдите в аккаунт Яндекс Музыки).";
    return;
  }
  msg.hidden = true;
  showPicker(row, "Все плейлисты", [{
    title: "",
    items: r.playlists.map((p, i) => ({
      url: p.url, title: p.title, checked: i > 0, // «Мне нравится» бывает очень большим — по умолчанию не отмечен
      meta: p.tracks ? `${p.tracks} ${plural(p.tracks, "трек", "трека", "треков")}` : "",
    })),
  }]);
}

// что уйдёт в очередь по кнопке «Скачать»
function collectLinks() {
  const out = new Map(); // ключ задачи -> { url, title }
  for (const row of linksBox.children) {
    const info = row.info;
    if (!info) continue;
    if (info.kind === "artist" || info.kind === "collection") {
      for (const cb of row.querySelectorAll(".lopt input:checked")) {
        const job = keyOf(cb.dataset.url) || cb.dataset.url;
        out.set(job, { url: cb.dataset.url, title: cb.dataset.title });
      }
    } else {
      const url = row.querySelector("input").value.trim();
      const job = info.job || url;
      out.set(job, { url, title: `${info.label}: ${url.replace(/^https?:\/\/(www\.)?/, "")}` });
    }
  }
  return [...out].map(([job, v]) => ({ job, ...v }));
}

function updateSend() {
  const n = collectLinks().length;
  $("sendLinks").disabled = !n;
  $("sendLinks").textContent = n > 1 ? `Скачать (${n})` : "Скачать";
}

$("sendLinks").addEventListener("click", async () => {
  const items = collectLinks();
  if (!items.length) return;
  linksBox.textContent = "";
  ensureEmptyRow();
  updateSend();
  const r = await queueLinks(items);
  $("linksNote").textContent = r.added
    ? `В очередь добавлено: ${r.added}` + (r.skipped ? `, уже были в очереди: ${r.skipped}` : "") + "."
    : "Всё это уже стоит в очереди.";
});

$("myPlaylists").addEventListener("click", () => putLink("https://music.yandex.ru/collection"));

addLinkRow();
updateSend();

// Кнопка на странице исполнителя или «Мои плейлисты» передают ссылку сюда — показываем выбор.
async function takePickLink() {
  const { pickLink } = await chrome.storage.local.get("pickLink");
  if (!pickLink) return;
  await chrome.storage.local.remove("pickLink");
  if (Date.now() - (pickLink.at || 0) > 5 * 60 * 1000) return; // старая просьба
  showTab("loads");
  putLink(pickLink.url);
  $("links").scrollIntoView({ behavior: "smooth", block: "center" });
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.pickLink && ch.pickLink.newValue) takePickLink();
});
takePickLink();

// ------------------------------------------------------------ «Мои загрузки»
let library = null;     // [{ dir, path, title, artist, kind, url, tracks, updatedAt, key }]
let libLoading = null;

function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const opts = { day: "numeric", month: "long" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("ru-RU", opts);
}

// Скачанное — это папки с _сведения/info.json: «Исполнитель/Альбом» и «Плейлисты/Название».
async function scanLibrary() {
  const out = [];
  const visit = async (dir, path, depth) => {
    let infoDir = null;
    try { infoDir = await dir.getDirectoryHandle(INFO_DIR); } catch { /* не папка загрузки */ }
    const info = infoDir && (await readJson(infoDir, INFO_FILE));
    if (info && info.url) {
      out.push({
        path, title: info.title || path.split("/").pop(), artist: info.artist || "", kind: info.kind,
        url: info.url, tracks: Object.keys(info.files || {}).length, updatedAt: info.updatedAt, key: keyOf(info.url),
      });
      return;
    }
    if (depth >= 2) return;
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== "directory" || name.startsWith("_") || name === SINGLES_DIR) continue;
      await visit(h, path ? `${path}/${name}` : name, depth + 1);
    }
  };
  await visit(root, "", 0);
  out.sort((a, b) => (a.artist + a.title).localeCompare(b.artist + b.title, "ru"));
  return out;
}

async function loadLibrary() {
  if (!root || !(await hasPermission(root, false))) {
    library = null;
    renderLibrary("Нет доступа к папке. Выберите папку или разрешите доступ к ней — кнопка вверху.");
    return;
  }
  if (!libLoading) {
    libLoading = scanLibrary().finally(() => { libLoading = null; });
  }
  try {
    library = await libLoading;
  } catch (e) {
    library = null;
    renderLibrary("Не удалось прочитать папку: " + (e.message || e));
    return;
  }
  await renderLibrary();
}

// выбрали другую папку или дали к ней доступ — список читаем заново
function libraryReset() {
  library = null;
  if (!$("tab-library").hidden) openLibrary();
  else loadLibrary();
}

let libTimer = null;
// после каждой загрузки список перечитывается (не чаще раза в пару секунд)
function libraryChanged() {
  clearTimeout(libTimer);
  libTimer = setTimeout(loadLibrary, 1500);
}

async function openLibrary() {
  if (library) return;
  if (!(await ensureRoot())) {
    renderLibrary("Нет доступа к папке. Выберите папку или разрешите доступ к ней — кнопка вверху.");
    return;
  }
  renderLibrary("Читаю папку…");
  await loadLibrary();
}

const rowsByKey = new Map(); // ключ задачи -> функция, обновляющая её строку

async function renderLibrary(message) {
  const list = $("libList");
  list.textContent = "";
  rowsByKey.clear();
  const count = library ? library.length : 0;
  $("libCount").textContent = library ? String(count) : "";
  $("libSub").textContent = library
    ? (count ? `${count} в папке «${root.name}». «Обновить» докачивает новые треки, как повторное скачивание.`
      : `В папке «${root.name}» пока нет скачанных альбомов и плейлистов.`)
    : "";
  $("updateAll").disabled = !library || !library.length;
  if (message) {
    list.append(el("p", "lib-empty", message));
    return;
  }
  if (!library || !count) return;
  const keys = library.filter((b) => b.key).map((b) => "job:" + b.key);
  const states = keys.length ? await chrome.storage.local.get(keys) : {};
  for (const b of library) list.append(libraryRow(b, b.key && states["job:" + b.key]));
}

function libraryRow(b, state) {
  const row = el("div", "lib-row");
  const main = el("div", "lib-main");
  main.append(el("b", null, b.title));
  const meta = [b.kind === "playlist" ? "плейлист" : b.artist, `${b.tracks} ${plural(b.tracks, "трек", "трека", "треков")}`];
  if (b.updatedAt) meta.push("обновлено " + fmtDate(b.updatedAt));
  main.append(el("small", null, meta.filter(Boolean).join(" · ")));
  const st = el("small", "lib-st");
  main.append(st);
  row.append(main);

  const a = el("a", "lib-open", "На сайте");
  a.href = b.url;
  a.target = "_blank";
  a.rel = "noopener";
  a.title = "Открыть на Яндекс Музыке";
  row.append(a);
  const btn = el("button", null, "Обновить");
  btn.type = "button";
  row.append(btn);

  const paint = (s) => {
    const fresh = s && (isActive(s) || (!EXT.ACTIVE.has(s.phase) && (s.at || 0) >= openedAt));
    const label = fresh ? jobLabel(s) : null;
    st.textContent = label ? label.text : "";
    st.className = "lib-st" + (label && label.tone ? " " + label.tone : "");
    btn.disabled = isActive(s);
  };
  paint(state);
  if (b.key) rowsByKey.set(b.key, paint);

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    await queueLinks([{ url: b.url, job: b.key, title: b.title }]);
  });
  return row;
}

$("updateAll").addEventListener("click", async () => {
  if (!library) return;
  const items = library.map((b) => ({ url: b.url, job: b.key, title: b.title }));
  if (!items.length) return;
  const r = await queueLinks(items);
  $("libNote").textContent = (r.added ? `В очередь добавлено: ${r.added}` : "Всё уже стоит в очереди")
    + (r.added && r.skipped ? `, уже были в очереди: ${r.skipped}` : "")
    + ". Их можно двигать и убирать во вкладке «Загрузки».";
});

// состояние задач меняется — строки списка показывают этап и прогресс
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  for (const [k, v] of Object.entries(ch)) {
    if (!k.startsWith("job:")) continue;
    const paint = rowsByKey.get(k.slice(4));
    if (paint) paint(v.newValue);
  }
});

(async () => {
  let tab = "loads";
  try { tab = localStorage.getItem("tab") || "loads"; } catch { /* по умолчанию «Загрузки» */ }
  // число загрузок на вкладке «Мои загрузки» — сразу, если доступ к папке уже есть
  const saved = await loadRoot().catch(() => null);
  if (saved && (await hasPermission(saved, false))) {
    root = root || saved;
    await loadLibrary();
  }
  showTab(tab === "library" ? "library" : "loads");
})();
