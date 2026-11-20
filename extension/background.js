// Разбирает ссылку, находит вкладку Яндекс Музыки, собирает в ней треки и передаёт их вкладке загрузок.
// Ссылки на файлы треков вкладка загрузок тоже получает через вкладку сайта (сообщение links).
// Заодно следит за новыми версиями на GitHub.

importScripts("common.js", "update.js");

const PAGE = chrome.runtime.getURL("downloader.html");
const { parseLink, keyOfLink, isMusicHost } = EXT;
const SITE_TABS = chrome.runtime.getManifest().content_scripts[0].matches;

// ------------------------------------------------------------ обновления
async function refreshBadge(update) {
  const on = !!(update && update.version && compareVersions(update.version, currentVersion()) > 0);
  await chrome.action.setBadgeText({ text: on ? "↑" : "" });
  if (on) await chrome.action.setBadgeBackgroundColor({ color: "#1a7f37" });
  await chrome.action.setTitle({
    title: on ? `Доступна версия ${update.version} — откройте, чтобы обновить` : "Скачать с Яндекс Музыки",
  });
}

async function updateCheck(force) {
  const u = await checkForUpdate(force);
  await refreshBadge(u);
  return u;
}

// фоновый скрипт просыпается часто — создаём напоминание один раз, а не при каждом пробуждении
chrome.alarms.get("update-check").then((a) => {
  if (!a) chrome.alarms.create("update-check", { periodInMinutes: 12 * 60, delayInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "update-check") updateCheck(false); // не чаще раза в 12 часов
});

// После перезапуска браузера или расширения ни один сбор и ни одна загрузка уже не идут:
// старые состояния убираем, а то, что стоит в очереди, снова показываем как «В очереди».
// Иначе кнопки на сайте и список «Мои загрузки» навсегда застревали бы на «Ищу треки…».
async function resetJobs() {
  const all = await chrome.storage.local.get(null);
  const queued = new Set((all.pending || []).map((p) => p.job).filter(Boolean));
  const remove = [], set = {};
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith("job:")) continue;
    if (!queued.has(k.slice(4))) remove.push(k);
    else if (!v || v.phase !== "queued") set[k] = { phase: "queued", at: Date.now() };
  }
  if (remove.length) await chrome.storage.local.remove(remove);
  if (Object.keys(set).length) await chrome.storage.local.set(set);
  await chrome.storage.local.remove(["queueOwner", "status"]);
}

chrome.runtime.onStartup.addListener(() => {
  updateCheck(false);
  resetJobs();
});

// «Перезагрузить расширение» во вкладке загрузок: после перезапуска открываем её снова
chrome.storage.local.get("reopenDownloader").then(async ({ reopenDownloader }) => {
  if (!reopenDownloader) return;
  await chrome.storage.local.remove("reopenDownloader");
  await resetJobs();
  await openDownloader();
});

// ------------------------------------------------------------ ссылки
function classify(raw) {
  const s = String(raw || "").trim();
  if (!s) throw new Error("Вставьте ссылку на альбом, плейлист или трек.");
  if (/^\d{3,}$/.test(s)) return { kind: "track", track: s }; // просто id трека
  const l = parseLink(s);
  if (l) return l;
  let host = "";
  try { host = new URL(/^[a-z]+:/i.test(s) ? s : "https://" + s).hostname; } catch { /* не ссылка */ }
  if (!host) throw new Error("Это не похоже на ссылку.");
  if (!isMusicHost(host)) throw new Error("Это не ссылка на Яндекс Музыку.");
  throw new Error("Это не ссылка на альбом, плейлист, трек или исполнителя. Откройте нужную страницу и скопируйте адрес из адресной строки.");
}

// ------------------------------------------------------------ вкладка Яндекс Музыки
// Если открытой вкладки сайта нет, открываем свою в фоне. Закрываем её не сразу, а когда она
// минуту не нужна: через неё же идут ссылки на файлы, пока качается альбом.
const TEMP_IDLE_MS = 60000;
let tempCloseTimer = null;
let tabUsers = 0; // сколько дел идёт сейчас через вкладку сайта
const getTempTab = async () => (await chrome.storage.session.get("tempTab")).tempTab || null;
const setTempTab = (id) => chrome.storage.session.set({ tempTab: id });

function waitLoaded(tabId) {
  return new Promise((resolve) => {
    const done = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, 30000);
  });
}

const onSite = (t) => { try { return !!t.url && isMusicHost(new URL(t.url).hostname); } catch { return false; } };

