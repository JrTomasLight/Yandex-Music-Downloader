// common.js: разбор ссылок, ключ задачи, имена файлов для Windows, застывшие этапы.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts } = require("./stub.cjs");

const { EXT } = loadScripts(["common.js"]);

test("parseLink: альбомы, треки, исполнители, плейлисты", () => {
  const cases = [
    ["https://music.yandex.ru/album/123", { kind: "album", album: "123" }],
    ["https://music.yandex.ru/album/123/", { kind: "album", album: "123" }],
    ["https://music.yandex.ru/album/123?activeTab=about", { kind: "album", album: "123" }],
    ["music.yandex.ru/album/123", { kind: "album", album: "123" }],
    ["https://music.yandex.kz/album/5/track/77", { kind: "track", track: "77", album: "5" }],
    ["https://music.yandex.ru/track/77", { kind: "track", track: "77" }],
    ["https://music.yandex.by/artist/42", { kind: "artist", artist: "42" }],
    ["https://music.yandex.ru/artist/42/albums", { kind: "artist", artist: "42" }],
    ["https://music.yandex.ru/users/Some.User/playlists/1003", { kind: "playlist", owner: "Some.User", playlist: "1003" }],
    ["https://music.yandex.ru/users/%D0%B8%D0%BC%D1%8F/playlists/3", { kind: "playlist", owner: "имя", playlist: "3" }],
    ["https://music.yandex.ru/playlists/lk.0f1e2d3c-aaaa-bbbb", { kind: "playlist", uuid: "lk.0f1e2d3c-aaaa-bbbb" }],
    ["https://next.music.yandex.ru/album/9", { kind: "album", album: "9" }],
    ["https://music.yandex.ru/collection", { kind: "collection" }],
    ["https://music.yandex.ru/collection/playlists", { kind: "collection" }],
    ["https://music.yandex.ru/users/Some.User/playlists", { kind: "collection", owner: "Some.User" }],
  ];
  for (const [url, want] of cases) assert.deepEqual({ ...EXT.parseLink(url) }, want, url);
});

test("parseLink: чужие и пустые ссылки — null", () => {
  for (const url of [
    "", null, "https://example.com/album/1", "https://yandex.ru/album/1", "https://music.yandex.ru/",
    "https://music.yandex.ru/album/abc", "https://music.yandex.ru/home", "https://music.yandex.ru/users/x",
    "https://music.yandex.ru.evil.com/album/1", "not a url at all",
  ]) assert.equal(EXT.parseLink(url), null, String(url));
});

test("keyOf: одна и та же вещь — один ключ", () => {
  assert.equal(EXT.keyOf("https://music.yandex.ru/album/1"), "album/1");
  assert.equal(EXT.keyOf("https://music.yandex.kz/album/1/"), "album/1");
  assert.equal(EXT.keyOf("https://music.yandex.ru/album/1/track/2"), "track/2");
  assert.equal(EXT.keyOf("https://music.yandex.ru/track/2"), "track/2");
  assert.equal(EXT.keyOf("https://music.yandex.ru/users/Some.User/playlists/3"), "users/some.user/playlists/3");
  assert.equal(EXT.keyOf("https://music.yandex.ru/users/some.user/playlists/3"), "users/some.user/playlists/3");
  assert.equal(EXT.keyOf("https://example.com/album/1"), null);
});

test("safeName: допустимо в Windows", () => {
  assert.equal(EXT.safeName('AC/DC: "Back" <in> Black?'), "AC_DC_ _Back_ _in_ Black_");
  assert.equal(EXT.safeName("  Название.  "), "Название");
  assert.equal(EXT.safeName("..."), "untitled");
  assert.equal(EXT.safeName(""), "untitled");
  assert.equal(EXT.safeName("a\tb\n c"), "a b c");
  // после обрезки по длине на конце не должно остаться точки или пробела
  assert.equal(EXT.safeName("abcd. efgh", 6), "abcd");
  // имена устройств Windows
  assert.equal(EXT.safeName("Con"), "_Con");
  assert.equal(EXT.safeName("nul.txt"), "_nul.txt");
  assert.equal(EXT.safeName("COM1"), "_COM1");
  assert.equal(EXT.safeName("Console"), "Console");
  assert.equal(EXT.safeName("x".repeat(200)).length, 80);
});

test("isActive: застывшие этапы не считаются идущими", () => {
  const now = Date.now();
  assert.equal(EXT.isActive({ phase: "collect", at: now }), true);
  assert.equal(EXT.isActive({ phase: "collect", at: now - EXT.STALE_MS - 1000 }), false);
  assert.equal(EXT.isActive({ phase: "download", at: 1 }), false);
  // в очереди и выбор папки ждут сколько угодно
  assert.equal(EXT.isActive({ phase: "queued", at: 1 }), true);
  assert.equal(EXT.isActive({ phase: "folder", at: 1 }), true);
  assert.equal(EXT.isActive({ phase: "done", at: now }), false);
  assert.equal(EXT.isActive(null), false);
});

test("linkUrl и coverUrl", () => {
  for (const url of ["https://music.yandex.ru/album/1", "https://music.yandex.ru/album/1/track/2", "https://music.yandex.ru/track/2",
    "https://music.yandex.ru/artist/3", "https://music.yandex.ru/playlists/lk.abc", "https://music.yandex.ru/users/u/playlists/7"]) {
    assert.equal(EXT.linkUrl(EXT.parseLink(url)), url);
  }
  assert.equal(EXT.coverUrl("avatars.yandex.net/get-music-content/1/a/%%"), "https://avatars.yandex.net/get-music-content/1/a/1000x1000");
  assert.equal(EXT.coverUrl("avatars.yandex.net/x/%%", "200x200"), "https://avatars.yandex.net/x/200x200");
  assert.equal(EXT.coverUrl(null), null);
  assert.equal(EXT.plural(1, "трек", "трека", "треков"), "трек");
  assert.equal(EXT.plural(3, "трек", "трека", "треков"), "трека");
  assert.equal(EXT.plural(11, "трек", "трека", "треков"), "треков");
  assert.equal(EXT.plural(22, "трек", "трека", "треков"), "трека");
});

test("настройки: значения по умолчанию и защита от мусора", async () => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(EXT.normalizeSettings(undefined)), plain(EXT.DEFAULTS));
  assert.deepEqual(plain(EXT.normalizeSettings({ parallel: 5, quality: "192", tags: false, tagCover: "none", coverFile: false })),
    { parallel: 5, quality: "192", tags: false, tagCover: "none", coverFile: false });
  // неизвестные и испорченные значения — по умолчанию
  const s = plain(EXT.normalizeSettings({ parallel: 40, quality: "flac", tags: "да", tagCover: "1x1", extra: 1 }));
  assert.deepEqual(s, plain(EXT.DEFAULTS));
});

test("loadSettings: из storage, а без storage — по умолчанию", async () => {
  const { loadScripts } = require("./stub.cjs");
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const withStore = loadScripts(["common.js"], { chrome: { storage: { local: { get: async () => ({ settings: { parallel: 1 } }) } } } }).EXT;
  assert.equal((await withStore.loadSettings()).parallel, 1);
  const broken = loadScripts(["common.js"], { chrome: { storage: { local: { get: async () => { throw new Error("нет"); } } } } }).EXT;
  assert.deepEqual(plain(await broken.loadSettings()), plain(broken.DEFAULTS));
});
