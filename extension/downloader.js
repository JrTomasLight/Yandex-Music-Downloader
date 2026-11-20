// Вкладка загрузок: пишет треки прямо в выбранную папку (без окна «Сохранить как» на каждый файл).
// Пользуется files.js: syncFolder, writeInfo, buildId3, id3Skipper, pool.

const PARALLEL = 3;     // треков одновременно
const LINK_BATCH = 10;  // ссылок на файлы за один запрос к вкладке сайта
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ версия и ссылки
const REPO = "https://github.com/JrTomasLight/Yandex-Music-Downloader";
const BOOSTY = "https://boosty.to/jrtomaslight";
const VERSION = chrome.runtime.getManifest ? chrome.runtime.getManifest().version : "";
if ($("ver")) {
  $("ver").textContent = VERSION ? "v" + VERSION : "";
  $("verFoot").textContent = VERSION ? `Версия ${VERSION}` : "";
  $("repo").href = REPO;
  $("boosty").href = BOOSTY;
  $("issues").href = REPO + "/issues";
}

// заголовок «Очередь и загрузки» — только когда там что-то есть
function updateEmpty() {
  $("loadsTitle").hidden = $("items").children.length === 0 && $("queue").hidden;
}

// ------------------------------------------------------------ папка (хранится в IndexedDB)
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("ymd", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", mode);
      const req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const loadRoot = () => idb("readonly", (s) => s.get("root"));
const saveRoot = (h) => idb("readwrite", (s) => s.put(h, "root"));

let root = null;

async function hasPermission(h, ask) {
  const opts = { mode: "readwrite" };
  if ((await h.queryPermission(opts)) === "granted") return true;
  return ask && (await h.requestPermission(opts)) === "granted";
}

function showNeed(text) {
  $("need").hidden = !text;
  $("needText").textContent = text || "";
}

async function pickFolder() {
  try {
    const h = await window.showDirectoryPicker({ id: "ymd", mode: "readwrite", startIn: "music" });
    await saveRoot(h);
    root = h;
    dirCache.clear();
    $("folderName").textContent = h.name;
    showNeed("");
    if (typeof libraryReset === "function") libraryReset();
    run();
  } catch (e) {
    if (e.name !== "AbortError") alert("Не удалось выбрать папку: " + e.message);
  }
}

async function ensureRoot() {
  if (root && (await hasPermission(root, false))) return true;
  const saved = await loadRoot().catch(() => null);
  if (saved) {
    $("folderName").textContent = saved.name;
    if (await hasPermission(saved, false)) {
      root = saved;
      return true;
    }
    showNeed(`Разрешите расширению сохранять файлы в папку «${saved.name}».`);
    $("grant").onclick = async () => {
      if (await hasPermission(saved, true)) {
        root = saved;
        showNeed("");
        if (typeof libraryReset === "function") libraryReset();
        run();
      }
    };
    $("grant").textContent = "Продолжить";
  } else {
    showNeed("Выберите папку, куда сохранять музыку. Это нужно сделать один раз.");
    $("grant").onclick = pickFolder;
    $("grant").textContent = "Выбрать папку";
  }
  return false;
}

const dirCache = new Map();
function getDir(path) {
  if (!dirCache.has(path)) {
    const p = (async () => {
      let d = root;
      for (const part of path.split("/").filter(Boolean)) d = await d.getDirectoryHandle(part, { create: true });
      return d;
    })();
    p.catch(() => dirCache.delete(path));
    dirCache.set(path, p);
  }
  return dirCache.get(path);
}

// ------------------------------------------------------------ скачивание
// Без ограничений по времени один зависший ответ сервера останавливает всю очередь.
const CONNECT_TIMEOUT = 30000; // ждём начала ответа
const STALL_TIMEOUT = 45000;   // ждём следующего куска данных
const ATTEMPTS = 3;

class Stalled extends Error {}
class Cancelled extends Error {}
class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Сигнал отмены текущей загрузки: альбомы качаются по одному, поэтому хватает одного.
let activeSignal = null;
const checkCancel = () => {
  if (activeSignal && activeSignal.aborted) throw new Cancelled("отменено");
};

const sleep = async (ms) => {
  await new Promise((r) => {
    const t = setTimeout(r, ms);
    if (activeSignal) activeSignal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
  });
  checkCancel();
};

// Читает тело ответа по кускам; если данные перестали идти — обрывает запрос.
async function readBody(resp, onChunk) {
  const reader = resp.body.getReader();
  let timer;
  try {
    while (true) {
      const stall = new Promise((_, reject) => {
        timer = setTimeout(() => {
          resp._ctrl.abort();
          reject(new Stalled("сервер перестал отвечать"));
        }, STALL_TIMEOUT);
      });
      let res;
      try {
        res = await Promise.race([reader.read(), stall]);
      } catch (e) {
        checkCancel();
        throw e;
      }
      const { done, value } = res;
      clearTimeout(timer);
      if (done) return;
      await onChunk(value);
    }
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch { /* поток уже закрыт */ }
  }
}

async function get(url) {
  let last;
  for (let i = 0; i < ATTEMPTS; i++) {
    checkCancel();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT);
    if (activeSignal) activeSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
    try {
      const r = await fetch(url, { signal: ctrl.signal, credentials: "omit" });
      clearTimeout(timer);
      if (r.ok) {
        r._ctrl = ctrl; // чтобы оборвать загрузку, если данные перестанут идти
        return r;
      }
      last = new HttpError(`HTTP ${r.status}`, r.status);
      if ([403, 404, 410].includes(r.status)) break;
    } catch (e) {
      clearTimeout(timer);
      checkCancel();
      last = e.name === "AbortError" ? new Stalled("сервер не отвечает") : e;
    }
    await sleep(1500 * (i + 1));
  }
  throw last;
}

