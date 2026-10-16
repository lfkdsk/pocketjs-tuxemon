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
  let resumeLanguage = null;
  let installPrompt = null;
  let mapLoadFailure = null;
  let workerBuild = null;

  const humanBytes = (bytes) => {
    const mib = bytes / (1024 * 1024);
    return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
  };
  const idleLabel = () => "Checking offline content… / 正在检查离线内容…";
  const setStatus = (text) => {
    status.textContent = text;
  };
  const setDownloading = (value) => {
    downloading = value;
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

  const pageLanguage = document.documentElement.getAttribute("data-page-lang") ||
    document.documentElement.lang || "en";
  const preferred = languages.some(([code]) => code === pageLanguage) ? pageLanguage : "en";
  select.value = preferred;
  setStatus(idleLabel());
  select.addEventListener("change", () => {
    if (!downloading) setStatus(idleLabel());
    requestStatus();
  });
  button.addEventListener("click", () => {
    if (downloading) {
      resumeLanguage = null;
      void send({ type: "OFFLINE_PAUSE" });
    } else {
      resumeLanguage = select.value;
      setDownloading(true);
      void send({ type: "OFFLINE_DOWNLOAD", language: select.value }).catch((error) => {
        setDownloading(false);
        setStatus(`Download could not start: ${error.message} / 无法开始下载`);
      });
    }
  });

  navigator.serviceWorker.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (typeof message.build === "string") workerBuild = message.build;
    if (message.type === "OFFLINE_PROGRESS" && message.language === select.value) {
      setDownloading(true);
      setStatus(
        `${message.completed}/${message.total} files, ${humanBytes(message.bytes)}/${humanBytes(message.totalBytes)}` +
        ` / ${message.completed}/${message.total} 个文件`,
      );
    } else if (message.type === "OFFLINE_COMPLETE" && message.language === select.value) {
      resumeLanguage = null;
      setDownloading(false);
      setStatus(`Ready offline (${humanBytes(message.totalBytes)}) / 已可离线游玩`);
    } else if (message.type === "OFFLINE_PAUSED" && message.language === select.value) {
      setDownloading(false);
      setStatus(`Paused at ${message.completed}/${message.total}; press to resume / 已暂停，可继续`);
    } else if (message.type === "OFFLINE_ERROR" && message.language === select.value) {
      setDownloading(false);
      setStatus(`Download interrupted; reconnect to resume / 下载已中断，联网后可继续`);
    } else if (message.type === "OFFLINE_STATUS" && message.language === select.value) {
      setStatus(message.complete
        ? `Ready offline (${humanBytes(message.totalBytes)}) / 已可离线游玩`
        : `${message.completed}/${message.total} files cached; ${humanBytes(message.totalBytes)} total / ` +
          `已缓存 ${message.completed}/${message.total} 个文件，总计 ${humanBytes(message.totalBytes)}`);
    } else if (message.type === "OFFLINE_CHUNK_MISSING") {
      if (!mapLoadFailure) {
        missingText.textContent = navigator.onLine
          ? "This area is not available yet. Try again after the download completes. / 此区域尚未下载，请稍后重试。"
          : "This area has not been downloaded for offline play. Reconnect to retry, or return to cached content. / 此区域尚未下载，联网后可重试，或返回已缓存内容。";
      }
      missing.hidden = false;
      missingRetry.disabled = !navigator.onLine;
    }
  });

  missingRetry.addEventListener("click", () => {
    if (mapLoadFailure) {
      const failure = mapLoadFailure;
      mapLoadFailure = null;
      missing.hidden = true;
      failure.retry();
      return;
    }
    location.reload();
  });
  const returnToCachedGame = () => {
    const url = new URL(location.href);
    for (const key of ["chapter", "map", "x", "y", "autoplay", "speed"]) url.searchParams.delete(key);
    url.searchParams.set("lang", select.value);
    try { localStorage.setItem("pocket-tuxemon/lang", select.value); } catch {}
    location.replace(url.pathname + (url.searchParams.size ? `?${url.searchParams}` : ""));
  };
  missingReturn.addEventListener("click", () => {
    if (mapLoadFailure) {
      const failure = mapLoadFailure;
      mapLoadFailure = null;
      missing.hidden = true;
      failure.cancel();
      returnToCachedGame();
      return;
    }
    returnToCachedGame();
  });
  window.addEventListener("online", () => {
    missingRetry.disabled = false;
    if (resumeLanguage) {
      setDownloading(true);
      void send({ type: "OFFLINE_DOWNLOAD", language: resumeLanguage });
    }
  });
  window.addEventListener("offline", () => {
    missingRetry.disabled = true;
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
      resumeLanguage = language;
      setDownloading(true);
      return send({ type: "OFFLINE_DOWNLOAD", language });
    },
    pause() {
      resumeLanguage = null;
      return send({ type: "OFFLINE_PAUSE" });
    },
    showMapLoadFailure(failure) {
      if (!failure || typeof failure.retry !== "function" || typeof failure.cancel !== "function") return;
      mapLoadFailure = failure;
      missingText.textContent = navigator.onLine
        ? `Could not load ${failure.mapId}. Retry now, or stay on this map. / 无法加载 ${failure.mapId}，可重试或留在当前地图。`
        : `The content for ${failure.mapId} is not cached. Reconnect to retry, or stay on this map. / ${failure.mapId} 尚未缓存，联网后可重试，或留在当前地图。`;
      missing.hidden = false;
      missingRetry.disabled = !navigator.onLine;
    },
    status: requestStatus,
    view() {
      return {
        build: config.build,
        workerBuild,
        language: select.value,
        downloading,
        status: status.textContent,
        missing: !missing.hidden,
      };
    },
  };
}
