// Обновления с GitHub: проверка последнего релиза и установка в один клик.
// Подключается и в background.js (importScripts), и на странице загрузок.

// Репозиторий на GitHub и начало имени архива релиза
// (то же, что ZIP_PREFIX в .github/workflows/release.yml)
const UPDATE_REPO = "JrTomasLight/Yandex-Music-Downloader";
const ZIP_PREFIX = "yandex-music-downloader";

const UPDATE_REPO_URL = `https://github.com/${UPDATE_REPO}`;
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;

const currentVersion = () => chrome.runtime.getManifest().version;

// 1.2 == 1.2.0 < 1.2.1 < 1.10.0
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Последний релиз с GitHub; null, если GitHub недоступен.
async function fetchLatestRelease() {
  const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`GitHub ответил ${r.status}`);
  const rel = await r.json();
  const asset = (rel.assets || []).find((a) => a.name.startsWith(ZIP_PREFIX + "-") && a.name.endsWith(".zip"));
  return {
    version: String(rel.tag_name || "").replace(/^v/i, ""),
    url: rel.html_url,
    zip: asset ? asset.browser_download_url : null,
    // в тексте релиза после «---» идёт общая инструкция по установке — в окне она не нужна
    notes: String(rel.body || "").split(/\n-{3,}\s*\n/)[0].trim(),
    published: rel.published_at,
  };
}

// Проверяет обновление (не чаще раза в CHECK_EVERY_MS, если не force) и сохраняет результат.
async function checkForUpdate(force = false) {
  const { update } = await chrome.storage.local.get("update");
  if (!force && update && Date.now() - (update.checkedAt || 0) < CHECK_EVERY_MS) return update;
  let next;
  try {
    const rel = await fetchLatestRelease();
    next = { ...rel, checkedAt: Date.now(), available: compareVersions(rel.version, currentVersion()) > 0 };
  } catch (e) {
    next = { ...(update || {}), checkedAt: Date.now(), error: String(e.message || e) };
    next.available = !!(next.version && compareVersions(next.version, currentVersion()) > 0);
  }
  await chrome.storage.local.set({ update: next });
  return next;
}

// ------------------------------------------------------------ распаковка zip
// Встроенного распаковщика в браузере нет, но есть DecompressionStream — этого хватает.
function safeZipPath(name) {
  if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").some((p) => p === ".." || p === "")) {
    throw new Error(`Недопустимое имя файла в архиве: ${name}`);
  }
  return name;
}

async function unzip(buffer) {
  const dv = new DataView(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Архив повреждён");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Архив повреждён");
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buffer, p + 46, nlen));
    p += 46 + nlen + elen + clen;
    if (name.endsWith("/")) continue; // папка
    safeZipPath(name);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = new Uint8Array(buffer, start, csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error(`Неподдерживаемое сжатие в архиве (${method})`);
    if (data.length !== usize) throw new Error(`Архив повреждён: ${name}`);
    files.push({ name, data });
  }
  return files;
}

// ------------------------------------------------------------ установка
async function readFileOrNull(dir, path) {
  const parts = path.split("/");
  try {
    let d = dir;
    for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part);
    const f = await (await d.getFileHandle(parts[parts.length - 1])).getFile();
    return new Uint8Array(await f.arrayBuffer());
  } catch {
    return null;
  }
}

async function writeFileAt(dir, path, data) {
  const parts = path.split("/");
  let d = dir;
  for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
  const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

async function removeFileAt(dir, path) {
  const parts = path.split("/");
  try {
    let d = dir;
    for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part);
    await d.removeEntry(parts[parts.length - 1]);
  } catch { /* файла и не было */ }
}

// Папка, выбранная пользователем, — точно папка этого расширения?
async function checkExtensionDir(dir) {
  const raw = await readFileOrNull(dir, "manifest.json");
  if (!raw) return "В этой папке нет файла manifest.json. Выберите папку, в которую распакован архив расширения, — ту, в которой видна подпапка icons.";
  let m;
  try {
    m = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return "Файл manifest.json в этой папке повреждён.";
  }
  const me = chrome.runtime.getManifest();
  if (m.name !== me.name) return "Это папка другого расширения.";
  // файлы в папке уже новее (распаковали вручную или обновили через git), а браузер ещё не перезапустил
  // расширение — тут нужен только перезапуск, это решает вызывающий код
  if (compareVersions(m.version, me.version) > 0) return { ahead: m.version };
  if (m.version !== me.version) {
    return `В этой папке версия ${m.version}, а установлена ${me.version}. Выберите папку, из которой расширение загружено в браузер.`;
  }
  return null;
}

// Скачивает архив релиза и заменяет файлы расширения. При любой ошибке возвращает старые файлы.
async function installUpdate(dir, release, onStep = () => {}) {
  if (!release.zip) throw new Error("К релизу не прикреплён архив расширения.");
  onStep("Скачиваю архив…");
  const r = await fetch(release.zip, { cache: "no-store" });
  if (!r.ok) throw new Error(`Не удалось скачать архив (${r.status})`);
  onStep("Распаковываю…");
  const files = await unzip(await r.arrayBuffer());
  const manifest = files.find((f) => f.name === "manifest.json");
  if (!manifest) throw new Error("В архиве нет manifest.json.");
  const m = JSON.parse(new TextDecoder().decode(manifest.data));
  if (m.name !== chrome.runtime.getManifest().name) throw new Error("Архив не от этого расширения.");
  if (compareVersions(m.version, release.version) !== 0) {
    throw new Error(`В архиве версия ${m.version}, а ожидалась ${release.version}.`);
  }

  onStep("Сохраняю старые файлы на случай отката…");
  const backup = [];
  for (const f of files) backup.push({ name: f.name, data: await readFileOrNull(dir, f.name) });

  onStep("Заменяю файлы…");
  // manifest.json — последним: пока он старый, браузер считает установленной старую версию
  const ordered = [...files.filter((f) => f !== manifest), manifest];
  try {
    for (const f of ordered) await writeFileAt(dir, f.name, f.data);
  } catch (e) {
    onStep("Ошибка — возвращаю старые файлы…");
    for (const b of backup) {
      try {
        if (b.data) await writeFileAt(dir, b.name, b.data);
        else await removeFileAt(dir, b.name);
      } catch { /* делаем что можем */ }
    }
    throw new Error("Не удалось записать файлы расширения, всё возвращено как было: " + (e.message || e));
  }
  return m.version;
}