// Пишет файл трека: сначала наш тег, затем звук без тега источника. При ошибке файл удаляется.
async function writeTrack(dir, name, resp, tag) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  const skip = id3Skipper();
  try {
    if (tag) await w.write(tag);
    await readBody(resp, (chunk) => {
      const part = skip(chunk);
      return part.length ? w.write(part) : undefined;
    });
    const rest = skip.rest();
    if (rest.length) await w.write(rest);
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* уже закрыт */ }
    try { await dir.removeEntry(name); } catch { /* нет файла */ }
    throw e;
  }
}

// ------------------------------------------------------------ обложки
const covers = new Map(); // адрес → Promise<Uint8Array|null>
function cover(uri) {
  const url = EXT.coverUrl(uri);
  if (!url) return Promise.resolve(null);
  if (!covers.has(url)) {
    if (covers.size > 40) covers.delete(covers.keys().next().value);
    covers.set(url, (async () => {
      try {
        const r = await fetch(url, { credentials: "omit" });
        if (!r.ok || !/image\/jpe?g/.test(r.headers.get("content-type") || "")) return null;
        return new Uint8Array(await r.arrayBuffer());
      } catch {
        return null; // без обложки трек всё равно скачается
      }
    })());
  }
  return covers.get(url);
}

// ------------------------------------------------------------ ссылки на файлы
// Ссылку на файл даёт сайт — её получает сборщик во вкладке Яндекс Музыки. Просим пачкой,
// заранее для нескольких следующих треков, но не для всего альбома: ссылки живут не вечно.
const linkReqs = new Map(); // id → Promise<{url}|{error}>
function requestLinks(ids) {
  const need = ids.filter((id) => !linkReqs.has(id));
  if (!need.length) return;
  const all = chrome.runtime.sendMessage({ type: "links", ids: need })
    .then((r) => r || { error: "Вкладка Яндекс Музыки не ответила" }, (e) => ({ error: String(e.message || e) }));
  for (const id of need) {
    linkReqs.set(id, all.then((r) => (r.links && r.links[id]) || { error: r.error || "нет ссылки на файл" }));
  }
}
function forgetLink(id) {
  linkReqs.delete(id);
}

// Скачивает один трек, повторяя при обрывах. Ссылка устарела (403/410) — просит новую один раз.
async function saveTrack(dir, t, tag) {
  let renewed = false;
  for (let i = 1; ; i++) {
    checkCancel();
    const link = await linkReqs.get(t.id);
    if (!link || link.error) {
      const err = new Error((link && link.error) || "нет ссылки на файл");
      err.final = !!(link && link.final);
      throw err;
    }
    try {
      await writeTrack(dir, t.stem + ".mp3", await get(link.url), tag);
      return t.stem + ".mp3";
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      if (e instanceof HttpError && [403, 410].includes(e.status) && !renewed) {
        renewed = true;
        forgetLink(t.id);
        requestLinks([t.id]);
        continue;
      }
      if (e instanceof HttpError || i >= ATTEMPTS) throw e;
      await sleep(3000 * i);
    }
  }
}

// ------------------------------------------------------------ вид загрузки
const KIND_LABEL = { album: "Альбом", playlist: "Плейлист", tracks: "Трек" };

