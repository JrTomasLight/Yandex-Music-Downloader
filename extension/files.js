// Файлы на диске: теги mp3, сверка папки с уже скачанным, служебные файлы.
// Подключается во вкладке загрузок перед downloader.js. Без интерфейса — проверяется в Node (test/files.test.cjs).

const INFO_DIR = "_сведения";            // info.json и readme.txt
const INFO_FILE = "info.json";
const README_TXT = "readme.txt";
const SINGLES_DIR = "Отдельные треки";
const PARTIAL_SHARE = 0.8;               // найдено меньше этой доли треков — ничего не убираем
const FILE_OPS_PARALLEL = 8;             // одновременных переименований и переносов при сверке

const removedDirOf = (data) => (data.kind === "playlist" ? "_убраны из плейлиста" : "_убраны из альбома");

// выполняет fn для каждого элемента, не больше limit одновременно
async function pool(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ------------------------------------------------------------ простые операции с файлами
async function writeText(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

// Для Блокнота: метка UTF-8 (BOM) и переводы строк \r\n, иначе старый Блокнот покажет кракозябры.
const writeReadme = (dir, text) => writeText(dir, README_TXT, "﻿" + text.replace(/\r?\n/g, "\r\n"));

async function readJson(dir, name) {
  try {
    return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
  } catch {
    return null;
  }
}

async function fileSize(dir, name) {
  try {
    return (await (await dir.getFileHandle(name)).getFile()).size;
  } catch {
    return -1;
  }
}

// Переименование/перенос файла. move() есть не во всех версиях браузера — тогда копируем.
// Если move() не сработал несколько раз подряд, дальше сразу копируем, не тратя на него время.
let moveFails = 0;
async function moveFile(dir, name, targetDir, newName) {
  const h = await dir.getFileHandle(name);
  if (h.move && moveFails < 3) {
    try {
      await (targetDir === dir ? h.move(newName) : h.move(targetDir, newName));
      moveFails = 0;
      return;
    } catch {
      moveFails++; // пробуем копированием
    }
  }
  const file = await h.getFile();
  const nh = await targetDir.getFileHandle(newName, { create: true });
  const w = await nh.createWritable();
  await w.write(file);
  await w.close();
  await dir.removeEntry(name);
}

// ------------------------------------------------------------ теги ID3v2.3
// Версия 2.3 с текстом в UTF-16: её понимают и Проводник Windows, и почти все плееры
// (2.4 Проводник показывает плохо).
function id3Text(id, text) {
  const s = String(text);
  const body = new Uint8Array(3 + s.length * 2);
  body[0] = 1; // UTF-16 с меткой порядка байт
  body[1] = 0xff;
  body[2] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    body[3 + i * 2] = c & 0xff;
    body[4 + i * 2] = c >> 8;
  }
  return id3Frame(id, body);
}

function id3Frame(id, body) {
  const f = new Uint8Array(10 + body.length);
  for (let i = 0; i < 4; i++) f[i] = id.charCodeAt(i);
  new DataView(f.buffer).setUint32(4, body.length); // в 2.3 размер кадра — обычное число
  f.set(body, 10);
  return f;
}

function id3Picture(jpeg) {
  const mime = "image/jpeg";
  const head = new Uint8Array(1 + mime.length + 1 + 1 + 1);
  head[0] = 0; // описание в Latin-1
  for (let i = 0; i < mime.length; i++) head[1 + i] = mime.charCodeAt(i);
  head[mime.length + 2] = 3; // обложка (лицевая сторона)
  // за типом — пустое описание с нулём на конце
  const body = new Uint8Array(head.length + jpeg.length);
  body.set(head);
  body.set(jpeg, head.length);
  return id3Frame("APIC", body);
}

// t — описание трека из сбора; cover — байты jpeg или null
function buildId3(t, cover) {
  const frames = [];
  const text = (id, v) => { if (v != null && v !== "") frames.push(id3Text(id, v)); };
  text("TIT2", t.title);
  text("TPE1", t.artists);
  text("TPE2", t.albumArtist);
  text("TALB", t.album);
  if (t.track) text("TRCK", t.trackTotal ? `${t.track}/${t.trackTotal}` : String(t.track));
  if (t.discTotal > 1) text("TPOS", `${t.disc}/${t.discTotal}`);
  text("TYER", t.year ? String(t.year) : "");
  if (cover && cover.length) frames.push(id3Picture(cover));
  const size = frames.reduce((n, f) => n + f.length, 0);
  const tag = new Uint8Array(10 + size);
  tag.set([0x49, 0x44, 0x33, 3, 0, 0]); // "ID3", версия 2.3, флагов нет
  // размер всего тега — «синхронно-безопасное» число: по 7 бит в байте
  tag[6] = (size >> 21) & 0x7f;
  tag[7] = (size >> 14) & 0x7f;
  tag[8] = (size >> 7) & 0x7f;
  tag[9] = size & 0x7f;
  let p = 10;
  for (const f of frames) {
    tag.set(f, p);
    p += f.length;
  }
  return tag;
}

// Пропускает ID3-тег в начале потока, если он там есть (свой тег пишем сами).
// Возвращает функцию: кусок данных → кусок без тега (возможно пустой).
function id3Skipper() {
  let head = new Uint8Array(0); // первые байты, пока не ясно, есть ли тег
  let skip = -1;                // сколько байт тега ещё пропустить; -1 — ещё не знаем
  const fn = (chunk) => {
    if (skip === -1) {
      const joined = new Uint8Array(head.length + chunk.length);
      joined.set(head);
      joined.set(chunk, head.length);
      if (joined.length < 10) {
        head = joined;
        return new Uint8Array(0);
      }
      head = null;
      const isTag = joined[0] === 0x49 && joined[1] === 0x44 && joined[2] === 0x33;
      skip = isTag ? 10 + ((joined[6] << 21) | (joined[7] << 14) | (joined[8] << 7) | joined[9]) + ((joined[5] & 0x10) ? 10 : 0) : 0;
      chunk = joined;
    }
    if (skip >= chunk.length) {
      skip -= chunk.length;
      return new Uint8Array(0);
    }
    const out = skip ? chunk.subarray(skip) : chunk;
    skip = 0;
    return out;
  };
  // поток кончился раньше, чем набралось 10 байт, — отдаём то, что накопилось
  fn.rest = () => (skip === -1 && head ? head : new Uint8Array(0));
  return fn;
}

// ------------------------------------------------------------ список воспроизведения
function m3u8(data) {
  const lines = ["#EXTM3U"];
  for (const t of data.tracks) {
    if (!t.file) continue;
    lines.push(`#EXTINF:${Math.round((t.durationMs || 0) / 1000)},${t.artists} - ${t.title}`, t.file);
  }
  return lines.join("\r\n") + "\r\n";
}

// ------------------------------------------------------------ служебные пояснения
const INFO_README = `ПАПКА «${INFO_DIR}»

Служебная папка расширения Yandex Music Downloader. Она обновляется при каждом скачивании.


ЧТО ВНУТРИ

  info.json   Что это за альбом или плейлист, ссылка на него и список треков с именами файлов.
              По нему расширение узнаёт уже скачанные треки, а альбом или плейлист виден
              во вкладке «Мои загрузки» и обновляется кнопкой «Обновить».


ВАЖНО

  - Если вы переименуете файлы треков, при следующем скачивании они вернут прежние имена
    (или скачаются заново, если файл не найти).
  - Эту папку можно удалить: при следующем скачивании она появится снова, а уже скачанные
    треки узнаются по именам файлов.
`;

const removedReadme = (data) => `ПАПКА «${removedDirOf(data)}»

Сюда расширение Yandex Music Downloader переносит треки, которых больше нет ${data.kind === "playlist" ? "в плейлисте" : "в альбоме"}.
Само оно отсюда ничего не удаляет: что делать с этими файлами, решаете вы.

Если здесь трек, который ${data.kind === "playlist" ? "в плейлисте" : "в альбоме"} есть, — скорее всего, в тот раз
Яндекс Музыка показала не все треки (вы не вошли в аккаунт или мешал VPN). Войдите в аккаунт
и скачайте ещё раз: трек вернётся на своё место.
`;

// ------------------------------------------------------------ сверка с уже скачанным
// Файлы трека узнаются по описанию в _сведения/info.json (id трека → имя файла), а если его нет —
// по совпадению имени. Сдвинувшиеся треки переименовываются, убранные — переносятся в отдельную папку,
// недостающие возвращаются списком для скачивания. Каждый трек получает t.file — имя файла в папке.
// keepMissing — сайт показал не все треки: файлы тех, кого нет в списке, оставляем на месте.
async function syncFolder(data, dir, stats, step = () => {}) {
  const names = new Set();
  for await (const [name, h] of dir.entries()) if (h.kind === "file") names.add(name);
  const fileOf = (t) => t.stem + ".mp3";
  const jobs = [];

  // отдельные треки: только пропускаем уже скачанное, ничего не переименовываем и не убираем
  if (data.single) {
    for (const t of data.tracks) {
      stats.total++;
      if (t.unavailable) { stats.unavailable++; continue; }
      if (names.has(fileOf(t)) && (await fileSize(dir, fileOf(t))) > 0) {
        t.file = fileOf(t);
        stats.done++;
      } else jobs.push(t);
    }
    return jobs;
  }

  const info = await readJson(await dir.getDirectoryHandle(INFO_DIR, { create: true }), INFO_FILE);
  const old = new Map(Object.entries((info && info.files) || {}));
  const keepMissing = !!(data.expected && data.tracks.length < data.expected * PARTIAL_SHARE);

  const renames = [];
  const wanted = new Set();
  for (const t of data.tracks) {
    stats.total++;
    const target = fileOf(t);
    const was = old.get(t.id);
    old.delete(t.id);
    if (was && names.has(was)) {
      t.file = target;
      wanted.add(was);
      if (was !== target) renames.push({ from: was, to: target });
      stats.done++;
    } else if (t.unavailable) {
      stats.unavailable++;
    }
  }

  // файлы треков, которых больше нет в списке
  const gone = [...old.values()].filter((n) => names.has(n) && !wanted.has(n));
  if (gone.length && keepMissing) {
    stats.kept += gone.length;
  } else if (gone.length) {
    const removed = await dir.getDirectoryHandle(removedDirOf(data), { create: true });
    await writeReadme(removed, removedReadme(data));
    let n = 0;
    await pool(gone, FILE_OPS_PARALLEL, async (name) => {
      await moveFile(dir, name, removed, name);
      names.delete(name);
      stats.removed++;
      step(`Убираю треки, которых больше нет: ${++n} из ${gone.length}`);
    });
  }

  // Переименование в два шага (сначала во временные имена): при перестановке треков
  // новое имя одного файла может быть старым именем другого.
  if (renames.length) {
    let n = 0;
    await pool(renames, FILE_OPS_PARALLEL, async (r) => {
      r.tmp = `~ymd-${Math.random().toString(36).slice(2)}.tmp`;
      await moveFile(dir, r.from, dir, r.tmp);
      names.delete(r.from);
    });
    await pool(renames, FILE_OPS_PARALLEL, async (r) => {
      if (names.has(r.to)) {
        // на этом месте лежит чужой файл, которого нет в описании: убираем его в сторону, не удаляя
        const removed = await dir.getDirectoryHandle(removedDirOf(data), { create: true });
        await moveFile(dir, r.to, removed, r.to);
        stats.removed++;
      }
      await moveFile(dir, r.tmp, dir, r.to);
      names.add(r.to);
      stats.renamed++;
      step(`Перенумеровываю файлы: ${++n} из ${renames.length}`);
    });
  }

  // остальное: файл с нужным именем уже есть (описания не было) — берём его, иначе качаем
  for (const t of data.tracks) {
    if (t.file || t.unavailable) continue;
    const target = fileOf(t);
    if (names.has(target) && (await fileSize(dir, target)) > 0) {
      t.file = target;
      stats.done++;
    } else {
      jobs.push(t);
    }
  }
  return jobs;
}

// Записывает _сведения/info.json, readme.txt и список воспроизведения плейлиста.
async function writeInfo(data, dir, r) {
  const infoDir = await dir.getDirectoryHandle(INFO_DIR, { create: true });
  await writeReadme(infoDir, INFO_README);
  const prev = await readJson(infoDir, INFO_FILE);
  const files = {};
  // треки, которые сейчас недоступны, но были скачаны раньше, из описания не выпадают
  if (prev && prev.files) {
    for (const t of data.tracks) if (!t.file && prev.files[t.id]) files[t.id] = prev.files[t.id];
  }
  for (const t of data.tracks) if (t.file) files[t.id] = t.file;
  await writeText(infoDir, INFO_FILE, JSON.stringify({
    version: 1, kind: data.kind, id: data.id, title: data.title, artist: data.artist || data.owner || "",
    year: data.year || null, url: data.url, tracks: data.tracks.length, files, failed: r.failed,
    updatedAt: Date.now(),
  }, null, 1));
  if (data.kind === "playlist") await writeText(dir, safePlaylistName(data.title) + ".m3u8", m3u8(data));
}

const safePlaylistName = (title) => EXT.safeName(title || "Плейлист", 80);

if (typeof module !== "undefined") {
  module.exports = { pool, writeText, readJson, fileSize, moveFile, buildId3, id3Skipper, m3u8, syncFolder, writeInfo,
    INFO_DIR, INFO_FILE, SINGLES_DIR, removedDirOf };
}
