// Общее для фонового скрипта, страниц расширения и скриптов на страницах Яндекс Музыки.
// Подключается несколько раз в одну и ту же вкладку (скрипт кнопки на сайте и скрипт сбора),
// поэтому без объявлений верхнего уровня — только self.EXT = … (и всегда заново:
// после обновления расширения во вкладке могла остаться прежняя версия).
//
// Как подключать:
//   background.js        importScripts("common.js", "update.js");
//   страницы расширения  <script src="common.js"></script> перед остальными
//   скрипт на сайте      в manifest.json: "js": ["common.js", "button.js"]
//   внедряемый скрипт    chrome.scripting.executeScript({ files: ["common.js", "content.js"] })
self.EXT = (() => {
  // Этапы задачи (альбома, плейлиста), пока она не закончилась. Состояние задачи хранится
  // в chrome.storage.local под ключом "job:<ключ>" — по нему кнопки на сайте и списки на странице
  // показывают, что происходит. Итоговые этапы: done, cancelled, removed, failed, error.
  const ACTIVE = new Set(["collect", "queued", "folder", "sync", "download"]);

  // Сбор, сверка и скачивание сообщают о ходе постоянно. Если такой этап давно не обновлялся,
  // его прервали (перезапуск расширения или браузера, закрытая вкладка) — он больше не идёт.
  // Без этой проверки кнопки навсегда застревают на «Ищу…».
  const STALE_MS = 10 * 60 * 1000;
  const isActive = (s) => !!s && ACTIVE.has(s.phase) &&
    (!["collect", "sync", "download"].includes(s.phase) || Date.now() - (s.at || 0) < STALE_MS);

  // Домены Яндекс Музыки. Тот же список — в manifest.json (host_permissions и content_scripts).
  const HOST = /^(?:www\.|next\.)?music\.yandex\.(?:ru|by|kz|uz|com)$/i;
  const isMusicHost = (host) => HOST.test(String(host || ""));

  function toURL(url) {
    let s = String(url || "").trim();
    if (!s) return null;
    // ссылку часто копируют без https://
    if (!/^[a-z][a-z\d+.-]*:/i.test(s)) s = "https://" + s;
    try {
      return new URL(s);
    } catch {
      return null;
    }
  }

  function pathParts(url) {
    const u = url instanceof URL ? url : toURL(url);
    if (!u) return null;
    try {
      return u.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    } catch {
      return null;
    }
  }

  const NUM = /^\d+$/;
  const SLUG = /^[\w.-]+$/;

  // Что за ссылка на Яндекс Музыку. null — не ссылка на сайт или страница, которую нечего скачивать.
  //   альбом      /album/<id>                       → { kind: "album", album }
  //   трек        /album/<id>/track/<id>, /track/<id> → { kind: "track", track, album? }
  //   исполнитель /artist/<id>[/tracks|/albums…]    → { kind: "artist", artist }
  //   плейлист    /users/<логин>/playlists/<номер>  → { kind: "playlist", owner, playlist }
  //               /playlists/<uuid>                 → { kind: "playlist", uuid }
  //                 (в том числе «Мне нравится»: /playlists/lk.<uuid>)
  //   коллекция   /collection…, /users/<логин>/playlists → { kind: "collection", owner? } — свои плейлисты списком
  // Сверено с сайтом в ноябре 2026: новый интерфейс использует /album/…/track/… и /playlists/<uuid>.
  function parseLink(url) {
    const u = toURL(url);
    if (!u || !isMusicHost(u.hostname)) return null;
    const p = pathParts(u);
    if (!p) return null;
    if (p[0] === "album" && NUM.test(p[1] || "")) {
      if (p[2] === "track" && NUM.test(p[3] || "")) return { kind: "track", track: p[3], album: p[1] };
      return { kind: "album", album: p[1] };
    }
    if (p[0] === "track" && NUM.test(p[1] || "")) return { kind: "track", track: p[1] };
    if (p[0] === "artist" && NUM.test(p[1] || "")) return { kind: "artist", artist: p[1] };
    if (p[0] === "users" && p[1] && p[2] === "playlists" && NUM.test(p[3] || "")) {
      return { kind: "playlist", owner: p[1], playlist: p[3] };
    }
    if (p[0] === "playlists" && SLUG.test(p[1] || "")) return { kind: "playlist", uuid: p[1] };
    if (p[0] === "users" && p[1] && p[2] === "playlists" && !p[3]) return { kind: "collection", owner: p[1] };
    if (p[0] === "collection") return { kind: "collection" };
    return null;
  }

  // Адрес страницы на сайте по разобранной ссылке — для «Мои загрузки» и ссылок в описаниях.
  function linkUrl(l) {
    const base = "https://music.yandex.ru";
    if (l.kind === "album") return `${base}/album/${l.album}`;
    if (l.kind === "track") return l.album ? `${base}/album/${l.album}/track/${l.track}` : `${base}/track/${l.track}`;
    if (l.kind === "artist") return `${base}/artist/${l.artist}`;
    if (l.kind === "playlist") {
      return l.uuid ? `${base}/playlists/${l.uuid}` : `${base}/users/${encodeURIComponent(l.owner)}/playlists/${l.playlist}`;
    }
    return base + "/collection";
  }

  // Обложка: сайт отдаёт адрес вида avatars.yandex.net/get-music-content/…/%% — вместо %% подставляется размер.
  function coverUrl(uri, size = "1000x1000") {
    if (!uri) return null;
    return "https://" + String(uri).replace(/^https?:\/\//, "").replace("%%", size);
  }

  // 1 трек, 2 трека, 5 треков
  const plural = (n, one, few, many) => {
    const a = n % 10, b = n % 100;
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  };

  // Ключ задачи — одинаковый для всех вариантов ссылки на одно и то же: разные домены, регистр логина,
  // трек по адресу альбома и сам по себе. По нему кнопка на сайте, очередь и списки узнают одно и то же.
  function keyOfLink(l) {
    if (!l) return null;
    if (l.kind === "album") return "album/" + l.album;
    if (l.kind === "track") return "track/" + l.track;
    if (l.kind === "artist") return "artist/" + l.artist;
    if (l.kind === "playlist") {
      return l.uuid ? "playlists/" + l.uuid : "users/" + l.owner.toLowerCase() + "/playlists/" + l.playlist;
    }
    return null;
  }
  const keyOf = (url) => keyOfLink(parseLink(url));

  // Имя файла или папки, допустимое в Windows. Точку и пробел в конце имени Windows не принимает —
  // убираем их и после обрезки по длине. Имена устройств (CON, NUL, COM1…) Windows не даёт создать
  // даже с расширением («Con.mp3»), а песня с таким названием вполне может быть.
  const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;
  function safeName(s, limit = 80) {
    const trim = (x) => x.replace(/^[.\s]+|[.\s]+$/g, "");
    // сначала переводы строк и табуляции — в пробелы, потом запрещённые символы — в «_»
    s = trim(String(s || "").replace(/\s+/g, " ").replace(/[<>:"/\\|?*\x00-\x1f~]/g, "_"));
    s = trim(s.slice(0, limit)) || "untitled";
    return RESERVED.test(s) ? "_" + s : s;
  }

  return { ACTIVE, STALE_MS, isActive, isMusicHost, pathParts, parseLink, keyOfLink, keyOf, linkUrl, coverUrl, plural, safeName };
})();
