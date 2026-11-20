// Заглушки для проверки скриптов расширения в Node через vm, без браузера.
// Пример:
//   const { loadScripts, chromeStub } = require("./stub.cjs");
//   const env = chromeStub({ local: { pending: [] } });
//   const ctx = loadScripts(["common.js", "background.js"], { chrome: env.chrome });
//   await env.fire("onInstalled", { reason: "update" });
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT_DIR = path.join(__dirname, "..", "extension");
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// chrome.storage.local / session: хранит копии, как настоящий storage, и сообщает об изменениях
function storageArea(data, areaName, onChanged) {
  return {
    data,
    get: async (k) => {
      const keys = k == null ? Object.keys(data) : typeof k === "object" && !Array.isArray(k) ? Object.keys(k) : [].concat(k);
      const r = {};
      for (const x of keys) {
        if (x in data) r[x] = clone(data[x]);
        else if (k && typeof k === "object" && !Array.isArray(k)) r[x] = clone(k[x]);
      }
      return r;
    },
    set: async (v) => {
      const ch = {};
      for (const [x, val] of Object.entries(v)) {
        ch[x] = { oldValue: clone(data[x]), newValue: clone(val) };
        data[x] = clone(val);
      }
      onChanged(ch, areaName);
    },
    remove: async (k) => {
      const ch = {};
      for (const x of [].concat(k)) {
        if (x in data) ch[x] = { oldValue: data[x] };
        delete data[x];
      }
      onChanged(ch, areaName);
    },
  };
}

// событие chrome.*.onXxx: addListener + fire для теста
function event() {
  const fns = [];
  return {
    addListener: (f) => fns.push(f),
    removeListener: (f) => { const i = fns.indexOf(f); if (i >= 0) fns.splice(i, 1); },
    hasListener: (f) => fns.includes(f),
    fns,
  };
}

// Минимальный chrome.* — дополняйте под проверяемый скрипт через overrides.
function chromeStub({ local = {}, session = {}, overrides = {} } = {}) {
  const ev = {
    onMessage: event(), onInstalled: event(), onStartup: event(), onChanged: event(),
    onAlarm: event(), onMenuClicked: event(), onTabUpdated: event(), onTabRemoved: event(), onNotificationClicked: event(),
  };
  const changed = (ch, area) => ev.onChanged.fns.forEach((f) => f(ch, area));
  const sent = [];
  const chrome = {
    runtime: {
      id: "test",
      getManifest: () => JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8")),
      getURL: (x) => "chrome-extension://test/" + x,
      sendMessage: async (m) => { sent.push(m); },
      getContexts: async () => [],
      reload() {},
      onMessage: ev.onMessage, onInstalled: ev.onInstalled, onStartup: ev.onStartup,
    },
    storage: {
      local: storageArea(local, "local", changed),
      session: storageArea(session, "session", changed),
      onChanged: ev.onChanged,
    },
    alarms: { get: async () => null, create: async () => {}, clear: async () => true, onAlarm: ev.onAlarm },
    contextMenus: { create() {}, removeAll(cb) { cb && cb(); }, onClicked: ev.onMenuClicked },
    tabs: {
      query: async () => [], get: async (id) => ({ id, status: "complete" }), create: async (o) => ({ id: 100, ...o }),
      update: async (id, o) => ({ id, ...o }), remove: async () => {}, sendMessage: async (id, m) => { sent.push({ tab: id, ...m }); },
      onUpdated: ev.onTabUpdated, onRemoved: ev.onTabRemoved,
    },
    windows: { update: async () => {} },
    scripting: { executeScript: async () => [] },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    notifications: { create: (id, o, cb) => cb && cb(id), clear: (id, cb) => cb && cb(true), onClicked: ev.onNotificationClicked },
  };
  for (const [ns, val] of Object.entries(overrides)) chrome[ns] = { ...(chrome[ns] || {}), ...val };
  // вызвать все обработчики события и дождаться их
  const fire = async (name, ...args) => Promise.all(ev[name].fns.map((f) => f(...args)));
  // отправить сообщение в onMessage так, как это делает браузер: ответ — через sendResponse
  const message = (msg, sender = { url: chrome.runtime.getURL("downloader.html"), tab: { id: 1 } }) =>
    new Promise((resolve) => {
      let answered = false;
      const reply = (r) => { if (!answered) { answered = true; resolve(r); } };
      const kept = ev.onMessage.fns.map((f) => f(msg, sender, reply)).some((x) => x === true);
      if (!kept) setTimeout(() => reply(undefined), 0);
    });
  return { chrome, ev, fire, message, sent, local, session };
}