async function siteTab(preferId) {
  clearTimeout(tempCloseTimer); // вкладка снова нужна — не закрываем
  if (preferId) {
    try {
      const t = await chrome.tabs.get(preferId);
      if (onSite(t)) return t.id;
    } catch { /* вкладка закрыта */ }
  }
  const open = (await chrome.tabs.query({ url: SITE_TABS })).filter((t) => !t.discarded);
  const ready = open.find((t) => t.status === "complete") || open[0];
  if (ready) return ready.id;
  // открытой вкладки нет — открываем в фоне и закроем, когда станет не нужна
  const t = await chrome.tabs.create({ url: "https://music.yandex.ru/", active: false });
  await setTempTab(t.id);
  await waitLoaded(t.id);
  return t.id;
}

// дело через вкладку сайта закончилось; своя временная вкладка закрывается, когда минуту никому не нужна
function releaseTab(tabId) {
  tabUsers = Math.max(0, tabUsers - 1);
  if (tabUsers || tabId == null) return;
  clearTimeout(tempCloseTimer);
  tempCloseTimer = setTimeout(async () => {
    const id = await getTempTab();
    if (id !== tabId || tabUsers) return;
    await setTempTab(null);
    chrome.tabs.remove(id).catch(() => {});
  }, TEMP_IDLE_MS);
}

const inject = (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: ["common.js", "content.js"] });

// Запрос к сборщику во вкладке сайта с ответом (списки, ссылки на файлы)
async function askSite(msg, preferTabId) {
  const tabId = await siteTab(preferTabId);
  tabUsers++;
  try {
    await inject(tabId);
    const r = await chrome.tabs.sendMessage(tabId, msg);
    if (!r) throw new Error("Вкладка Яндекс Музыки не ответила. Обновите её (F5) и попробуйте ещё раз.");
    return r;
  } finally {
    releaseTab(tabId);
  }
}

// Сбор треков: ответ придёт отдельным сообщением collected или error.
async function startCollect(target, preferTabId, job) {
  const tabId = await siteTab(preferTabId);
  tabUsers++;
  try {
    await inject(tabId);
    await chrome.tabs.sendMessage(tabId, { cmd: "collect", target, job });
  } catch (e) {
    releaseTab(tabId);
    throw e;
  }
}

// ------------------------------------------------------------ состояние задач для кнопки на сайте
async function setJob(job, state) {
  if (job) await chrome.storage.local.set({ ["job:" + job]: { ...state, at: Date.now() } });
}

// Этот альбом уже собирается (сбор сообщал о себе недавно) — второй сбор не запускаем:
// иначе два сбора наперебой пишут свой счётчик, а альбом встаёт в очередь дважды.
const COLLECT_FRESH_MS = 4 * 60 * 1000;
async function alreadyCollecting(job) {
  if (!job) return false;
  const s = (await chrome.storage.local.get("job:" + job))["job:" + job];
  return !!(s && s.phase === "collect" && Date.now() - (s.at || 0) < COLLECT_FRESH_MS);
}

// Исполнитель и коллекция скачиваются через выбор во вкладке загрузок: туда передаём ссылку.
async function sendToPicker(url) {
  await chrome.storage.local.set({ pickLink: { url, at: Date.now() } });
  await openDownloader(true);
}

async function download(url, tabId, job, quiet = false) {
  let target;
  try {
    target = classify(url);
  } catch (e) {
    await setStatus({ error: e.message || String(e) });
    await setJob(job, { phase: "error", text: e.message || String(e) });
    return job;
  }
  if (target.kind === "artist" || target.kind === "collection") {
    await setStatus({ text: "Выберите, что скачать, во вкладке загрузок.", done: true });
    await sendToPicker(url);
    return job;
  }
  await setStatus({ text: "Ищу треки…" });
  // по ключу кнопка на странице видит, что происходит; у трека из меню свой ключ — по нему ждёт ответа
  job = job || keyOfLink(target);
  try {
    if (await alreadyCollecting(job)) return job;
    const q = (await quietJobs()).filter((j) => j !== job);
    if (quiet) q.push(job);
    await chrome.storage.session.set({ quietJobs: q.slice(-500) });
    await setDropped(job, false);
    await setJob(job, { phase: "collect", text: "Ищу треки…" });
    await startCollect(target, tabId, job);
  } catch (e) {
    await setStatus({ error: e.message || String(e) });
    await setJob(job, { phase: "error", text: e.message || String(e) });
  }
  return job;
}