function itemView(data, onCancel) {
  const el = document.createElement("section");
  el.className = "card item";
  el.innerHTML = `<div class="head"><h2></h2><span class="kind"></span><button class="cancel" type="button">Отменить</button></div>` +
    `<div class="bar"><i></i></div><div class="row"><span class="st"></span><span class="er"></span></div>`;
  el.querySelector("h2").textContent = data.title;
  el.querySelector(".kind").textContent = data.kind === "tracks" && data.found > 1 ? "Треки" : KIND_LABEL[data.kind] || "";
  const cancelBtn = el.querySelector(".cancel");
  cancelBtn.addEventListener("click", () => {
    cancelBtn.disabled = true;
    cancelBtn.textContent = "Отменяю…";
    onCancel();
  });
  if (data.expected && data.found < data.expected * PARTIAL_SHARE) {
    const w = document.createElement("p");
    w.className = "warn";
    w.textContent = `Найдено только ${data.found} из ${data.expected} треков — возможно, вы не вошли в аккаунт ` +
      "или мешал VPN. Уже скачанные файлы остальных треков остаются на месте. Войдите в аккаунт и скачайте ещё раз.";
    el.append(w);
  }
  const noteEl = document.createElement("p");
  noteEl.className = "note";
  el.append(noteEl);
  const mk = (summary, hint) => {
    const d = document.createElement("details");
    d.hidden = true;
    d.innerHTML = "<summary></summary>";
    d.querySelector("summary").textContent = summary;
    if (hint) {
      const p = document.createElement("p");
      p.className = "note";
      p.textContent = hint;
      d.append(p);
    }
    el.append(d);
    return d;
  };
  const failedBox = mk("Что не скачалось", "Если не скачалось много треков, мешать может VPN, прокси или другой способ обхода " +
    "блокировок — попробуйте отключить его и скачать ещё раз: уже скачанное пропустится.");
  const skippedBox = mk("Недоступные треки", "Эти треки Яндекс Музыка не отдаёт по вашей подписке или они удалены с сайта.");
  $("items").prepend(el);
  updateEmpty();
  const st = el.querySelector(".st");
  const add = (box, text) => {
    box.hidden = false;
    const row = document.createElement("div");
    row.textContent = text;
    box.append(row);
  };
  return {
    status(text) {
      st.textContent = text;
    },
    note(text) {
      noteEl.textContent = text;
    },
    update(done, total, failed) {
      el.querySelector(".bar i").style.width = (total ? ((done + failed) / total) * 100 : 100) + "%";
      st.textContent = `Скачиваю… ${done} из ${total}`;
      el.querySelector(".er").textContent = failed ? `ошибок: ${failed}` : "";
    },
    finish(text, cls) {
      cancelBtn.remove();
      el.querySelector(".bar i").style.width = "100%";
      st.textContent = text;
      st.className = "st " + cls;
      el.classList.add("is-" + cls);
    },
    error(text) {
      add(failedBox, text);
    },
    skipped(text) {
      add(skippedBox, text);
    },
  };
}

const trackName = (t) => [t.artists, t.title].filter(Boolean).join(" — ") || `трек ${t.id}`;

async function downloadItem(data, view) {
  const signal = activeSignal || new AbortController().signal;
  view.status("Сверяю с уже скачанным…");
  const dir = await getDir(data.root);
  const stats = { total: 0, done: 0, renamed: 0, removed: 0, kept: 0, unavailable: 0 };
  // сверка может идти долго — показываем каждый шаг, а не одну надпись
  let lastStep = 0;
  const step = (text) => {
    checkCancel();
    const now = Date.now();
    if (now - lastStep < 250) return;
    lastStep = now;
    view.status(text);
  };
  const jobs = await syncFolder(data, dir, stats, step);
  for (const t of data.tracks) if (t.unavailable && !t.file) view.skipped(`${trackName(t)} — ${t.unavailable}`);
  const total = stats.total - stats.unavailable;
  let done = stats.done, failed = 0, unavailable = stats.unavailable;
  const notes = [];
  if (stats.done) notes.push(`уже было: ${stats.done}`);
  if (stats.renamed) notes.push(`перенумеровано: ${stats.renamed}`);
  if (stats.removed) notes.push(`убрано в «${removedDirOf(data)}»: ${stats.removed}`);
  if (stats.kept) notes.push(`оставлено на месте (сайт показал не все треки): ${stats.kept}`);
  if (jobs.length) notes.push(`новых: ${jobs.length}`);
  if (unavailable) notes.push(`недоступно: ${unavailable}`);
  view.note(notes.join(", "));
  view.update(done, total, failed);

  // обложка альбома — рядом с треками и в каждом файле
  let albumCover = null;
  if (data.kind === "album" && data.cover) {
    albumCover = await cover(data.cover);
    if (albumCover) {
      try {
        if ((await fileSize(dir, "cover.jpg")) <= 0) await writeText(dir, "cover.jpg", albumCover);
      } catch { /* без cover.jpg */ }
    }
  }

  let next = 0;
  async function worker() {
    while (next < jobs.length && !signal.aborted) {
      const i = next++;
      const t = jobs[i];
      requestLinks(jobs.slice(i, i + LINK_BATCH).map((x) => x.id));
      try {
        const tag = buildId3(t, albumCover || (await cover(t.cover)));
        t.file = await saveTrack(dir, t, tag);
        done++;
      } catch (e) {
        if (signal.aborted) return; // отмена — не ошибка
        if (e.final) {
          unavailable++;
          view.skipped(`${trackName(t)} — ${e.message}`);
        } else {
          failed++;
          view.error(`${trackName(t)} — ${e.message || e}`);
        }
      } finally {
        forgetLink(t.id);
      }
      view.update(done, total - (unavailable - stats.unavailable), failed);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  checkCancel();
  view.status("Записываю сведения…");
  const r = { done, total: total - (unavailable - stats.unavailable), failed, fresh: done - stats.done, unavailable };
  if (!data.single) {
    try {
      await writeInfo(data, dir, r);
    } catch (e) {
      view.error("Не удалось записать _сведения: " + (e.message || e));
    }
  }
  return r;
}

// ------------------------------------------------------------ состояние для кнопки на сайте
// Кнопка «Скачать» на Яндекс Музыке читает job:<ключ> и показывает этап и прогресс.
function setJob(job, state) {
  if (!job) return Promise.resolve();
  return chrome.storage.local.set({ ["job:" + job]: { ...state, at: Date.now() } }).catch(() => {});
}

// оборачивает вид: всё, что показывается здесь, коротко уходит и на кнопку (не чаще 3 раз в секунду)
function reportingView(view, job) {
  if (!job) return view;
  let last = 0, timer = null, latest = null;
  const flush = () => {
    timer = null;
    last = Date.now();
    setJob(job, latest);
  };
  const push = (state, now) => {
    latest = state;
    if (now) {
      clearTimeout(timer);
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, Math.max(0, 300 - (Date.now() - last)));
    }
  };
  return {
    ...view,
    status(text) {
      view.status(text);
      push({ phase: "sync", text }, true);
    },
    update(done, total, failed) {
      view.update(done, total, failed);
      push({ phase: "download", done, total, failed }, done + failed >= total);
    },
    final(state) {
      clearTimeout(timer);
      timer = null;
      setJob(job, state);
    },
  };
}

// ------------------------------------------------------------ уведомления
// Если вкладка загрузок в фоне, о конце серии загрузок сообщаем системным уведомлением.
const NOTE_ID = "ymd-done";
function notify(title, message) {
  if (!document.hidden || !chrome.notifications) return;
  try { // уведомление — не главное: если не вышло, загрузка всё равно считается удачной
    chrome.notifications.clear(NOTE_ID); // новое заменяет прежнее, а не копится стопкой
    chrome.notifications.create(NOTE_ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/128.png"),
      title,
      message,
      contextMessage: "Yandex Music Downloader",
    }, () => void chrome.runtime.lastError);
  } catch { /* без уведомления */ }
}

