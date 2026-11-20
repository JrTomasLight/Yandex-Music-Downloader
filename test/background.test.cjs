// background.js: сброс застывших этапов, второй сбор того же альбома, очередь, разбор ссылок, меню.
const test = require("node:test");
const assert = require("node:assert/strict");
const { chromeStub, loadScripts } = require("./stub.cjs");

const SITE_TAB = { id: 7, url: "https://music.yandex.ru/album/1", status: "complete" };

function boot(local = {}) {
  const env = chromeStub({
    local,
    overrides: {
      tabs: { query: async () => [SITE_TAB], get: async (id) => (id === 7 ? SITE_TAB : { id, url: "chrome-extension://test/downloader.html" }) },
    },
  });
  const menus = [];
  env.chrome.contextMenus.create = (m) => menus.push(m);
  const ctx = loadScripts(["common.js", "update.js", "background.js"], { chrome: env.chrome }, "({ classify })");
  return { ...env, menus, api: ctx.__result };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const plain = (v) => JSON.parse(JSON.stringify(v));

test("после обновления: этапы «идёт» сброшены, очередь снова «В очереди»", async () => {
  const env = boot({
    pending: [{ key: "a", job: "album/1", link: "https://music.yandex.ru/album/1" }],
    "job:album/1": { phase: "collect", text: "Ищу треки…", at: 1 },
    "job:album/2": { phase: "download", at: 1 },
    "job:album/3": { phase: "done", at: 1 },
    queueOwner: { id: "z", at: 1 },
    status: { text: "Ищу треки…" },
  });
  await env.fire("onInstalled", { reason: "update" });
  await settle();
  assert.deepEqual(Object.keys(env.local).filter((k) => k.startsWith("job:")), ["job:album/1"]);
  assert.equal(env.local["job:album/1"].phase, "queued");
  assert.equal(env.local.queueOwner, undefined);
  assert.equal(env.local.status, undefined);
});

test("меню правой кнопки — на ссылках и страницах альбомов, треков и плейлистов", async () => {
  const env = boot();
  await env.fire("onInstalled", { reason: "install" });
  await settle();
  const link = env.menus.find((m) => m.id === "ymd-link");
  assert.ok(link.targetUrlPatterns.includes("https://music.yandex.ru/album/*"));
  assert.ok(link.targetUrlPatterns.includes("https://music.yandex.kz/playlists/*"));
  assert.ok(env.menus.find((m) => m.id === "ymd-page"));
});

test("classify: ссылки, id трека и понятные ошибки", () => {
  const { api } = boot();
  assert.deepEqual(plain(api.classify("music.yandex.ru/album/5")), { kind: "album", album: "5" });
  assert.deepEqual(plain(api.classify("12345")), { kind: "track", track: "12345" });
  assert.throws(() => api.classify(""), /Вставьте ссылку/);
  assert.throws(() => api.classify("https://example.com/album/1"), /не ссылка на Яндекс Музыку/);
  assert.throws(() => api.classify("https://music.yandex.ru/search?text=x"), /не ссылка на альбом/);
  assert.throws(() => api.classify("просто текст"), /не похоже на ссылку|не ссылка/);
});

test("второй сбор того же альбома не запускается, итог не дублирует очередь", async () => {
  const env = boot();
  const url = "https://music.yandex.ru/album/1";
  const page = { url: "chrome-extension://test/downloader.html", tab: { id: 3 } };
  await env.message({ type: "queueLinks", items: [{ url, job: "album/1", title: "Альбом" }] }, page);
  await env.message({ type: "download", url, job: "album/1" }, page);
  await env.message({ type: "download", url, job: "album/1" }, page); // вкладку загрузок обновили — просит снова
  const collects = env.sent.filter((m) => m.cmd === "collect");
  assert.equal(collects.length, 1);
  assert.deepEqual(plain(collects[0].target), { kind: "album", album: "1" });
  const data = { id: "album/1", title: "Альбом", found: 2, tracks: [] };
  await env.message({ type: "collected", data, job: "album/1" }, { tab: { id: 7 } });
  await env.message({ type: "collected", data, job: "album/1" }, { tab: { id: 7 } }); // запоздавший второй сбор
  await settle();
  assert.equal(env.local.pending.length, 1);
  assert.ok(env.local.pending[0].data);
  assert.equal(env.local.pending[0].link, undefined);
  assert.equal(env.local["job:album/1"].phase, "queued");
});

test("убрали из очереди во время сбора — собранное выбрасывается", async () => {
  const env = boot();
  const url = "https://music.yandex.ru/album/2";
  await env.message({ type: "queueLinks", items: [{ url, job: "album/2", title: "Альбом" }] });
  await env.message({ type: "download", url, job: "album/2" });
  const key = env.local.pending[0].key;
  await env.message({ type: "taken", key, dropped: true });
  await env.message({ type: "collected", data: { id: "album/2", title: "Альбом", found: 1, tracks: [] }, job: "album/2" }, { tab: { id: 7 } });
  await settle();
  assert.equal(env.local.pending.length, 0);
  assert.equal(env.local["job:album/2"].phase, "removed");
});

test("queueLinks: одинаковое не встаёт дважды; reorder меняет порядок", async () => {
  const env = boot();
  const items = [
    { url: "https://music.yandex.ru/album/1", job: "album/1", title: "1" },
    { url: "https://music.yandex.ru/album/2", job: "album/2", title: "2" },
    { url: "https://music.yandex.ru/album/1", job: "album/1", title: "1 снова" },
  ];
  const r = await env.message({ type: "queueLinks", items });
  assert.deepEqual(plain(r), { added: 2, skipped: 1 });
  const keys = env.local.pending.map((p) => p.key);
  await env.message({ type: "reorder", keys: [keys[1], keys[0]] });
  assert.deepEqual(env.local.pending.map((p) => p.job), ["album/2", "album/1"]);
});

test("одновременные изменения очереди не теряются", async () => {
  const env = boot();
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    env.message({ type: "queueLinks", items: [{ url: `https://music.yandex.ru/album/${i}`, job: `album/${i}`, title: String(i) }] })));
  assert.equal(env.local.pending.length, 10);
});

test("исполнитель — не собирается, а уходит на выбор во вкладку загрузок", async () => {
  const env = boot();
  await env.message({ type: "download", url: "https://music.yandex.ru/artist/9" }, { tab: { id: 7 } });
  assert.equal(env.sent.filter((m) => m.cmd === "collect").length, 0);
  assert.equal(env.local.pickLink.url, "https://music.yandex.ru/artist/9");
});

test("ссылки на файлы — запросом во вкладку сайта", async () => {
  const env = boot();
  env.chrome.tabs.sendMessage = async (id, m) => (m.cmd === "links" ? { links: { 1: { url: "u" } } } : undefined);
  const r = await env.message({ type: "links", ids: ["1"] });
  assert.deepEqual(plain(r), { links: { 1: { url: "u" } } });
});
