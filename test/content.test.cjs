// content.js: сбор альбома, плейлиста и трека, повторы на 429, ссылки на файлы, списки для выбора.
// Ответы сайта — поддельные, по образцу настоящих (без личных данных).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { EXT_DIR } = require("./stub.cjs");

const artist = (id, name, extra = {}) => ({ id, name, various: false, ...extra });
const trk = (id, title, extra = {}) => ({
  id: String(id), title, available: true, availableForPremiumUsers: true, durationMs: 180000,
  artists: [artist(1, "Pink Floyd")], albums: [{ id: 298151, title: "The Discovery Boxset", year: 2011, version: "2011 - Remaster",
    coverUri: "avatars.yandex.net/get-music-content/1/a/%%", artists: [artist(1, "Pink Floyd")], trackPosition: { volume: 1, index: 1 } }],
  ...extra,
});

const ALBUM = {
  id: 298151, title: "The Discovery Boxset", version: "2011 - Remaster", year: 2011, trackCount: 3, genre: "prog",
  coverUri: "avatars.yandex.net/get-music-content/1/a/%%", artists: [artist(1, "Pink Floyd")],
  volumes: [[trk(11, "Astronomy Domine", { version: "2011 - Remaster" }), trk(12, "Lucifer Sam")], [trk(21, "Echoes", { available: false })]],
};
const COMPILATION = {
  id: 5, title: "Хиты: 2000", year: 2000, trackCount: 2, artists: [artist(171, "Various artists", { various: true })],
  volumes: [[trk(1, "Песня", { artists: [artist(2, "Кино")] }), trk(2, "Другая", { artists: [artist(3, "Ария"), artist(4, "Гость")] })]],
};
const PLAYLIST = {
  kind: 1003, title: "Дорога", trackCount: 3, playlistUuid: "abc-123", owner: { login: "someone", name: "Кто-то", uid: 7 },
  tracks: [{ id: 11, track: trk(11, "Astronomy Domine") }, { id: 31 }, { id: 32 }],
};

function makeEnv(routes) {
  const calls = [];
  const fetch = async (url, opt = {}) => {
    const u = new URL(url);
    const key = (opt.method || "GET") + " " + u.pathname + (u.search || "");
    calls.push(key);
    for (const [re, fn] of routes) {
      const m = key.match(re);
      if (m) {
        const r = await fn(m, opt, calls);
        if (r && r.hang) return new Promise((_, rej) => opt.signal.addEventListener("abort", () => rej(new Error("aborted"))));
        const status = (r && r.status) || 200;
        return { ok: status < 300, status, json: async () => (r && "body" in r ? r.body : { result: r }) };
      }
    }
    return { ok: false, status: 404, json: async () => ({ result: { name: "not-found" } }) };
  };
  let handler;
  const msgs = [];
  let done;
  const fin = new Promise((r) => (done = r));
  const chrome = {
    runtime: {
      id: "x",
      onMessage: { addListener: (f) => (handler = f) },
      sendMessage: async (m) => { msgs.push(m); if (m.type !== "progress") done(m); },
    },
  };
  // тайм-ауты и паузы между попытками — мгновенно
  const fast = (f, ms) => setTimeout(f, ms > 100 ? 2 : ms);
  const ctx = vm.createContext({
    chrome, fetch, URL, URLSearchParams, AbortController, console, Promise, setTimeout: fast, clearTimeout,
    window: {}, location: { hostname: "music.yandex.ru", href: "https://music.yandex.ru/" },
  });
  ctx.self = ctx;
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, "common.js"), "utf8") + ";" + fs.readFileSync(path.join(EXT_DIR, "content.js"), "utf8"), ctx);
  const ask = (msg) => new Promise((resolve) => handler(msg, {}, resolve));
  const collect = async (target) => {
    handler({ cmd: "collect", target, job: "j" }, {}, () => {});
    return fin;
  };
  return { ask, collect, msgs, calls };
}

const ME = [/GET \/account\/about/, () => ({ uid: 7, login: "someone", hasPlus: true })];
const plain = (v) => JSON.parse(JSON.stringify(v));

