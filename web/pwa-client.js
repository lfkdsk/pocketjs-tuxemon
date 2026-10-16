// Browser-only controls for install and explicit per-language offline packs.
// The build hashes this file and injects its configuration into the game page.

const configNode = document.getElementById("pocket-pwa");
const config = configNode ? JSON.parse(configNode.textContent || "null") : null;

if (config && "serviceWorker" in navigator) {
  const languages = [
    ["en", "English", "英语"],
    ["zh", "Chinese", "中文"],
    ["de", "German", "德语"],
    ["fr", "French", "法语"],
    ["es", "Spanish", "西班牙语"],
    ["it", "Italian", "意大利语"],
    ["pt-br", "Portuguese (Brazil)", "巴西葡萄牙语"],
  ];
  const style = document.createElement("style");
  style.textContent = ".offline-controls{max-width:60rem;margin:1rem auto;padding:1rem;border:1px solid var(--line,#5f7180);border-radius:.75rem;background:var(--panel,#17232d)}" +
    ".offline-controls h2{margin-top:0}.offline-controls-row{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap}.offline-controls select,.offline-controls button{min-height:2.5rem}.offline-controls output{display:block;margin-top:.65rem}" +
    ".offline-missing{position:fixed;z-index:20;inset:0;display:grid;place-items:center;padding:1rem;background:#000b}.offline-missing[hidden]{display:none}.offline-missing-card{max-width:32rem;padding:1rem;border:2px solid #f4c35a;border-radius:.75rem;background:#17232d;color:#fff}.offline-missing-actions{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1rem}";
  document.head.append(style);
  const controls = document.createElement("section");
  controls.className = "offline-controls";
  controls.setAttribute("aria-labelledby", "offline-heading");
  controls.innerHTML = `<h2 id="offline-heading">Offline play / 离线游玩</h2>
    <div class="offline-controls-row">
      <label for="offline-language">Content language / 内容语言</label>
      <select id="offline-language">${languages.map(([code, label, labelZh]) =>
        `<option value="${code}">${label} / ${labelZh}</option>`).join("")}</select>
      <button type="button" id="offline-download" aria-pressed="false">Download or resume / 下载或继续</button>
      <button type="button" id="pwa-install" hidden>Install / 安装</button>
      <button type="button" id="pwa-update" hidden>Reload update / 重载更新</button>
    </div>
    <output id="offline-status" role="status" aria-live="polite"></output>`;
  const info = document.querySelector("section.info");
  if (info) info.before(controls);
  else (document.querySelector("main") || document.body).append(controls);
  const missingPanel = document.createElement("div");
  missingPanel.className = "offline-missing";
  missingPanel.id = "offline-missing";
  missingPanel.setAttribute("role", "alertdialog");
  missingPanel.setAttribute("aria-modal", "true");
  missingPanel.setAttribute("aria-labelledby", "offline-missing-title");
  missingPanel.hidden = true;
  missingPanel.innerHTML = `<div class="offline-missing-card"><h2 id="offline-missing-title">Offline content unavailable / 离线内容尚未下载</h2><p id="offline-missing-text"></p><div class="offline-missing-actions"><button type="button" id="offline-missing-retry">Retry / 重试</button><button type="button" id="offline-missing-return">Return to cached game / 返回已缓存游戏</button></div></div>`;
  document.body.append(missingPanel);

  const select = document.getElementById("offline-language");
  const button = document.getElementById("offline-download");
  const status = document.getElementById("offline-status");
  const install = document.getElementById("pwa-install");
  const update = document.getElementById("pwa-update");
  const missing = document.getElementById("offline-missing");
  const missingText = document.getElementById("offline-missing-text");
  const missingRetry = document.getElementById("offline-missing-retry");
  const missingReturn = document.getElementById("offline-missing-return");
  let downloading = false;
  let activeLanguage = null;
  let resumeLanguage = null;
  let installPrompt = null;
  let mapLoadFailure = null;
  let mapPrepareAttempts = 0;
  let mapPreparePolls = 0;
  let mapPrepareRecoveryState = "waiting";
  let mapPrepareTimer = null;
  let lastMapPrepareEntry = null;
  let workerBuild = null;
  const MAP_PREPARE_POLL_LIMIT = 64;
  const MAP_PREPARE_POLL_BASE_MS = 25;
  const MAP_PREPARE_POLL_MAX_MS = 1000;

  const mapIdForEntry = (entry) => {
    const match = /^maps\/(.+)\.rkm$/.exec(entry);
    return match ? match[1] : null;
  };
  const showMapLoadFailure = (failure) => {
    mapLoadFailure = failure;
    missingText.textContent = navigator.onLine
      ? `Could not load ${failure.mapId}. Retry now, or reload cached gameplay. / 无法加载 ${failure.mapId}，可重试或重新载入已缓存游戏。`
      : `The content for ${failure.mapId} is not cached. Reconnect to retry, or reload cached gameplay. / ${failure.mapId} 尚未缓存，联网后可重试，或重新载入已缓存游戏。`;
    missing.hidden = false;
    missingRetry.disabled = !navigator.onLine;
  };

  // The game captures this browser-only object by reference. Wrap only map
  // prepares after the first playable map: native builds retain their exact
  // bundle, while a failed Web fetch parks the same reducer frame until Retry
  // succeeds or Return reloads the already cached game page.
  let chunks = null;
  const installMapPrepareRecovery = () => {
    mapPrepareTimer = null;
    const next = globalThis.__pocketPak;
    if (!next || typeof next.prepare !== "function") {
      if (mapPreparePolls >= MAP_PREPARE_POLL_LIMIT) {
        mapPrepareRecoveryState = "unavailable";
        setStatus("Offline map recovery unavailable / 离线地图恢复暂不可用");
        return;
      }
      const delay = Math.min(
        MAP_PREPARE_POLL_BASE_MS * (2 ** mapPreparePolls),
        MAP_PREPARE_POLL_MAX_MS,
      );
      mapPreparePolls++;
      mapPrepareTimer = setTimeout(installMapPrepareRecovery, delay);
      return;
    }
    chunks = next;
    if (chunks.__pocketPwaMapPrepare) {
      mapPrepareRecoveryState = "wrapped";
      return;
    }
    const prepare = chunks.prepare.bind(chunks);
    Object.defineProperty(chunks, "__pocketPwaMapPrepare", { value: prepare });
    chunks.prepare = (entry) => {
      mapPrepareAttempts++;
      lastMapPrepareEntry = entry;
      return prepare(entry).catch((error) => {
        const mapId = typeof entry === "string" ? mapIdForEntry(entry) : null;
        if (!mapId) throw error;
        return new Promise((resolve) => {
          const failure = {
            mapId,
            entry,
            error,
            async retry() {
              try {
                await prepare(entry);
                if (mapLoadFailure === failure) {
                  mapLoadFailure = null;
                  missing.hidden = true;
                }
                resolve();
              } catch (nextError) {
                failure.error = nextError;
                showMapLoadFailure(failure);
              }
            },
          };
          showMapLoadFailure(failure);
        });
      });
    };
    mapPrepareRecoveryState = "wrapped";
  };
  installMapPrepareRecovery();

  const humanBytes = (bytes) => {
    const mib = bytes / (1024 * 1024);
    return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
  };
  const idleLabel = () => "Checking offline content… / 正在检查离线内容…";
  const setStatus = (text) => {
    status.textContent = text;
  };
  const languageNames = (language) => {
    const entry = languages.find(([code]) => code === language);
    return { en: entry?.[1] ?? language, zh: entry?.[2] ?? language };
  };
  const switchedDownloadStatus = (language) => {
    const active = languageNames(language);
    const selected = languageNames(select.value);
    return `Downloading ${active.en} continues; ${selected.en} is selected next / ` +
      `正在继续下载${active.zh}；接下来选择${selected.zh}`;
  };
  const setDownloading = (value, language = null) => {
    downloading = value;
    activeLanguage = value ? (language ?? activeLanguage ?? select.value) : null;
    button.textContent = value ? "Pause / 暂停" : "Download or resume / 下载或继续";
    button.setAttribute("aria-pressed", String(value));
  };
  const worker = async () => {
    const registration = await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller || registration.active || registration.waiting;
  };
  const send = async (message) => {
    const target = await worker();
    if (!target) throw new Error("Offline worker is not ready");
    target.postMessage(message);
  };
  const requestStatus = () => {
    void send({ type: "OFFLINE_STATUS", language: select.value }).catch(() => {
      setStatus("Offline controls unavailable / 离线控制暂不可用");
    });
  };
  const startDownload = (language) => {
    resumeLanguage = language;
    setDownloading(true, language);
    return send({ type: "OFFLINE_DOWNLOAD", language }).catch((error) => {
      if (activeLanguage !== language) return;
      resumeLanguage = null;
      setDownloading(false);
      const names = languageNames(language);
      setStatus(`Could not start ${names.en}: ${error.message} / 无法开始下载${names.zh}`);
    });
  };
  const pauseDownload = () => {
    const language = activeLanguage;
    resumeLanguage = null;
    return send({ type: "OFFLINE_PAUSE" }).catch(() => {
      if (activeLanguage !== language) return;
      setDownloading(false);
      setStatus("Could not pause download; controls reset / 无法暂停下载，控制已重置");
    });
  };

  const pageLanguage = document.documentElement.getAttribute("data-page-lang") ||
    document.documentElement.lang || "en";
  const preferred = languages.some(([code]) => code === pageLanguage) ? pageLanguage : "en";
  select.value = preferred;
  setStatus(idleLabel());
  select.addEventListener("change", () => {
    if (downloading && activeLanguage) {
      setStatus(switchedDownloadStatus(activeLanguage));
      return;
    }
    setStatus(idleLabel());
    requestStatus();
  });
  button.addEventListener("click", () => {
    if (downloading) {
      void pauseDownload();
    } else {
      void startDownload(select.value);
    }
  });

  navigator.serviceWorker.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (typeof message.build === "string") workerBuild = message.build;
    const activeMessage = activeLanguage !== null && message.language === activeLanguage;
    if (message.type === "OFFLINE_PROGRESS" && activeMessage) {
      const active = languageNames(message.language);
      const selected = languageNames(select.value);
      setDownloading(true, message.language);
      const counts = `${message.completed}/${message.total}`;
      const bytes = `${humanBytes(message.bytes)}/${humanBytes(message.totalBytes)}`;
      setStatus(message.language === select.value
        ? `Downloading ${active.en}: ${counts} files, ${bytes} / 正在下载${active.zh}：${counts} 个文件`
        : `Downloading ${active.en}: ${counts} files, ${bytes}; ${selected.en} is selected next / ` +
          `正在下载${active.zh}：${counts} 个文件；接下来选择${selected.zh}`);
    } else if (message.type === "OFFLINE_COMPLETE" && activeMessage) {
      const completed = languageNames(message.language);
      const selected = languageNames(select.value);
      resumeLanguage = null;
      setDownloading(false);
      setStatus(message.language === select.value
        ? `Ready offline for ${completed.en} (${humanBytes(message.totalBytes)}) / ${completed.zh}已可离线游玩`
        : `${completed.en} is ready offline; ${selected.en} is selected / ` +
          `${completed.zh}已可离线游玩；当前选择${selected.zh}`);
    } else if (message.type === "OFFLINE_PAUSED" && activeMessage) {
      const paused = languageNames(message.language);
      const selected = languageNames(select.value);
      setDownloading(false);
      setStatus(message.language === select.value
        ? `${paused.en} paused at ${message.completed}/${message.total}; press to resume / ${paused.zh}下载已暂停，可继续`
        : `${paused.en} paused; ${selected.en} is selected / ${paused.zh}下载已暂停；当前选择${selected.zh}`);
    } else if (message.type === "OFFLINE_ERROR" && activeMessage) {
      const interrupted = languageNames(message.language);
      setDownloading(false);
      setStatus(`${interrupted.en} download interrupted; reconnect to resume / ` +
        `${interrupted.zh}下载已中断，联网后将继续`);
    } else if (message.type === "OFFLINE_STATUS" && message.language === select.value && !downloading) {
      setStatus(message.complete
        ? `Ready offline (${humanBytes(message.totalBytes)}) / 已可离线游玩`
        : `${message.completed}/${message.total} files cached; ${humanBytes(message.totalBytes)} total / ` +
          `已缓存 ${message.completed}/${message.total} 个文件，总计 ${humanBytes(message.totalBytes)}`);
    } else if (message.type === "OFFLINE_ERROR" && message.language === select.value && !downloading) {
      setStatus("Could not check offline content / 无法检查离线内容");
    }
  });

  missingRetry.addEventListener("click", () => {
    const failure = mapLoadFailure;
    if (!failure) return;
    missingRetry.disabled = true;
    void failure.retry();
  });
  const returnToCachedGame = () => {
    const url = new URL(location.href);
    for (const key of ["chapter", "map", "x", "y", "autoplay", "speed"]) url.searchParams.delete(key);
    url.searchParams.set("lang", select.value);
    try { localStorage.setItem("pocket-tuxemon/lang", select.value); } catch {}
    location.replace(url.pathname + (url.searchParams.size ? `?${url.searchParams}` : ""));
  };
  missingReturn.addEventListener("click", () => {
    if (!mapLoadFailure) return;
    mapLoadFailure = null;
    missing.hidden = true;
    returnToCachedGame();
  });
  window.addEventListener("online", () => {
    missingRetry.disabled = false;
    if (resumeLanguage && !downloading) {
      void startDownload(resumeLanguage);
    }
  });
  window.addEventListener("offline", () => {
    missingRetry.disabled = true;
  });
  window.addEventListener("pagehide", () => {
    if (mapPrepareTimer !== null) clearTimeout(mapPrepareTimer);
    mapPrepareTimer = null;
    if (mapPrepareRecoveryState === "waiting") mapPrepareRecoveryState = "cancelled";
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    install.hidden = false;
  });
  install.addEventListener("click", async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    installPrompt = null;
    install.hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    install.hidden = true;
  });

  const showWaiting = (registration) => {
    update.hidden = !registration.waiting;
    if (registration.waiting) setStatus("Update ready; reload when convenient / 更新已就绪，可随时重载");
  };
  update.addEventListener("click", async () => {
    const registration = await navigator.serviceWorker.ready;
    registration.waiting?.postMessage({ type: "ACTIVATE_UPDATE" });
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload());

  navigator.serviceWorker.register("./service-worker.js", {
    scope: "./",
    updateViaCache: "none",
  }).then((registration) => {
    showWaiting(registration);
    registration.addEventListener("updatefound", () => {
      registration.installing?.addEventListener("statechange", () => showWaiting(registration));
    });
    requestStatus();
  }).catch(() => {
    button.disabled = true;
    setStatus("Offline installation unavailable / 无法启用离线安装");
  });

  globalThis.__pocketPwa = {
    build: config.build,
    download(language = select.value) {
      select.value = language;
      return startDownload(language);
    },
    pause() {
      return pauseDownload();
    },
    showMapLoadFailure(failure) {
      if (!failure || typeof failure.retry !== "function") return;
      showMapLoadFailure(failure);
    },
    status: requestStatus,
    view() {
      return {
        build: config.build,
        workerBuild,
        language: select.value,
        downloading,
        activeLanguage,
        resumeLanguage,
        status: status.textContent,
        missing: !missing.hidden,
        missingMap: mapLoadFailure?.mapId ?? null,
        missingEntry: mapLoadFailure?.entry ?? null,
        mapPrepareWrapped: !!chunks?.__pocketPwaMapPrepare,
        mapPrepareAttempts,
        mapPreparePolls,
        mapPrepareRecoveryState,
        lastMapPrepareEntry,
      };
    },
  };
}