// ------------------------------------------------------------ очередь
// Очередь (pending) меняют сообщения от разных страниц и вкладок сайта. Чтение и запись
// идут строго по одному, иначе одновременные изменения затирали бы друг друга.
let pendingChain = Promise.resolve();
function editPending(fn) {
  const p = pendingChain.then(async () => {
    const { pending = [] } = await chrome.storage.local.get("pending");
    const next = await fn(pending);
    await chrome.storage.local.set({ pending: next || pending });
  });
  pendingChain = p.catch(() => {});
  return p;
}

// ------------------------------------------------------------ вкладка загрузок
// Уже открытая вкладка загрузок (любая, если их несколько) или null.
async function findDownloader(exceptTabId = -1) {
  const usable = (t) => t && t.id !== exceptTabId;
  if (chrome.runtime.getContexts) {
    try {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
      for (const c of ctx) {
        if (!(c.tabId >= 0) || c.tabId === exceptTabId || !String(c.documentUrl || "").startsWith(PAGE)) continue;
        const t = await chrome.tabs.get(c.tabId).catch(() => null);
        if (usable(t)) return t;
      }
      return null; // список точный — запасной способ не нужен
    } catch { /* старый браузер — ниже запасной способ */ }
  }
  const { downloaderTab } = await chrome.storage.session.get("downloaderTab");
  if (downloaderTab) {
    try {
      const t = await chrome.tabs.get(downloaderTab);
      if (usable(t) && t.url && t.url.startsWith(PAGE)) return t;
    } catch { /* вкладку закрыли */ }
  }
  return null;
}

// Открывает вкладку загрузок, только если её ещё нет; focus — переключиться на неё.
async function openDownloader(focus = true, exceptTabId = -1) {
  const t = await findDownloader(exceptTabId);
  if (t) {
    if (focus) {
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
    }
    return;
  }
  const created = await chrome.tabs.create({ url: PAGE, active: focus });
  await chrome.storage.session.set({ downloaderTab: created.id });
}

// Ссылки, добавленные из самой вкладки загрузок: по ним не надо на неё переключать.
const quietJobs = async () => (await chrome.storage.session.get("quietJobs")).quietJobs || [];
// Задачи, которые убрали из очереди, пока у них собирались треки: собранное выбрасываем.
const droppedJobs = async () => (await chrome.storage.session.get("droppedJobs")).droppedJobs || [];
async function setDropped(job, on) {
  const list = (await droppedJobs()).filter((j) => j !== job);
  if (on) list.push(job);
  await chrome.storage.session.set({ droppedJobs: list.slice(-500) });
}

async function setStatus(status) {
  await chrome.storage.local.set({ status });
}