// Итоги копятся, пока идёт серия (очередь, «Обновить все»), а уведомление одно — когда всё закончилось.
const finished = []; // { data, r } или { data, error }
function flushNotify() {
  if (!finished.length || running) return;
  const items = finished.splice(0);
  if (items.length === 1) {
    const [x] = items;
    if (x.error) notify(`Не удалось скачать «${x.data.title}»`, x.error);
    else notifyResult(x.data, x.r);
    return;
  }
  const ok = items.filter((x) => x.r);
  const bad = items.filter((x) => x.error || x.r.failed).length;
  const fresh = ok.reduce((n, x) => n + x.r.fresh, 0);
  const nothing = ok.filter((x) => !x.r.fresh && !x.r.failed).length;
  const parts = [`Новых треков: ${fresh}.`];
  if (nothing) parts.push(`Без новых треков: ${nothing}.`);
  if (bad) parts.push(`С ошибками: ${bad} — подробности во вкладке загрузок.`);
  notify(bad ? `Загрузка закончена, с ошибками: ${bad} из ${items.length}` : `Готово, скачано загрузок: ${items.length}`,
    parts.join(" "));
}

function notifyResult(data, r) {
  const name = data.kind === "tracks" ? data.title : `«${data.title}»`;
  if (r.failed) notify(`${name}: скачано с ошибками`, `Скачано ${r.done} из ${r.total}, не скачалось: ${r.failed}. Подробности — во вкладке загрузок.`);
  else if (!r.fresh && r.total) notify(`${name}: новых треков нет`, `Всё уже было в папке (треков: ${r.total}).`);
  else notify(`${name} — скачано`, `Новых треков: ${r.fresh}, всего в папке: ${r.done}.`);
}

if (chrome.notifications) {
  // нажатие на уведомление — к вкладке загрузок
  chrome.notifications.onClicked.addListener(async (id) => {
    if (id !== NOTE_ID) return;
    chrome.notifications.clear(id);
    const t = await chrome.tabs.getCurrent();
    if (t) {
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
    }
  });
}

// ------------------------------------------------------------ очередь
const seen = new Set();
let running = false;
let currentKey = null;
let currentCtrl = null;
// задачи, отменённые кнопкой «Убрать всё», пока у них ещё собирались треки: когда они дойдут
// до очереди, сразу убираем. Если задачу потом запустят заново, отмена с неё снимается.
const cancelledJobs = new Map(); // ключ -> время отмены
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  for (const [k, v] of Object.entries(ch)) {
    const s = v.newValue;
    if (k.startsWith("job:") && s && s.phase === "collect" && s.at > (cancelledJobs.get(k.slice(4)) || Infinity)) {
      cancelledJobs.delete(k.slice(4));
    }
  }
});

// «Убрать всё»: убрать всё из очереди, отменить текущую загрузку и задачи, у которых ещё ищутся треки.
async function stopAll() {
  const now = Date.now();
  const all = await chrome.storage.local.get(null);
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("job:") && v && v.phase === "collect") {
      cancelledJobs.set(k.slice(4), now);
      await setJob(k.slice(4), { phase: "cancelled" });
    }
  }
  for (const p of all.pending || []) {
    if (p.key === currentKey && p.data) continue; // её отменяет currentCtrl
    seen.add(p.key);
    await setJob(p.job, { phase: "removed" });
    await chrome.runtime.sendMessage({ type: "taken", key: p.key, dropped: true });
  }
  if (currentCtrl) currentCtrl.abort();
  renderQueue();
}

// ------------------------------------------------------------ сбор треков для задач из очереди
// Задача, добавленная ссылкой, стоит в очереди без треков. Треки собираются, когда до неё доходит
// черёд, а у следующих — заранее, пока качается текущая.
const collecting = new Set(); // ключи строк очереди, у которых уже идёт сбор

