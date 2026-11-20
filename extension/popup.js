const $ = (id) => document.getElementById(id);

let tab = null;

// что открыто во вкладке — текст главной кнопки или null
function pageAction(url) {
  const l = EXT.parseLink(url);
  if (!l) return null;
  if (l.kind === "track" && l.album) return "Скачать этот альбом";
  return {
    album: "Скачать этот альбом", playlist: "Скачать этот плейлист", track: "Скачать этот трек",
    artist: "Выбрать альбомы исполнителя", collection: "Выбрать мои плейлисты",
  }[l.kind] || null;
}

function render(status) {
  status = status || {};
  const busy = !!status.text && !status.done && !status.error;
  $("collecting").textContent = status.text || "";
  $("error").textContent = status.error || "";
  $("go").disabled = busy;
  $("paste").disabled = busy;
}

async function load() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const action = tab && pageAction(tab.url);
  if (action) {
    $("go").hidden = false;
    $("go").textContent = action;
  } else {
    $("hint").textContent = "Откройте альбом, плейлист или исполнителя на Яндекс Музыке, или вставьте ссылку ниже.";
  }
  const { status } = await chrome.storage.local.get("status");
  // старое сообщение о завершении не показываем
  render(status && (status.done || status.error) ? null : status);
  if (!action) $("url").focus();
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.status) render(ch.status.newValue);
});

function start(url) {
  render({ text: "Ищу треки…" });
  chrome.runtime.sendMessage({ type: "download", url, tabId: tab && tab.id });
}

// /album/1/track/2 — страница альбома: скачиваем альбом
function pageUrl(url) {
  const l = EXT.parseLink(url);
  return l && l.kind === "track" && l.album ? EXT.linkUrl({ kind: "album", album: l.album }) : url;
}

$("go").addEventListener("click", () => start(pageUrl(tab.url)));
$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("url").value.trim();
  if (!url) {
    render({ error: "Вставьте ссылку на альбом, плейлист или трек." });
    return;
  }
  start(url);
  $("url").value = "";
});
$("open").addEventListener("click", () => chrome.runtime.sendMessage({ type: "open" }));
$("ver").textContent = "v" + chrome.runtime.getManifest().version;
$("repo").href = "https://github.com/JrTomasLight/Yandex-Music-Downloader";

// плашка о новой версии — по нажатию открывается вкладка загрузок с кнопкой «Обновить»
async function showUpdate() {
  const { update: u } = await chrome.storage.local.get("update");
  const on = u && u.version && compareVersions(u.version, chrome.runtime.getManifest().version) > 0;
  $("upd").hidden = !on;
  if (on) {
    $("upd").textContent = `Доступна версия ${u.version} — обновить`;
    const small = document.createElement("small");
    small.textContent = "Откроется вкладка загрузок, обновление займёт несколько секунд";
    $("upd").append(small);
  }
}
$("upd").addEventListener("click", () => chrome.runtime.sendMessage({ type: "open" }));
showUpdate();

load();