test("альбом с двумя дисками: имена, номера, папка, недоступный трек", async () => {
  const env = makeEnv([ME, [/GET \/albums\/298151\/with-tracks/, () => ALBUM]]);
  const m = await env.collect({ kind: "album", album: "298151" });
  assert.equal(m.type, "collected");
  const d = plain(m.data);
  assert.equal(d.root, "Pink Floyd/2011 - The Discovery Boxset (2011 - Remaster)");
  assert.equal(d.id, "album/298151");
  assert.equal(d.kind, "album");
  assert.equal(d.found, 3);
  assert.deepEqual(d.tracks.map((t) => t.stem), [
    "1-01. Astronomy Domine (2011 - Remaster)", "1-02. Lucifer Sam", "2-01. Echoes",
  ]);
  assert.deepEqual(d.tracks.map((t) => [t.disc, t.discTotal, t.track, t.trackTotal]), [[1, 2, 1, 2], [1, 2, 2, 2], [2, 2, 1, 1]]);
  assert.equal(d.tracks[0].album, "The Discovery Boxset (2011 - Remaster)");
  assert.equal(d.tracks[0].year, 2011);
  assert.equal(d.tracks[2].unavailable, "трек недоступен по вашей подписке");
  assert.ok(env.msgs.every((x) => x.job === "j"));
});

test("сборник: исполнитель каждого трека в имени файла, папка «Сборники»", async () => {
  const env = makeEnv([ME, [/GET \/albums\/5\/with-tracks/, () => COMPILATION]]);
  const d = plain((await env.collect({ kind: "album", album: "5" })).data);
  assert.equal(d.root, "Сборники/2000 - Хиты_ 2000");
  assert.deepEqual(d.tracks.map((t) => t.stem), ["01. Кино - Песня", "02. Ария, Гость - Другая"]);
  assert.equal(d.tracks[0].albumArtist, "Сборники");
});

test("плейлист: недостающие описания треков дозапрашиваются", async () => {
  const env = makeEnv([ME,
    [/GET \/playlist\/abc-123/, () => PLAYLIST],
    [/POST \/tracks/, (_m, opt) => {
      const ids = new URLSearchParams(opt.body).get("track-ids").split(",");
      assert.deepEqual(ids, ["31", "32"]);
      return [trk(31, "Time", { artists: [artist(9, "Другой")] })]; // 32 удалён с сайта
    }],
  ]);
  const d = plain((await env.collect({ kind: "playlist", uuid: "abc-123" })).data);
  assert.equal(d.root, "Плейлисты/Дорога");
  assert.equal(d.id, "playlists/abc-123");
  assert.equal(d.url, "https://music.yandex.ru/playlists/abc-123");
  assert.deepEqual(d.tracks.map((t) => t.stem), ["01. Pink Floyd - Astronomy Domine", "02. Другой - Time", "03. Трек 32"]);
  assert.equal(d.tracks[2].unavailable, "трек удалён");
});

test("отдельный трек", async () => {
  const env = makeEnv([ME, [/POST \/tracks/, () => [trk(11, "Astronomy Domine")]]]);
  const d = plain((await env.collect({ kind: "track", track: "11" })).data);
  assert.equal(d.root, "Отдельные треки");
  assert.equal(d.single, true);
  assert.equal(d.id, "track/11");
  assert.deepEqual(d.tracks.map((t) => t.stem), ["Pink Floyd - Astronomy Domine"]);
});

test("429 и зависший ответ — повтор с сообщением, потом успех", async () => {
  let n = 0;
  const env = makeEnv([ME, [/GET \/albums\/298151\/with-tracks/, () => {
    n++;
    if (n === 1) return { status: 429, body: {} };
    if (n === 2) return { hang: true };
    return ALBUM;
  }]]);
  const m = await env.collect({ kind: "album", album: "298151" });
  assert.equal(m.type, "collected");
  const notes = env.msgs.filter((x) => x.type === "progress" && /ещё раз/.test(x.text)).map((x) => x.text);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /просит подождать/);
  assert.match(notes[1], /не ответила за 30 секунд/);
});

