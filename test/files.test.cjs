// files.js: теги ID3, пропуск тега источника, сверка папки с уже скачанным, info.json и m3u8.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts, memoryDir, dumpDir } = require("./stub.cjs");

const F = loadScripts(["common.js", "files.js"], {},
  "({ buildId3, id3Skipper, m3u8, syncFolder, writeInfo, readJson, INFO_DIR, INFO_FILE })").__result;
const plain = (v) => JSON.parse(JSON.stringify(v));

// Разбор тега ID3v2.3 — чтобы проверить то, что пишем, независимо от записи
function parseId3(bytes) {
  assert.equal(String.fromCharCode(bytes[0], bytes[1], bytes[2]), "ID3");
  assert.equal(bytes[3], 3);
  const size = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
  const frames = {};
  let p = 10;
  while (p < 10 + size) {
    const id = String.fromCharCode(...bytes.slice(p, p + 4));
    const len = new DataView(bytes.buffer, bytes.byteOffset + p + 4, 4).getUint32(0);
    const body = bytes.slice(p + 10, p + 10 + len);
    if (id === "APIC") frames[id] = body;
    else {
      assert.equal(body[0], 1);
      assert.deepEqual([body[1], body[2]], [0xff, 0xfe]);
      frames[id] = Buffer.from(body.slice(3)).toString("utf16le");
    }
    p += 10 + len;
  }
  return { size: 10 + size, frames };
}

const track = (over = {}) => ({
  id: "1", title: "Неважные слова", artists: "Sizor, Тёмные Окна", albumArtist: "Sizor, Тёмные Окна",
  album: "Неважные слова", year: 2025, disc: 1, discTotal: 1, track: 1, trackTotal: 1, ...over,
});

test("buildId3: текстовые кадры и обложка", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 0xff, 0xd9]);
  const tag = F.buildId3(track({ discTotal: 2, disc: 2, track: 3, trackTotal: 11 }), jpeg);
  const { size, frames } = parseId3(tag);
  assert.equal(size, tag.length);
  assert.equal(frames.TIT2, "Неважные слова");
  assert.equal(frames.TPE1, "Sizor, Тёмные Окна");
  assert.equal(frames.TPE2, "Sizor, Тёмные Окна");
  assert.equal(frames.TALB, "Неважные слова");
  assert.equal(frames.TRCK, "3/11");
  assert.equal(frames.TPOS, "2/2");
  assert.equal(frames.TYER, "2025");
  const apic = frames.APIC;
  assert.equal(apic[0], 0);
  assert.equal(Buffer.from(apic.slice(1, 11)).toString("latin1"), "image/jpeg");
  assert.equal(apic[11], 0);
  assert.equal(apic[12], 3);
  assert.equal(apic[13], 0);
  assert.deepEqual([...apic.slice(14)], [...jpeg]);
});

test("buildId3: без обложки, одного диска и года", () => {
  const { frames } = parseId3(F.buildId3(track({ year: null, track: 5, trackTotal: 0 }), null));
  assert.equal(frames.TRCK, "5");
  assert.equal(frames.TPOS, undefined);
  assert.equal(frames.TYER, undefined);
  assert.equal(frames.APIC, undefined);
});

test("buildId3: большой тег — размер синхронно-безопасный", () => {
  const big = new Uint8Array(300000).fill(7);
  const tag = F.buildId3(track(), big);
  assert.ok([6, 7, 8, 9].every((i) => tag[i] < 0x80));
  assert.equal(parseId3(tag).size, tag.length);
});

test("id3Skipper: тег источника вырезается, даже если пришёл по кусочкам", () => {
  const src = F.buildId3(track(), new Uint8Array(50));
  const audio = new Uint8Array([0xff, 0xfb, 0xe0, 0x44, 9, 9, 9]);
  const all = new Uint8Array([...src, ...audio]);
  for (const step of [1, 3, 7, 64, all.length]) {
    const skip = F.id3Skipper();
    const out = [];
    for (let i = 0; i < all.length; i += step) out.push(...skip(all.subarray(i, i + step)));
    assert.deepEqual(out, [...audio], `кусками по ${step}`);
  }
  // без тега — всё как есть
  const skip = F.id3Skipper();
  const out = [...skip(audio.subarray(0, 4)), ...skip(audio.subarray(4)), ...skip.rest()];
  assert.deepEqual(out, [...audio]);
  const skip2 = F.id3Skipper();
  const long = new Uint8Array(40).fill(5);
  assert.deepEqual([...skip2(long), ...skip2.rest()], [...long]);
});