function describe(target) {
  const kinds = { album: "Альбом", track: "Трек", playlist: "Плейлист", artist: "Исполнитель", collection: "Плейлисты" };
  return kinds[target.kind] || "";
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === "download") {
      const fromPage = !!(sender.url && sender.url.startsWith(PAGE));
      // вкладка загрузок сама просит скачать — вкладкой сайта будет любая, а не она
      const job = await download(msg.url, fromPage ? null : msg.tabId || (sender.tab && sender.tab.id), msg.job, fromPage);
      reply({ ok: true, job });
      return;
    } else if (msg.type === "inspect") {
      // что за ссылка — для поля ссылок во вкладке загрузок
      try {
        const t = classify(msg.url);
        reply({ ...t, label: describe(t), job: keyOfLink(t) });
      } catch (e) {
        reply({ error: e.message || String(e) });
      }
      return;
    } else if (msg.type === "listAlbums") {
      reply(await askSite({ cmd: "albums", artist: msg.artist }).catch((e) => ({ error: e.message || String(e) })));
      return;
    } else if (msg.type === "listPlaylists") {
      reply(await askSite({ cmd: "playlists", owner: msg.owner }).catch((e) => ({ error: e.message || String(e) })));
      return;
    } else if (msg.type === "links") {
      // ссылки на файлы треков — прямо перед их скачиванием
      reply(await askSite({ cmd: "links", ids: msg.ids }).catch((e) => ({ error: e.message || String(e) })));
      return;
    } else if (msg.type === "progress") {
      await setStatus({ text: msg.text });
      await setJob(msg.job, { phase: "collect", text: msg.text });
    } else if (msg.type === "error") {
      releaseTab(sender.tab && sender.tab.id);
      await setStatus({ error: msg.text });
      await setJob(msg.job, { phase: "error", text: msg.text });
    } else if (msg.type === "queueLinks") {
      // ссылки из вкладки загрузок сразу встают в очередь, а треки у них соберутся в свой черёд
      const added = [];
      await editPending((pending) => {
        const have = new Set(pending.map((p) => p.job).filter(Boolean));
        for (const it of msg.items || []) {
          if (!it.url || (it.job && have.has(it.job))) continue;
          if (it.job) have.add(it.job);
          added.push({ key: `link-${Date.now()}-${added.length}`, link: it.url, job: it.job || null, title: it.title || it.url });
        }
        return [...pending, ...added];
      });
      for (const p of added) await setJob(p.job, { phase: "queued" });
      reply({ added: added.length, skipped: (msg.items || []).length - added.length });
      return;
    } else if (msg.type === "collected") {
      releaseTab(sender.tab && sender.tab.id);
      if (msg.job && (await droppedJobs()).includes(msg.job)) {
        await setDropped(msg.job, false);
        await setJob(msg.job, { phase: "removed" });
        reply({ ok: true });
        return;
      }
      await editPending((pending) => {
        // задача уже стоит в очереди (ждёт треков или ещё не начала качаться) — обновляем её место,
        // а не добавляем вторую такую же в конец
        const slot = msg.job && (pending.find((p) => !p.data && p.job === msg.job)
          || pending.find((p) => p.data && p.job === msg.job));
        if (slot) {
          slot.data = msg.data;
          delete slot.link;
        } else {
          pending.push({ key: `${msg.data.id}-${Date.now()}`, data: msg.data, job: msg.job || null });
        }
      });
      await setJob(msg.job, { phase: "queued", found: msg.data.found });
      await setStatus({ text: `${msg.data.title}: загрузка идёт во вкладке загрузок.`, done: true });
      // нажали на сайте — переходим во вкладку загрузок; добавили из неё самой — никуда не переключаем
      await openDownloader(!(msg.job && (await quietJobs()).includes(msg.job)));
    } else if (msg.type === "reorder") {
      // новый порядок ожидающих загрузок; то, чего нет в списке (текущая или только что
      // добавленная загрузка), остаётся после них
      await editPending((pending) => {
        const pos = new Map(msg.keys.map((k, i) => [k, i]));
        const listed = pending.filter((p) => pos.has(p.key)).sort((a, b) => pos.get(a.key) - pos.get(b.key));
        return [...listed, ...pending.filter((p) => !pos.has(p.key))];
      });
    } else if (msg.type === "taken") {
      await editPending(async (pending) => {
        const gone = pending.find((p) => p.key === msg.key);
        // убрали задачу, у которой треки ещё не собраны: если сбор уже идёт, его итог не нужен
        if (gone && !gone.data && gone.job && msg.dropped) await setDropped(gone.job, true);
        return pending.filter((p) => p.key !== msg.key);
      });
    } else if (msg.type === "open") {
      // «Перейти к ней» из второй вкладки загрузок — к той, что качает, а не к себе же
      await openDownloader(true, msg.other && sender.tab ? sender.tab.id : -1);
    } else if (msg.type === "checkUpdate") {
      reply(await updateCheck(!!msg.force));
      return;
    } else if (msg.type === "installing") {
      // вкладка загрузок сейчас перезапустит расширение — запомним, чтобы потом сказать «Обновлено»
      await chrome.storage.local.set({ justUpdated: { from: currentVersion(), to: msg.version } });
    }
    reply({ ok: true });
  })();
  return true;
});

// ------------------------------------------------------------ установка и меню правой кнопки
chrome.runtime.onInstalled.addListener(async (details) => {
  await resetJobs();
  // после обновления в один клик открываем вкладку загрузок с сообщением «Обновлено»
  const { justUpdated } = await chrome.storage.local.get("justUpdated");
  if (details.reason === "update" && justUpdated && justUpdated.to === currentVersion()) {
    await openDownloader();
  }
  updateCheck(true);
});

// ссылки на треки, альбомы и плейлисты на страницах сайта
const LINK_PATTERNS = SITE_TABS.flatMap((p) => {
  const base = p.replace(/\/\*$/, "");
  return [`${base}/album/*`, `${base}/track/*`, `${base}/playlists/*`, `${base}/users/*/playlists/*`];
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "ymd-link",
      title: "Скачать через Yandex Music Downloader",
      contexts: ["link"],
      targetUrlPatterns: LINK_PATTERNS,
    });
    chrome.contextMenus.create({
      id: "ymd-page",
      title: "Скачать эту страницу",
      contexts: ["page"],
      documentUrlPatterns: LINK_PATTERNS,
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === "ymd-link" ? info.linkUrl : info.pageUrl;
  download(url, tab && tab.id);
});