test("без входа — понятная ошибка", async () => {
  const env = makeEnv([[/GET \/account\/about/, () => ({})]]);
  const m = await env.collect({ kind: "album", album: "1" });
  assert.equal(m.type, "error");
  assert.match(m.text, /Войдите в аккаунт/);
});

test("альбом не найден — ошибка без повторов", async () => {
  const env = makeEnv([ME]);
  const m = await env.collect({ kind: "album", album: "404" });
  assert.equal(m.type, "error");
  assert.equal(env.calls.filter((c) => c.includes("/albums/404")).length, 1);
});

test("ссылки на файлы: лучший mp3, нет прав, ошибка сети", async () => {
  const env = makeEnv([
    [/GET \/tracks\/1\/download-info\?direct=true/, () => [
      { codec: "mp3", direct: true, bitrateInKbps: 192, downloadInfoUrl: "https://s1.strm.yandex.net/192.mp3" },
      { codec: "mp3", direct: true, bitrateInKbps: 320, downloadInfoUrl: "https://s1.strm.yandex.net/320.mp3" },
      { codec: "aac", direct: true, bitrateInKbps: 256, downloadInfoUrl: "https://s1.strm.yandex.net/a.aac" },
    ]],
    [/GET \/tracks\/2\/download-info/, () => ({ status: 403, body: { result: { name: "track-download-info-error", message: "no-rights" } } })],
    [/GET \/tracks\/3\/download-info/, () => ({ status: 500, body: {} })],
    [/GET \/tracks\/4\/download-info/, () => [{ codec: "mp3", direct: true, preview: true, bitrateInKbps: 128, downloadInfoUrl: "x" }]],
  ]);
  const r = plain(await env.ask({ cmd: "links", ids: ["1", "2", "3", "4"] }));
  assert.deepEqual(r.links["1"], { url: "https://s1.strm.yandex.net/320.mp3", bitrate: 320 });
  assert.deepEqual(r.links["2"], { error: "трек недоступен по вашей подписке", final: true });
  assert.match(r.links["3"].error, /ошибкой 500/);
  assert.equal(env.calls.filter((c) => c.includes("/tracks/3/")).length, 4);
  assert.match(r.links["4"].error, /не дал ссылку/);
});

test("альбомы исполнителя: постранично, сборники отдельно", async () => {
  const page = (from, n, total) => ({ pager: { page: from / 100, perPage: 100, total },
    albums: Array.from({ length: n }, (_, i) => ({ id: from + i, title: `A${from + i}`, year: 2000, trackCount: 1, type: "single", artists: [artist(1, "X")] })) });
  const env = makeEnv([
    [/GET \/artists\/9\/direct-albums\?page=0/, () => page(0, 100, 130)],
    [/GET \/artists\/9\/direct-albums\?page=1/, () => page(100, 30, 130)],
    [/GET \/artists\/9\/also-albums\?page=0/, () => ({ pager: { page: 0, perPage: 100, total: 1 }, albums: [{ id: 999, title: "Сборник", artists: [] }] })],
    [/GET \/artists\/9\/brief-info/, () => ({ artist: { name: "Исполнитель" } })],
  ]);
  const r = plain(await env.ask({ cmd: "albums", artist: "9" }));
  assert.equal(r.artist, "Исполнитель");
  assert.equal(r.albums.length, 131);
  assert.equal(r.albums.filter((a) => a.also).length, 1);
  assert.equal(r.albums[0].url, "https://music.yandex.ru/album/0");
});

test("мои плейлисты: «Мне нравится» первым", async () => {
  const env = makeEnv([ME,
    [/GET \/users\/7\/playlists\/list/, () => [{ kind: 1003, title: "Дорога", trackCount: 3, playlistUuid: "abc-123" }]],
    [/GET \/users\/7\/playlists\/3/, () => ({ kind: 3, title: "Мне нравится", trackCount: 2400, playlistUuid: "lk.x" })],
  ]);
  const r = plain(await env.ask({ cmd: "playlists" }));
  assert.deepEqual(r.playlists.map((p) => [p.title, p.url]), [
    ["Мне нравится", "https://music.yandex.ru/playlists/lk.x"],
    ["Дорога", "https://music.yandex.ru/playlists/abc-123"],
  ]);
});