function startCollecting(p) {
  if (collecting.has(p.key)) return;
  collecting.add(p.key);
  chrome.runtime.sendMessage({ type: "download", url: p.link, job: p.job }).catch(() => {});
}

// Ждёт, пока у строки очереди появятся треки. Итог: "ok", "removed" (убрали из очереди) или текст ошибки.
// Если вкладка сайта замолчала надолго — считаем это ошибкой, чтобы из-за одной задачи не встала вся очередь.
const COLLECT_SILENCE_MS = 4 * 60 * 1000;
function waitFilled(key, job) {
  const started = Date.now();
  return new Promise((resolve) => {
    const finish = (v) => {
      chrome.storage.onChanged.removeListener(onChange);
      clearInterval(watchdog);
      collecting.delete(key);
      resolve(v);
    };
    const watchdog = setInterval(async () => {
      const s = (await chrome.storage.local.get("job:" + job))["job:" + job];
      if (Date.now() - Math.max(started, (s && s.at) || 0) > COLLECT_SILENCE_MS) {
        finish("Яндекс Музыка долго не отвечает. Обновите вкладку Яндекс Музыки (F5) и добавьте ссылку ещё раз.");
      }
    }, 20000);
    const check = async () => {
      const got = await chrome.storage.local.get(["pending", "job:" + job]);
      const p = (got.pending || []).find((x) => x.key === key);
      if (!p) return finish("removed");
      if (p.data) return finish("ok");
      const s = got["job:" + job];
      if (s && s.phase === "error") finish(s.text || "Ошибка");
    };
    const onChange = (ch, area) => {
      if (area === "local" && (ch.pending || ch["job:" + job])) check();
    };
    chrome.storage.onChanged.addListener(onChange);
    check();
  });
}

// Пока качается альбом, треки PREFETCH ближайших задач очереди собираются заранее. Не больше:
// при длинной очереди собиралось бы всё сразу, сайт отвечал бы «подождите», а собранное устаревало бы.
const PREFETCH = 2;
async function prefetch() {
  if (!ownQueue || !currentCtrl) return; // только пока эта вкладка качает
  const { pending = [] } = await chrome.storage.local.get("pending");
  for (const p of pending.filter((x) => !seen.has(x.key)).slice(0, PREFETCH)) {
    if (!p.data && p.link && !collecting.has(p.key)) startCollecting(p);
  }
}

// Задачи, которые ждут своей очереди: пронумерованы в порядке скачивания,
// порядок меняется перетаскиванием мышью, ненужное можно убрать.
let dragging = null;     // строка, которую сейчас тащат
let renderLater = false; // очередь поменялась во время перетаскивания — перерисуем после

function renumber() {
  $("queue").querySelectorAll(".qrow").forEach((row, i) => {
    row.querySelector(".qnum").textContent = i + 1;
  });
}

async function saveOrder() {
  const keys = [...$("queue").querySelectorAll(".qrow")].map((r) => r.dataset.key);
  await chrome.runtime.sendMessage({ type: "reorder", keys });
}

// у задач без треков в строке очереди виден ход сбора
function paintQueueRow(row, s) {
  const st = row.querySelector(".qst");
  if (!st) return;
  st.textContent = s && s.phase === "collect" ? (s.text || "Ищу треки…").replace(/^.*?: /, "") : "";
  st.title = st.textContent;
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  for (const [k, v] of Object.entries(ch)) {
    if (!k.startsWith("job:")) continue;
    const row = $("queue").querySelector(`.qrow[data-job="${CSS.escape(k.slice(4))}"]`);
    if (row) paintQueueRow(row, v.newValue);
  }
});