async function put(dir, files) {
  for (const [p, text] of Object.entries(files)) {
    const parts = p.split("/");
    let d = dir;
    for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(text);
    await w.close();
  }
}

const stats = () => ({ total: 0, done: 0, renamed: 0, removed: 0, kept: 0, unavailable: 0 });
const playlist = (ids, extra = {}) => ({
  kind: "playlist", id: "playlists/x", title: "Мой", url: "https://music.yandex.ru/playlists/x", expected: ids.length,
  tracks: ids.map((id, i) => ({ id, n: i + 1, stem: `0${i + 1}. A - ${id}`, title: id, artists: "A", durationMs: 61000 })),
  ...extra,
});

test("syncFolder: новая папка — качать всё", async () => {
  const dir = memoryDir();
  const s = stats();
  const jobs = await F.syncFolder(playlist(["a", "b"]), dir, s);
  assert.deepEqual(Array.from(jobs, (t) => t.id), ["a", "b"]);
  assert.deepEqual(plain(s), { total: 2, done: 0, renamed: 0, removed: 0, kept: 0, unavailable: 0 });
});

test("syncFolder: новый трек в начале, перестановка и убранный трек", async () => {
  const dir = memoryDir();
  // было: 01 a, 02 b, 03 c; стало: z (новый), c, a — b убрали
  await put(dir, {
    "01. A - a.mp3": "AAA", "02. A - b.mp3": "BBB", "03. A - c.mp3": "CCC",
    "_сведения/info.json": JSON.stringify({ files: { a: "01. A - a.mp3", b: "02. A - b.mp3", c: "03. A - c.mp3" } }),
  });
  const data = playlist(["z", "c", "a"]);
  const s = stats();
  const jobs = await F.syncFolder(data, dir, s);
  assert.deepEqual(Array.from(jobs, (t) => t.id), ["z"]);
  const files = dumpDir(dir);
  assert.equal(files["02. A - c.mp3"], "CCC");
  assert.equal(files["03. A - a.mp3"], "AAA");
  assert.equal(files["_убраны из плейлиста/02. A - b.mp3"], "BBB");
  assert.ok(files["_убраны из плейлиста/readme.txt"].startsWith("﻿"));
  assert.ok(files["_убраны из плейлиста/readme.txt"].includes("\r\n"));
  assert.equal(files["01. A - a.mp3"], undefined);
  assert.equal(s.renamed, 2);
  assert.equal(s.removed, 1);
  assert.equal(s.done, 2);
  assert.deepEqual(Array.from(data.tracks, (t) => t.file || null), [null, "02. A - c.mp3", "03. A - a.mp3"]);
});

test("syncFolder: два трека меняются местами — имена не теряются", async () => {
  const dir = memoryDir();
  await put(dir, {
    "01. A - a.mp3": "AAA", "02. A - b.mp3": "BBB",
    "_сведения/info.json": JSON.stringify({ files: { a: "01. A - a.mp3", b: "02. A - b.mp3" } }),
  });
  const s = stats();
  await F.syncFolder(playlist(["b", "a"]), dir, s);
  const files = dumpDir(dir);
  assert.equal(files["01. A - b.mp3"], "BBB");
  assert.equal(files["02. A - a.mp3"], "AAA");
  assert.equal(s.removed, 0);
  assert.ok(!Object.keys(files).some((n) => n.includes("~ymd")));
});

