// Вкладка «Настройки»: сколько качать сразу, качество mp3, теги и обложки.
// Значения хранятся в chrome.storage.local (settings), читаются в начале каждой загрузки (EXT.loadSettings).

(() => {
  const LABELS = {
    parallel: { 1: "1", 2: "2", 3: "3", 5: "5" },
    quality: { best: "Лучшее", 192: "Экономное" },
    tagCover: { "400x400": "400 px", "600x600": "600 px", "1000x1000": "1000 px", none: "Без обложки" },
  };
  let current = { ...EXT.DEFAULTS };
  let noteTimer = null;

  function paint() {
    for (const seg of document.querySelectorAll(".seg[data-pref]")) {
      for (const b of seg.children) b.setAttribute("aria-checked", String(b.dataset.value === String(current[seg.dataset.pref])));
    }
    for (const cb of document.querySelectorAll("input.check[data-pref]")) cb.checked = !!current[cb.dataset.pref];
    // без тегов размер обложки в них ни на что не влияет
    $("tagCoverRow").classList.toggle("off", !current.tags);
    for (const b of $("tagCoverRow").querySelectorAll("button")) b.disabled = !current.tags;
  }

  async function save(key, value) {
    current = EXT.normalizeSettings({ ...current, [key]: value });
    paint();
    await chrome.storage.local.set({ settings: current });
    $("prefsNote").textContent = "Сохранено. Действует со следующей загрузки, уже скачанные треки не меняются.";
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      $("prefsNote").textContent = "Действуют со следующей загрузки. Уже скачанные треки не меняются.";
    }, 4000);
  }

  for (const seg of document.querySelectorAll(".seg[data-pref]")) {
    const key = seg.dataset.pref;
    for (const value of EXT.CHOICES[key]) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.dataset.value = String(value);
      b.textContent = LABELS[key][value];
      b.addEventListener("click", () => save(key, value));
      seg.append(b);
    }
  }
  for (const cb of document.querySelectorAll("input.check[data-pref]")) {
    cb.addEventListener("change", () => save(cb.dataset.pref, cb.checked));
  }

  // настройки поменяли в другой вкладке загрузок
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.settings) {
      current = EXT.normalizeSettings(ch.settings.newValue);
      paint();
    }
  });

  EXT.loadSettings().then((s) => {
    current = s;
    paint();
  });
  paint();
})();