async function renderQueue() {
  if (dragging) {
    renderLater = true;
    return;
  }
  const { pending = [] } = await chrome.storage.local.get("pending");
  const jobKeys = pending.filter((p) => !p.data && p.job).map((p) => "job:" + p.job);
  const got = jobKeys.length ? await chrome.storage.local.get(jobKeys) : {};
  const jobStates = Object.fromEntries(Object.entries(got).map(([k, v]) => [k.slice(4), v]));
  // задача, у которой сейчас собираются треки, ещё видна в очереди — её тоже можно убрать
  const waiting = pending.filter((p) => !seen.has(p.key) || (p.key === currentKey && !p.data));
  const box = $("queue");
  box.innerHTML = "";
  box.hidden = !waiting.length;
  updateEmpty();
  if (!waiting.length) return;
  const h = document.createElement("h3");
  h.textContent = `В очереди: ${waiting.length}`;
  const tip = document.createElement("small");
  if (waiting.length > 1) tip.textContent = "Порядок можно менять, перетаскивая мышью";
  h.append(tip);
  if (waiting.length > 1) {
    const all = document.createElement("button");
    all.type = "button";
    all.className = "qall";
    all.textContent = "Убрать всё";
    all.title = "Убрать всё из очереди и остановить текущую загрузку";
    all.addEventListener("click", () => {
      all.disabled = true;
      stopAll();
    });
    h.append(all);
  }
  box.append(h);
  waiting.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "qrow";
    row.dataset.key = p.key;
    row.draggable = waiting.length > 1;
    row.innerHTML = `<svg class="grip" viewBox="0 0 10 16" aria-hidden="true"><g fill="currentColor">` +
      `<circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/>` +
      `<circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></g></svg>` +
      `<span class="qnum"></span><span class="qname"></span><span class="qst"></span>`;
    row.querySelector(".qnum").textContent = i + 1;
    row.querySelector(".qname").textContent = p.data ? p.data.title : p.title;
    if (p.job) row.dataset.job = p.job;
    if (p.key === currentKey) row.draggable = false; // уже идёт
    paintQueueRow(row, jobStates[p.job]);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "Убрать";
    rm.draggable = false;
    rm.addEventListener("click", async () => {
      rm.disabled = true;
      seen.add(p.key);
      await setJob(p.job, { phase: "removed" });
      await chrome.runtime.sendMessage({ type: "taken", key: p.key, dropped: true });
      renderQueue();
    });
    row.append(rm);

    row.addEventListener("dragstart", (e) => {
      dragging = row;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", p.key);
    });
    row.addEventListener("dragover", (e) => {
      if (!dragging || dragging === row) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      row.parentElement.insertBefore(dragging, after ? row.nextSibling : row);
      renumber();
    });
    row.addEventListener("drop", (e) => e.preventDefault());
    row.addEventListener("dragend", async () => {
      row.classList.remove("dragging");
      dragging = null;
      await saveOrder();
      if (renderLater) {
        renderLater = false;
        renderQueue();
      }
    });
    box.append(row);
  });
}

async function run() {
  if (running) return;
  running = true; // ставим сразу: пока ждём папку, могут прийти новые задачи
  if (!(await ensureRoot())) {
    running = false;
    // задачи ждут, пока выберут папку, — пусть кнопка на сайте об этом скажет
    const { pending = [] } = await chrome.storage.local.get("pending");
    for (const p of pending) if (!seen.has(p.key)) await setJob(p.job, { phase: "folder" });
    return;
  }
  try {
    // пока ждать нечего, очередь не занимаем — иначе другие вкладки зря решат, что она занята
    if (await hasWork()) await withQueueLock(processQueue);
  } finally {
    running = false;
    renderQueue();
    flushNotify();
  }
}

async function hasWork() {
  const { pending = [] } = await chrome.storage.local.get("pending");
  return pending.some((p) => !seen.has(p.key));
}

// Если открыто несколько вкладок загрузок, очередь качает только одна — иначе они скачивали бы
// одно и то же наперегонки. Та, что качает, каждые несколько секунд отмечается в хранилище.
// Остальные ждут, только пока эта отметка свежая: зависшая или скрытая браузером страница
// может держать очередь, не качая, — тогда её забираем.
const QUEUE_LOCK = "ymd-queue";
const PAGE_ID = Math.random().toString(36).slice(2);
const OWNER_FRESH_MS = 12000;
let ownQueue = false;
let queueLost = false; // другая вкладка забрала очередь («Качать здесь») — эта перестаёт качать

// очередь забрали: текущую загрузку прерываем, а саму задачу оставляем в очереди — её докачает та вкладка
function lostQueue() {
  queueLost = true;
  if (currentCtrl) currentCtrl.abort();
}

async function ownerAlive() {
  try {
    const { queueOwner: o } = await chrome.storage.local.get("queueOwner");
    return !!(o && o.id !== PAGE_ID && Date.now() - o.at < OWNER_FRESH_MS);
  } catch {
    return false;
  }
}

async function withQueueLock(fn) {
  if (!navigator.locks) return fn();
  if (ownQueue) return; // эта страница уже качает очередь
  let done = false;
  const body = async (lock) => {
    if (!lock || done) return;
    done = true;
    ownQueue = true;
    queueLost = false;
    $("other").hidden = true;
    const beat = () => chrome.storage.local.set({ queueOwner: { id: PAGE_ID, at: Date.now() } }).catch(() => {});
    await beat();
    const timer = setInterval(beat, 4000);
    try {
      await fn();
    } finally {
      clearInterval(timer);
      ownQueue = false;
      chrome.storage.local.remove("queueOwner").catch(() => {});
    }
  };
  const request = (opts) => navigator.locks.request(QUEUE_LOCK, opts, body)
    .catch((e) => { if (e && e.name === "AbortError") lostQueue(); });
  await request({ ifAvailable: true });
  if (done) return;
  await new Promise((resolve) => {
    let timer = null;
    const take = () => {
      if (done) return;
      clearInterval(timer);
      request({ steal: true }).then(resolve);
    };
    // «Качать здесь» — забрать очередь, даже если та вкладка ещё качает
    $("otherTake").onclick = take;
    $("otherGo").onclick = () => chrome.runtime.sendMessage({ type: "open", other: true });
    const check = async () => {
      if (done) return;
      if (await ownerAlive()) {
        $("other").hidden = false;
      } else {
        take();
      }
    };
    // та вкладка закроется — замок освободится сам
    request({}).then(() => {
      if (done && !ownQueue) { clearInterval(timer); resolve(); }
    });
    setTimeout(check, 1500); // даём той вкладке отметиться, если она только начала
    timer = setInterval(check, 5000);
  });
}

