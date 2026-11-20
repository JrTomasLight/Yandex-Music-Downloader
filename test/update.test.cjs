// update.js: сравнение версий, распаковка zip, проверка папки расширения, установка с откатом.
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { loadScripts, memoryDir, dumpDir } = require("./stub.cjs");

// zip как у workflow релиза: файлы в корне, сжатие deflate (stored для пустых и по просьбе)
function makeZip(files, { store = false } = {}) {
  const enc = new TextEncoder();
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameB = enc.encode(name), data = enc.encode(text);
    const method = store || !data.length ? 0 : 8;
    const body = method ? zlib.deflateRawSync(data) : Buffer.from(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameB.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameB, body);
    centrals.push(ch, nameB);
    offset += 30 + nameB.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const buf = Buffer.concat([...locals, cd, end]);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function load(manifest, zips = {}) {
  const chrome = { runtime: { getManifest: () => manifest } };
  const fetch = async (url) => (url in zips ? new Response(zips[url]) : new Response("нет", { status: 404 }));
  return loadScripts(["update.js"], { chrome, fetch },
    "({ compareVersions, unzip, safeZipPath, checkExtensionDir, installUpdate, ZIP_PREFIX, UPDATE_REPO })").__result;
}

const NAME = "Yandex Music Downloader";
const manifest = (version, name = NAME) => JSON.stringify({ manifest_version: 3, name, version });

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

test("настройки репозитория", () => {
  const u = load({ name: NAME, version: "0.1.0" });
  assert.equal(u.UPDATE_REPO, "JrTomasLight/Yandex-Music-Downloader");
  assert.equal(u.ZIP_PREFIX, "yandex-music-downloader");
});

test("compareVersions", () => {
  const { compareVersions: c } = load({ name: NAME, version: "0.1.0" });
  assert.equal(c("1.2", "1.2.0"), 0);
  assert.equal(c("1.2.0", "1.2.1"), -1);
  assert.equal(c("1.10.0", "1.9.9"), 1);
  assert.equal(c("v2.0.0", "1.99"), 1);
});

test("unzip: deflate и stored, вложенные папки", async () => {
  const { unzip } = load({ name: NAME, version: "0.1.0" });
  for (const store of [false, true]) {
    const files = await unzip(makeZip({ "manifest.json": "{}", "icons/16.png": "PNG", "empty.txt": "" }, { store }));
    assert.deepEqual(Array.from(files, (f) => [f.name, new TextDecoder().decode(f.data)]),
      [["manifest.json", "{}"], ["icons/16.png", "PNG"], ["empty.txt", ""]]);
  }
});

test("unzip: опасные пути и мусор отклоняются", async () => {
  const { unzip } = load({ name: NAME, version: "0.1.0" });
  for (const bad of ["../evil.js", "/abs.js", "a//b.js", "a\\b.js"]) {
    await assert.rejects(unzip(makeZip({ [bad]: "x" })), /Недопустимое имя/, bad);
  }
  await assert.rejects(unzip(new TextEncoder().encode("not a zip at all, definitely not").buffer), /повреждён/);
});

test("checkExtensionDir", async () => {
  const u = load({ name: NAME, version: "0.1.0" });
  const empty = memoryDir();
  assert.match(await u.checkExtensionDir(empty), /нет файла manifest.json/);
  const other = memoryDir(); await put(other, { "manifest.json": manifest("0.1.0", "Другое") });
  assert.match(await u.checkExtensionDir(other), /другого расширения/);
  const older = memoryDir(); await put(older, { "manifest.json": manifest("0.0.9") });
  assert.match(await u.checkExtensionDir(older), /версия 0.0.9/);
  const ahead = memoryDir(); await put(ahead, { "manifest.json": manifest("0.2.0") });
  assert.deepEqual({ ...(await u.checkExtensionDir(ahead)) }, { ahead: "0.2.0" });
  const same = memoryDir(); await put(same, { "manifest.json": manifest("0.1.0") });
  assert.equal(await u.checkExtensionDir(same), null);
});

test("installUpdate: заменяет файлы, manifest.json — последним", async () => {
  const zip = makeZip({ "manifest.json": manifest("0.2.0"), "common.js": "new common", "icons/16.png": "new icon", "new.js": "added" });
  const u = load({ name: NAME, version: "0.1.0" }, { "https://x/rel.zip": zip });
  const order = [];
  const dir = memoryDir("ext", (p) => { order.push(p); return false; });
  await put(dir, { "manifest.json": manifest("0.1.0"), "common.js": "old common", "icons/16.png": "old icon", "keep.txt": "мой файл" });
  order.length = 0;
  const steps = [];
  assert.equal(await u.installUpdate(dir, { version: "0.2.0", zip: "https://x/rel.zip" }, (s) => steps.push(s)), "0.2.0");
  const files = dumpDir(dir);
  assert.equal(files["common.js"], "new common");
  assert.equal(files["icons/16.png"], "new icon");
  assert.equal(files["new.js"], "added");
  assert.equal(files["keep.txt"], "мой файл");
  assert.equal(JSON.parse(files["manifest.json"]).version, "0.2.0");
  assert.equal(order.at(-1), "manifest.json");
  assert.ok(steps.length >= 3);
});

test("installUpdate: при ошибке записи всё возвращается как было", async () => {
  const zip = makeZip({ "manifest.json": manifest("0.2.0"), "common.js": "new common", "new.js": "added", "update.js": "new update" });
  const u = load({ name: NAME, version: "0.1.0" }, { "https://x/rel.zip": zip });
  let armed = false;
  const dir = memoryDir("ext", (p) => armed && p === "update.js");
  const before = { "manifest.json": manifest("0.1.0"), "common.js": "old common", "update.js": "old update" };
  await put(dir, before);
  armed = true;
  await assert.rejects(u.installUpdate(dir, { version: "0.2.0", zip: "https://x/rel.zip" }), /всё возвращено как было/);
  assert.deepEqual(dumpDir(dir), before);
});

test("installUpdate: чужой архив, не та версия, нет архива", async () => {
  const zips = {
    "https://x/other.zip": makeZip({ "manifest.json": manifest("0.2.0", "Другое") }),
    "https://x/ver.zip": makeZip({ "manifest.json": manifest("0.3.0") }),
    "https://x/nomanifest.zip": makeZip({ "common.js": "x" }),
  };
  const u = load({ name: NAME, version: "0.1.0" }, zips);
  const dir = memoryDir();
  await put(dir, { "manifest.json": manifest("0.1.0") });
  await assert.rejects(u.installUpdate(dir, { version: "0.2.0", zip: "https://x/other.zip" }), /не от этого расширения/);
  await assert.rejects(u.installUpdate(dir, { version: "0.2.0", zip: "https://x/ver.zip" }), /ожидалась 0.2.0/);
  await assert.rejects(u.installUpdate(dir, { version: "0.2.0", zip: "https://x/nomanifest.zip" }), /нет manifest.json/);
  await assert.rejects(u.installUpdate(dir, { version: "0.2.0", zip: "https://x/missing.zip" }), /404/);
  await assert.rejects(u.installUpdate(dir, { version: "0.2.0", zip: null }), /не прикреплён/);
  assert.equal(JSON.parse(dumpDir(dir)["manifest.json"]).version, "0.1.0");
});