test("syncFolder: сайт показал меньше 80% — ничего не убираем", async () => {
  const dir = memoryDir();
  await put(dir, {
    "01. A - a.mp3": "AAA", "02. A - b.mp3": "BBB", "03. A - c.mp3": "CCC",
    "_сведения/info.json": JSON.stringify({ files: { a: "01. A - a.mp3", b: "02. A - b.mp3", c: "03. A - c.mp3" } }),
  });
  const s = stats();
  await F.syncFolder(playlist(["a"], { expected: 10 }), dir, s);
  const files = dumpDir(dir);
  assert.equal(files["02. A - b.mp3"], "BBB");
  assert.equal(files["03. A - c.mp3"], "CCC");
  assert.equal(s.kept, 2);
  assert.equal(s.removed, 0);
});

test("syncFolder: без info.json уже скачанные файлы узнаются по имени", async () => {
  const dir = memoryDir();
  await put(dir, { "01. A - a.mp3": "AAA", "02. A - b.mp3": "" }); // пустой файл — недокачан
  const s = stats();
  const jobs = await F.syncFolder(playlist(["a", "b"]), dir, s);
  assert.deepEqual(Array.from(jobs, (t) => t.id), ["b"]);
  assert.equal(s.done, 1);
});

test("syncFolder: недоступный трек — не качается, но скачанный раньше остаётся", async () => {
  const dir = memoryDir();
  await put(dir, {
    "02. A - b.mp3": "BBB",
    "_сведения/info.json": JSON.stringify({ files: { b: "02. A - b.mp3" } }),
  });
  const data = playlist(["a", "b", "c"]);
  data.tracks[1].unavailable = "трек недоступен по вашей подписке";
  data.tracks[2].unavailable = "трек удалён";
  const s = stats();
  const jobs = await F.syncFolder(data, dir, s);
  assert.deepEqual(Array.from(jobs, (t) => t.id), ["a"]);
  assert.equal(dumpDir(dir)["02. A - b.mp3"], "BBB");
  assert.equal(s.unavailable, 1);
  assert.equal(s.done, 1);
});

test("syncFolder: отдельные треки — только пропуск уже скачанного", async () => {
  const dir = memoryDir();
  await put(dir, { "A - a.mp3": "AAA", "чужой.mp3": "X" });
  const data = { kind: "tracks", single: true, tracks: [{ id: "a", stem: "A - a" }, { id: "b", stem: "A - b" }] };
  const s = stats();
  const jobs = await F.syncFolder(data, dir, s);
  assert.deepEqual(Array.from(jobs, (t) => t.id), ["b"]);
  assert.equal(dumpDir(dir)["чужой.mp3"], "X");
});

test("writeInfo: info.json, readme и m3u8 плейлиста", async () => {
  const dir = memoryDir();
  const data = playlist(["a", "b", "c"]);
  data.tracks[0].file = "01. A - a.mp3";
  data.tracks[2].file = "03. A - c.mp3";
  await F.writeInfo(data, dir, { failed: 1 });
  const files = dumpDir(dir);
  const info = JSON.parse(files["_сведения/info.json"]);
  assert.deepEqual(info.files, { a: "01. A - a.mp3", c: "03. A - c.mp3" });
  assert.equal(info.url, data.url);
  assert.equal(info.kind, "playlist");
  assert.ok(files["_сведения/readme.txt"].includes("\r\n"));
  assert.equal(files["Мой.m3u8"], "#EXTM3U\r\n#EXTINF:61,A - a\r\n01. A - a.mp3\r\n#EXTINF:61,A - c\r\n03. A - c.mp3\r\n");
  // повторно, когда трек «a» стал недоступен: он остаётся в описании
  data.tracks[0].file = null;
  data.tracks[0].unavailable = "нет";
  await F.writeInfo(data, dir, { failed: 0 });
  assert.deepEqual(JSON.parse(dumpDir(dir)["_сведения/info.json"]).files, { a: "01. A - a.mp3", c: "03. A - c.mp3" });
});

test("writeInfo: у альбома нет m3u8", async () => {
  const dir = memoryDir();
  await F.writeInfo({ kind: "album", id: "album/1", title: "Альбом", url: "u", tracks: [{ id: "1", file: "01. x.mp3" }] }, dir, { failed: 0 });
  assert.deepEqual(Object.keys(dumpDir(dir)).sort(), ["_сведения/info.json", "_сведения/readme.txt"]);
});