async function processQueue() {
  while (!queueLost) {
    const { pending = [] } = await chrome.storage.local.get("pending");
    let item = pending.find((p) => !seen.has(p.key));
    if (!item) break;
    seen.add(item.key);
    if (!item.data) { // треки ещё не собраны — собираем сейчас
      currentKey = item.key;
      renderQueue();
      startCollecting(item);
      const res = await waitFilled(item.key, item.job);
      currentKey = null;
      if (queueLost) { seen.delete(item.key); break; }
      if (res === "removed") continue;
      if (res !== "ok") {
        const view = itemView({ title: item.title, kind: "" }, () => {});
        view.finish("Не удалось собрать треки", "failed");
        view.error(`${item.link} — ${res}`);
        finished.push({ data: { title: item.title }, error: res });
        await setJob(item.job, { phase: "error", text: res });
        // если сбор всё же закончится позже, его итог не нужен — иначе задача встанет в очередь второй раз
        await chrome.runtime.sendMessage({ type: "taken", key: item.key, dropped: true });
        continue;
      }
      const now = (await chrome.storage.local.get("pending")).pending || [];
      item = now.find((p) => p.key === item.key);
      if (!item) continue;
    }
    if (item.job && cancelledJobs.has(item.job)) { // остановили, пока собирались треки
      cancelledJobs.delete(item.job);
      await setJob(item.job, { phase: "cancelled" });
      await chrome.runtime.sendMessage({ type: "taken", key: item.key });
      continue;
    }
    currentKey = item.key;
    renderQueue();

    const ctrl = new AbortController();
    currentCtrl = ctrl;
    activeSignal = ctrl.signal;
    prefetch();
    const view = reportingView(itemView(item.data, () => ctrl.abort()), item.job);
    try {
      const r = await downloadItem(item.data, view);
      const extra = r.unavailable ? `, недоступно: ${r.unavailable}` : "";
      view.finish(r.fresh || r.failed || !r.total ? `Готово ${r.done} из ${r.total}${extra}`
        : `Новых треков нет — все (${r.total}) уже были в папке${extra}`, "done");
      if (view.final) view.final({ phase: "done", ...r });
      finished.push({ data: item.data, r });
      if (typeof libraryChanged === "function") libraryChanged();
    } catch (e) {
      if (queueLost) {
        view.finish("Загрузка продолжится в другой вкладке загрузок.", "cancelled");
      } else if (ctrl.signal.aborted) {
        view.finish("Отменено. Уже скачанное осталось в папке, повторный запуск докачает остальное.", "cancelled");
        if (view.final) view.final({ phase: "cancelled" });
      } else {
        view.finish("Не удалось сохранить", "failed");
        view.error(e.message || String(e));
        if (view.final) view.final({ phase: "failed", text: e.message || String(e) });
        finished.push({ data: item.data, error: e.message || String(e) });
      }
    } finally {
      activeSignal = null;
      currentKey = null;
      currentCtrl = null;
      linkReqs.clear();
    }
    if (queueLost) { seen.delete(item.key); break; } // задача остаётся в очереди для той вкладки
    await chrome.runtime.sendMessage({ type: "taken", key: item.key });
  }
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.pending) {
    renderQueue();
    run();
    prefetch(); // у одной из задач собрались треки — можно начать следующую
  }
});
$("pick").addEventListener("click", pickFolder);

(async () => {
  const saved = await loadRoot().catch(() => null);
  if (saved) $("folderName").textContent = saved.name;
  renderQueue();
  run();
})();

// ------------------------------------------------------------ обновление расширения
const loadExtDir = () => idb("readonly", (s) => s.get("extDir"));
const saveExtDir = (h) => idb("readwrite", (s) => s.put(h, "extDir"));
let release = null;

