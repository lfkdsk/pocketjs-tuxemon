// Browser-only controls for install and explicit per-language offline packs.
// The build hashes this file and injects its configuration into the game page.

const configNode = document.getElementById("pocket-pwa");
const config = configNode ? JSON.parse(configNode.textContent || "null") : null;

if (config && "serviceWorker" in navigator) {
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

  const humanBytes = (bytes) => {
    const mib = bytes / (1024 * 1024);
    return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
  };
  const selectedPackage = () => config.packages[select.value];
  const idleLabel = () => {
    const pack = selectedPackage();
    return pack
      ? `${pack.label}: ${humanBytes(pack.bytes)} / ${pack.labelZh}：${humanBytes(pack.bytes)}`
      : "Offline package unavailable / 离线包不可用";
  };
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
  const preferred = pageLanguage in config.packages ? pageLanguage : "en";
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
      missingText.textContent = navigator.onLine
        ? "This area is not available yet. Try again after the download completes. / 此区域尚未下载，请稍后重试。"
        : "This area has not been downloaded for offline play. Reconnect to retry, or return to cached content. / 此区域尚未下载，联网后可重试，或返回已缓存内容。";
      missing.hidden = false;
      missingRetry.disabled = !navigator.onLine;
    }
  });

  missingRetry.addEventListener("click", () => location.reload());
  missingReturn.addEventListener("click", () => {
    const url = new URL(location.href);
    for (const key of ["chapter", "map", "x", "y", "autoplay", "speed"]) url.searchParams.delete(key);
    location.replace(url.pathname + (url.searchParams.size ? `?${url.searchParams}` : ""));
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
    status: requestStatus,
    view() {
      return {
        build: config.build,
        language: select.value,
        downloading,
        status: status.textContent,
        missing: !missing.hidden,
      };
    },
  };
}