// Загрузить файлы расширения в один контекст, как importScripts в фоновом скрипте.
// extraCode — выражение в конце, чтобы достать то, что объявлено внутри (function/const верхнего уровня).
function loadScripts(files, globals = {}, extraCode = "") {
  const ctx = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, Blob, Response, DecompressionStream, CompressionStream,
    AbortController, AbortSignal, structuredClone, console, setTimeout, clearTimeout, setInterval, clearInterval,
    queueMicrotask, Promise, fetch: async () => { throw new Error("сеть в тестах отключена"); },
    importScripts: () => {},
    ...globals,
  });
  ctx.self = ctx;
  ctx.globalThis = ctx;
  const code = files.map((f) => fs.readFileSync(path.join(EXT_DIR, f), "utf8")).join(";\n") + (extraCode ? ";\n" + extraCode : "");
  ctx.__result = vm.runInContext(code, ctx, { filename: files.join("+") });
  return ctx;
}

// Папка в памяти с тем же интерфейсом, что FileSystemDirectoryHandle (то, чем пользуются скрипты расширения).
// failOn(путь) → true — запись этого файла падает (проверка отката).
function memoryDir(name = "root", failOn = () => false, prefix = "") {
  const entries = new Map();
  const dir = {
    kind: "directory", name, _map: entries,
    async getDirectoryHandle(n, { create } = {}) {
      let e = entries.get(n);
      if (!e) {
        if (!create) throw Object.assign(new Error("NotFoundError: " + n), { name: "NotFoundError" });
        e = memoryDir(n, failOn, prefix + n + "/");
        entries.set(n, e);
      }
      if (e.kind !== "directory") throw Object.assign(new Error("TypeMismatchError"), { name: "TypeMismatchError" });
      return e;
    },
    async getFileHandle(n, { create } = {}) {
      let e = entries.get(n);
      if (!e) {
        if (!create) throw Object.assign(new Error("NotFoundError: " + n), { name: "NotFoundError" });
        e = { kind: "file", name: n, data: new Uint8Array(0) };
        e.getFile = async () => new Blob([e.data]);
        e.createWritable = async () => {
          const parts = [];
          return {
            write: async (d) => {
              if (failOn(prefix + n)) throw new Error("запись запрещена: " + prefix + n);
              parts.push(typeof d === "string" ? new TextEncoder().encode(d) : new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d));
            },
            close: async () => { e.data = new Uint8Array(await new Blob(parts).arrayBuffer()); },
            abort: async () => {},
          };
        };
        entries.set(n, e);
      }
      return e;
    },
    async removeEntry(n) {
      if (!entries.delete(n)) throw Object.assign(new Error("NotFoundError: " + n), { name: "NotFoundError" });
    },
    async *entries() { yield* entries.entries(); },
    async queryPermission() { return "granted"; },
    async requestPermission() { return "granted"; },
  };
  return dir;
}

// Содержимое папки в памяти: { "путь/файл": "текст" }
function dumpDir(dir, prefix = "", out = {}) {
  for (const [n, e] of dir._map) {
    if (e.kind === "directory") dumpDir(e, prefix + n + "/", out);
    else out[prefix + n] = new TextDecoder().decode(e.data);
  }
  return out;
}

module.exports = { EXT_DIR, chromeStub, loadScripts, memoryDir, dumpDir, storageArea, event };