// Текст релиза (Markdown) — в простые абзацы, списки и жирный, без innerHTML
function renderNotes(md, box) {
  box.textContent = "";
  let list = null;
  const inline = (parent, text) => {
    text.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
      if (!part) return;
      if (/^\*\*[^*]+\*\*$/.test(part)) {
        const b = document.createElement("b");
        b.textContent = part.slice(2, -2);
        parent.append(b);
      } else parent.append(part.replace(/`/g, ""));
    });
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    if (/^#{1,6}\s/.test(line)) {
      list = null;
      const h = document.createElement("h4");
      inline(h, line.replace(/^#+\s*/, ""));
      box.append(h);
    } else if (/^[-*]\s/.test(line)) {
      if (!list) { list = document.createElement("ul"); box.append(list); }
      const li = document.createElement("li");
      inline(li, line.replace(/^[-*]\s*/, ""));
      list.append(li);
    } else {
      list = null;
      const p = document.createElement("p");
      inline(p, line);
      box.append(p);
    }
  }
}

function updStep(text, isError) {
  $("updStep").textContent = text || "";
  $("updStep").className = "upd-step" + (isError ? " err" : "");
}

function showRelease(u) {
  // сравниваем с установленной версией сейчас, а не на момент проверки
  if (!u || !u.version || compareVersions(u.version, VERSION) <= 0) {
    $("upd").hidden = true;
    return;
  }
  release = u;
  $("upd").hidden = false;
  $("updTitle").textContent = `Доступна версия ${u.version}`;
  $("updSub").textContent = `Сейчас установлена ${VERSION}. Обновление займёт несколько секунд.`;
  $("updGo").hidden = false;
  $("updClose").hidden = true;
  $("updNotes").hidden = !u.notes;
  if (u.notes) renderNotes(u.notes, $("updNotesText"));
}

function showChecked(u) {
  if (!u || !u.checkedAt) return;
  const when = new Date(u.checkedAt).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const newer = u.version && compareVersions(u.version, VERSION) > 0;
  $("updChecked").textContent = u.error ? `не удалось проверить (${when})` : newer ? "" : `последняя версия, проверено ${when}`;
}

// Папка, из которой расширение загружено в браузер: спрашиваем один раз и запоминаем.
async function getExtensionDir() {
  const saved = await loadExtDir().catch(() => null);
  if (saved && (await hasPermission(saved, true))) {
    const problem = await checkExtensionDir(saved);
    if (!problem) return saved;
    if (problem.ahead) return { dir: saved, ahead: problem.ahead };
  }
  updStep("Выберите папку, в которую распакован архив расширения: в ней лежат manifest.json и подпапка icons. При выборе папки файлы не видны — ориентируйтесь на подпапку icons. Это нужно один раз.");
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: "ymd-ext", mode: "readwrite", startIn: "documents" });
  } catch (e) {
    if (e.name === "AbortError") { updStep(""); return null; }
    throw e;
  }
  const problem = await checkExtensionDir(dir);
  if (problem && problem.ahead) {
    await saveExtDir(dir);
    return { dir, ahead: problem.ahead };
  }
  if (problem) {
    updStep(problem, true);
    return null;
  }
  await saveExtDir(dir);
  return dir;
}

$("updGo").addEventListener("click", async () => {
  if (!release) return;
  if (currentKey && !confirm("Сейчас идёт загрузка. Она прервётся, а после обновления продолжится с того же места. Обновить?")) return;
  $("updGo").disabled = true;
  try {
    const dir = await getExtensionDir();
    if (!dir) return;
    if (dir.ahead) {
      // новые файлы уже на месте — достаточно перезапустить расширение
      await chrome.runtime.sendMessage({ type: "installing", version: dir.ahead });
      updStep(`В папке уже версия ${dir.ahead} — перезапускаю расширение…`);
      setTimeout(() => chrome.runtime.reload(), 600);
      return;
    }
    await chrome.runtime.sendMessage({ type: "installing", version: release.version });
    await installUpdate(dir, release, (t) => updStep(t));
    updStep("Готово. Перезапускаю расширение…");
    setTimeout(() => chrome.runtime.reload(), 400);
  } catch (e) {
    // чаще всего замену файлов блокирует антивирус — подсказываем, что делать
    updStep(`${String(e.message || e).replace(/\.$/, "")}. Если папка выбрана верно, возможно, менять файлы расширения не даёт антивирус: ` +
      "добавьте папку расширения (и при необходимости папку браузера) в исключения или отключите его на время обновления. " +
      "Либо обновите расширение вручную — инструкция в README.", true);
  } finally {
    $("updGo").disabled = false;
  }
});

$("updClose").addEventListener("click", () => { $("upd").hidden = true; });

// Перезапуск расширения — когда что-то зависло. Вкладка загрузок закроется вместе с ним,
// поэтому фоновый скрипт после перезапуска откроет её снова (флаг reopenDownloader).
$("reloadExt").addEventListener("click", async (e) => {
  e.preventDefault();
  if (currentKey && !confirm("Сейчас идёт загрузка. Она прервётся, а после перезапуска продолжится с того же места: уже скачанные треки пропустятся. Перезапустить?")) return;
  await chrome.storage.local.set({ reopenDownloader: true });
  chrome.runtime.reload();
});

$("updCheck").addEventListener("click", async (e) => {
  e.preventDefault();
  $("updChecked").textContent = "проверяю…";
  const u = await chrome.runtime.sendMessage({ type: "checkUpdate", force: true });
  showRelease(u);
  showChecked(u);
});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.update && !$("updGo").disabled) {
    showRelease(ch.update.newValue);
    showChecked(ch.update.newValue);
  }
});

(async () => {
  const { justUpdated, update } = await chrome.storage.local.get(["justUpdated", "update"]);
  if (justUpdated && justUpdated.to === VERSION) {
    await chrome.storage.local.remove("justUpdated");
    $("upd").hidden = false;
    $("updTitle").textContent = `Расширение обновлено до версии ${VERSION}`;
    $("updSub").textContent = "Обновите открытые вкладки Яндекс Музыки (F5), чтобы на них заработала новая версия.";
    $("updGo").hidden = true;
    $("updClose").hidden = false;
    if (update && update.notes && update.version === VERSION) {
      $("updNotes").hidden = false;
      renderNotes(update.notes, $("updNotesText"));
    }
    return;
  }
  showRelease(update);
  showChecked(update);
  const fresh = await chrome.runtime.sendMessage({ type: "checkUpdate" }).catch(() => null);
  if (fresh) {
    showRelease(fresh);
    showChecked(fresh);
  }
})();
