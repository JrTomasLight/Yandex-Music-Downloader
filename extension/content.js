// Работает внутри открытой вкладки Яндекс Музыки: собирает треки альбома или плейлиста и получает
// ссылки на файлы через тот же API, что и сам сайт, от имени вошедшего пользователя.
// Берётся только то, что сайт сам отдаёт этому пользователю: прямая ссылка на обычный mp3
// (download-info?direct=true). Защищённые потоки не используются.
(() => {
  try {
    if (window.__ymdCollector && window.__ymdCollector()) return; // уже работает
  } catch { /* скрипт от прежней версии расширения — ставим новый */ }
  // флаг — функция: после перезагрузки расширения старый скрипт «мёртв», и chrome.runtime.id у него пропадает
  window.__ymdCollector = () => !!(chrome.runtime && chrome.runtime.id);

  const { safeName, plural } = EXT;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const REQUEST_TIMEOUT = 30000;
  const ATTEMPTS = 4;
  const LINKS_PARALLEL = 3;

  // API сайта: music.yandex.ru → api.music.yandex.ru (и так же для других доменов)
  const API = "https://api." + location.hostname.replace(/^(www|next)\./, "");

  class ApiError extends Error {
    constructor(message, status, body) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }

  // onRetry(попытка, причина) — сообщить, что сайт ответил ошибкой и запрос повторяется
  async function api(path, { method = "GET", body = null, onRetry = null } = {}) {
    let lastErr, status = 0;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt && onRetry) onRetry(attempt + 1, lastErr && lastErr.message);
      // без тайм-аута один зависший ответ навсегда останавливает сбор
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
      try {
        const r = await fetch(API + path, {
          method,
          body,
          headers: body ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
          credentials: "include",
          signal: ctrl.signal,
        });
        status = r.status;
        let json = null;
        try { json = await r.json(); } catch { /* не JSON */ }
        if (r.ok) return json && "result" in json ? json.result : json;
        const why = json && json.result && (json.result.message || json.result.name);
        lastErr = new ApiError(
          r.status === 429 ? "Яндекс Музыка просит подождать (слишком много запросов)"
            : r.status === 401 ? "Нужно войти в аккаунт Яндекс Музыки"
              : `Яндекс Музыка ответила ошибкой ${r.status}` + (why ? ` (${why})` : ""),
          r.status, json);
        // нет такого, нет прав, не вошли — повторять бессмысленно
        if ([400, 401, 403, 404].includes(r.status)) throw lastErr;
      } catch (e) {
        if (e instanceof ApiError && [400, 401, 403, 404].includes(e.status)) throw e;
        lastErr = ctrl.signal.aborted ? new Error("Яндекс Музыка не ответила за 30 секунд") : e;
      } finally {
        clearTimeout(timer);
      }
      // «слишком много запросов» — ждём заметно дольше, иначе сайт откажет снова
      await sleep((status === 429 ? 10000 : 1500) * (attempt + 1));
    }
    throw lastErr;
  }

  // текст для повтора запроса: «Альбом: Яндекс Музыка не ответила за 30 секунд — пробую ещё раз (2 из 4)…»
  const retryNote = (label, progress) => (n, why) =>
    progress(`${label}: ${why || "Яндекс Музыка не ответила"} — пробую ещё раз (${n} из ${ATTEMPTS})…`);

  let me = null;
  async function account() {
    if (me) return me;
    const a = await api("/account/about");
    if (!a || !a.uid) throw new Error("Войдите в аккаунт Яндекс Музыки на сайте и попробуйте ещё раз.");
    me = { uid: String(a.uid), login: a.login || "", plus: !!(a.hasPlus || a.hasMusicSubscription) };
    return me;
  }

  // ---------------------------------------------------------------- описание трека
  const names = (list) => (list || []).map((a) => a && a.name).filter(Boolean).join(", ");
  const withVersion = (title, version) => (version ? `${title} (${version})` : title || "");
  const pad = (n, width) => String(n).padStart(width, "0");

  function unavailableReason(t) {
    if (!t) return "трек удалён";
    if (t.available === false) {
      return t.availableForPremiumUsers ? "трек недоступен по вашей подписке" : "трек недоступен на Яндекс Музыке";
    }
    return null;
  }

  // album — альбом, из которого берутся год, обложка и номер (у трека их может быть несколько)
  function trackInfo(t, album) {
    const a = album || (t.albums && t.albums[0]) || {};
    const pos = (t.albums || []).find((x) => String(x.id) === String(a.id));
    const tp = (pos && pos.trackPosition) || a.trackPosition || {};
    return {
      id: String(t.id),
      albumId: a.id ? String(a.id) : null,
      title: withVersion(t.title, t.version),
      artists: names(t.artists) || names(a.artists),
      album: withVersion(a.title, a.version),
      albumArtist: names(a.artists),
      year: a.year || (a.releaseDate ? +String(a.releaseDate).slice(0, 4) : null),
      genre: a.genre || null,
      disc: tp.volume || 1,
      track: tp.index || null,
      cover: t.coverUri || a.coverUri || (a.cover && a.cover.uri) || null,
      durationMs: t.durationMs || 0,
      link: a.id ? `https://music.yandex.ru/album/${a.id}/track/${t.id}` : `https://music.yandex.ru/track/${t.id}`,
      unavailable: unavailableReason(t),
    };
  }

  // ---------------------------------------------------------------- альбом
  async function collectAlbum(id, progress) {
    progress("Альбом: читаю список треков…");
    const a = await api(`/albums/${encodeURIComponent(id)}/with-tracks?resumeStream=false&richTracks=true`,
      { onRetry: retryNote("Альбом", progress) });
    if (!a || !a.id) throw new Error("Альбом не найден.");
    const volumes = (a.volumes || []).filter((v) => v && v.length);
    const title = withVersion(a.title, a.version);
    const various = (a.artists || []).some((x) => x.various) || !(a.artists || []).length;
    const albumArtist = various ? "Сборники" : names(a.artists);
    const folderArtist = various ? "Сборники" : (a.artists[0] && a.artists[0].name) || "Неизвестный исполнитель";
    const year = a.year || (a.releaseDate ? +String(a.releaseDate).slice(0, 4) : null);
    const root = `${safeName(folderArtist)}/${safeName(year ? `${year} - ${title}` : title)}`;
    const multi = volumes.length > 1;
    const tracks = [];
    volumes.forEach((vol, d) => {
      const width = Math.max(2, String(vol.length).length);
      vol.forEach((t, i) => {
        const info = trackInfo(t, a);
        info.disc = d + 1;
        info.discTotal = volumes.length;
        info.track = i + 1;
        info.trackTotal = vol.length;
        info.albumArtist = albumArtist;
        info.n = tracks.length + 1;
        // в сборнике исполнитель у каждого трека свой — пишем его в имя файла
        const who = various || (info.artists && info.artists !== names(a.artists)) ? `${info.artists} - ` : "";
        info.stem = (multi ? `${d + 1}-` : "") + `${pad(i + 1, width)}. ` + safeName(who + info.title, 120);
        tracks.push(info);
      });
    });
    const found = tracks.length;
    progress(`Альбом «${title}»: ${found} ${plural(found, "трек", "трека", "треков")}`);
    return {
      id: `album/${a.id}`, kind: "album", title, artist: albumArtist, year, root,
      url: `https://music.yandex.ru/album/${a.id}`,
      cover: a.coverUri || (a.cover && a.cover.uri) || null,
      found, expected: a.trackCount || found, tracks,
    };
  }

  // ---------------------------------------------------------------- плейлист
  // У плейлиста сайт иногда отдаёт только id треков — дозапрашиваем описания пачками.
  async function fillTracks(items, label, progress) {
    const need = items.filter((x) => !x.track).map((x) => String(x.id));
    const got = new Map();
    for (let i = 0; i < need.length; i += 200) {
      const chunk = need.slice(i, i + 200);
      progress(`${label}: уточняю треки ${Math.min(i + chunk.length, need.length)} из ${need.length}…`);
      const list = await api("/tracks", {
        method: "POST",
        body: new URLSearchParams({ "track-ids": chunk.join(","), "with-positions": "true" }).toString(),
        onRetry: retryNote(label, progress),
      });
      for (const t of list || []) got.set(String(t.id), t);
    }
    return items.map((x) => x.track || got.get(String(x.id)) || null);
  }

  async function collectPlaylist(l, progress) {
    progress("Плейлист: читаю список треков…");
    const path = l.uuid ? `/playlist/${encodeURIComponent(l.uuid)}?resumeStream=false&richTracks=true`
      : `/users/${encodeURIComponent(l.owner)}/playlists/${encodeURIComponent(l.playlist)}?richTracks=true`;
    const p = await api(path, { onRetry: retryNote("Плейлист", progress) });
    if (!p || p.kind == null) throw new Error("Плейлист не найден (или он скрыт).");
    const title = p.title || "Плейлист";
    const label = `Плейлист «${title}»`;
    const raw = await fillTracks(p.tracks || [], label, progress);
    const width = Math.max(2, String(raw.length).length);
    const tracks = raw.map((t, i) => {
      const info = t ? trackInfo(t) : { id: String((p.tracks[i] || {}).id || i), title: "", artists: "", unavailable: "трек удалён" };
      info.n = i + 1;
      info.stem = `${pad(i + 1, width)}. ` + safeName(t ? `${info.artists} - ${info.title}` : `Трек ${info.id}`, 120);
      return info;
    });
    const uuid = p.playlistUuid || l.uuid || null;
    const owner = (p.owner && (p.owner.login || p.owner.uid)) || l.owner;
    const found = tracks.length;
    progress(`${label}: ${found} ${plural(found, "трек", "трека", "треков")}`);
    return {
      id: uuid ? `playlists/${uuid}` : `users/${String(owner).toLowerCase()}/playlists/${p.kind}`,
      kind: "playlist", title, owner: (p.owner && p.owner.name) || owner || "",
      root: `Плейлисты/${safeName(title)}`,
      url: uuid ? `https://music.yandex.ru/playlists/${uuid}` : `https://music.yandex.ru/users/${encodeURIComponent(owner)}/playlists/${p.kind}`,
      cover: (p.cover && (p.cover.uri || (p.cover.itemsUri && p.cover.itemsUri[0]))) || null,
      found, expected: p.trackCount || found, tracks,
    };
  }

  // ---------------------------------------------------------------- отдельные треки
  const SINGLES_DIR = "Отдельные треки";
  async function collectTracks(ids, progress) {
    progress(ids.length > 1 ? `Треки: ${ids.length}…` : "Трек…");
    const list = await api("/tracks", {
      method: "POST",
      body: new URLSearchParams({ "track-ids": ids.join(","), "with-positions": "true" }).toString(),
      onRetry: retryNote("Трек", progress),
    });
    const byId = new Map((list || []).map((t) => [String(t.id), t]));
    const tracks = ids.map((id, i) => {
      const t = byId.get(String(id));
      const info = t ? trackInfo(t) : { id: String(id), title: "", artists: "", unavailable: "трек не найден" };
      info.n = i + 1;
      info.stem = safeName(`${info.artists} - ${info.title}`, 120);
      return info;
    });
    if (!tracks.some((t) => t.title)) throw new Error("Трек не найден.");
    const first = tracks[0];
    return {
      id: tracks.length === 1 ? `track/${first.id}` : "tracks", kind: "tracks", single: true,
      title: tracks.length === 1 ? `${first.artists} — ${first.title}` : `Треки (${tracks.length})`,
      root: SINGLES_DIR, url: first.link, found: tracks.length, expected: tracks.length, tracks,
    };
  }

  // ---------------------------------------------------------------- списки для выбора
  async function listAlbums(artist) {
    const out = [];
    for (const [kind, also] of [["direct-albums", false], ["also-albums", true]]) {
      for (let page = 0; page < 50; page++) {
        const r = await api(`/artists/${encodeURIComponent(artist)}/${kind}?page=${page}&page-size=100&sort-by=year`);
        for (const a of (r && r.albums) || []) {
          out.push({
            id: String(a.id), title: withVersion(a.title, a.version), year: a.year || null,
            type: a.type || "album", tracks: a.trackCount || 0, also,
            url: `https://music.yandex.ru/album/${a.id}`, artists: names(a.artists),
          });
        }
        const pg = r && r.pager;
        if (!pg || (pg.page + 1) * pg.perPage >= pg.total) break;
      }
    }
    let name = "";
    try {
      const info = await api(`/artists/${encodeURIComponent(artist)}/brief-info`);
      name = (info && info.artist && info.artist.name) || "";
    } catch { /* без имени */ }
    if (!name) name = (out.find((a) => !a.also) || {}).artists || "";
    return { artist: name, albums: out };
  }

  async function listPlaylists(owner) {
    const a = await account();
    const who = owner || a.uid;
    const list = await api(`/users/${encodeURIComponent(who)}/playlists/list`);
    const out = [];
    // «Мне нравится» в общий список не входит — добавляем первым
    try {
      const liked = await api(`/users/${encodeURIComponent(who)}/playlists/3?richTracks=false`);
      if (liked && liked.kind === 3) {
        out.push({
          title: liked.title || "Мне нравится", tracks: liked.trackCount || (liked.tracks || []).length,
          url: liked.playlistUuid ? `https://music.yandex.ru/playlists/${liked.playlistUuid}`
            : `https://music.yandex.ru/users/${encodeURIComponent(who)}/playlists/3`,
        });
      }
    } catch { /* без «Мне нравится» */ }
    for (const p of list || []) {
      out.push({
        title: p.title || "Плейлист", tracks: p.trackCount || 0,
        url: p.playlistUuid ? `https://music.yandex.ru/playlists/${p.playlistUuid}`
          : `https://music.yandex.ru/users/${encodeURIComponent(who)}/playlists/${p.kind}`,
      });
    }
    return { owner: owner || a.login, playlists: out };
  }

  // ---------------------------------------------------------------- ссылки на файлы
  // Прямая ссылка на mp3 лучшего качества, которую сайт сам отдаёт этому пользователю.
  async function linkFor(id) {
    try {
      const list = await api(`/tracks/${encodeURIComponent(id)}/download-info?direct=true`);
      const mp3 = (list || []).filter((x) => x && x.codec === "mp3" && x.direct && x.downloadInfoUrl && !x.preview);
      if (!mp3.length) return { error: "сайт не дал ссылку на файл этого трека" };
      mp3.sort((x, y) => (y.bitrateInKbps || 0) - (x.bitrateInKbps || 0));
      return { url: mp3[0].downloadInfoUrl, bitrate: mp3[0].bitrateInKbps || 0 };
    } catch (e) {
      if (e.status === 403) return { error: "трек недоступен по вашей подписке", final: true };
      if (e.status === 404) return { error: "трек не найден", final: true };
      if (e.status === 401) return { error: "нужно войти в аккаунт Яндекс Музыки" };
      return { error: e.message || String(e) };
    }
  }

  async function links(ids) {
    const out = {};
    let next = 0;
    async function worker() {
      while (next < ids.length) {
        const id = ids[next++];
        out[id] = await linkFor(id);
      }
    }
    await Promise.all(Array.from({ length: Math.min(LINKS_PARALLEL, ids.length) }, worker));
    return out;
  }

  // ---------------------------------------------------------------- сообщения
  async function collect(target, progress) {
    await account(); // без входа сайт отдаёт не всё — лучше сразу сказать
    if (target.kind === "album") return collectAlbum(target.album, progress);
    if (target.kind === "playlist") return collectPlaylist(target, progress);
    if (target.kind === "track") return collectTracks([target.track], progress);
    if (target.kind === "tracks") return collectTracks(target.ids, progress);
    throw new Error("Эту страницу скачать нельзя: откройте альбом, плейлист или трек.");
  }

  const answer = (p, reply) => p.then((r) => reply(r), (e) => reply({ error: String(e.message || e) }));

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg.cmd === "albums") return answer(listAlbums(msg.artist), reply), true;
      if (msg.cmd === "playlists") return answer(listPlaylists(msg.owner), reply), true;
      if (msg.cmd === "links") return answer(links(msg.ids || []).then((l) => ({ links: l })), reply), true;
      if (msg.cmd === "ping") return reply({ ok: true }), false;
      if (msg.cmd !== "collect") return;
      reply({ ok: true });
      const job = msg.job; // по нему кнопка на сайте узнаёт, что происходит с её альбомом
      const progress = (text) => chrome.runtime.sendMessage({ type: "progress", text, job }).catch(() => {});
      collect(msg.target, progress)
        .then((data) => chrome.runtime.sendMessage({ type: "collected", data, job }))
        .catch((e) => chrome.runtime.sendMessage({ type: "error", text: String(e.message || e), job }));
    });
  }
})();
