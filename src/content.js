// Content script: a "download video" button on the watch page and in the Shorts action bar.
// The background worker does the download; this file only renders its state.
(() => {
  const BTN = "ytvid-btn";

  // Outline icons in YouTube's style: download arrow, stop (cancel), check, alert.
  const svg = (d) =>
    `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
  const ICON = svg("M12 2a1 1 0 00-1 1v11.586l-4.293-4.293a1 1 0 10-1.414 1.414L12 18.414l6.707-6.707a1 1 0 10-1.414-1.414L13 14.586V3a1 1 0 00-1-1ZM4 20a1 1 0 100 2h16a1 1 0 100-2H4Z");
  const STOP = svg("M7 6h10a1 1 0 011 1v10a1 1 0 01-1 1H7a1 1 0 01-1-1V7a1 1 0 011-1Zm1 2v8h8V8H8Z");
  const CHECK = svg("M19.793 5.793 8.5 17.086l-4.293-4.293a1 1 0 10-1.414 1.414L8.5 19.914 21.207 7.207a1 1 0 10-1.414-1.414Z");
  const ERROR = svg("M10.68 1.844 1.017 19.79a1.5 1.5 0 001.32 2.211h19.326a1.5 1.5 0 001.32-2.21L13.32 1.843c-.566-1.052-2.074-1.052-2.64 0ZM3.174 20 12 3.61 20.826 20H3.174ZM12 8a1 1 0 00-1 1v4.5a1 1 0 002 0V9a1 1 0 00-1-1Zm0 7.75a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5Z");
  const RING = `<svg class="ytvid-ring" viewBox="0 0 40 40" aria-hidden="true"><circle class="track" cx="20" cy="20" r="18.5"/><circle class="bar" cx="20" cy="20" r="18.5" pathLength="100"/></svg>`;

  const ID_RE = /^[\w-]{11}$/;
  const PHASE = { starting: "Starting", video: "Downloading video", audio: "Downloading audio", merging: "Merging" };

  function render(btn, job = { state: "idle" }) {
    const state = job.state || "idle";
    btn.dataset.state = state;
    btn.style.setProperty("--p", state === "busy" ? job.percent || 0 : 0);
    const icon = btn.querySelector(".ytvid-icon");
    const hoverIcon = btn.querySelector(".ytvid-icon-hover");
    icon.innerHTML = state === "done" ? CHECK : state === "error" ? ERROR : ICON;
    hoverIcon.innerHTML = state === "busy" ? STOP : "";

    const q = job.quality ? ` · ${job.quality}` : "";
    const label =
      state === "busy"
        ? `${PHASE[job.phase] || "Downloading"} ${job.percent || 0}%${q} — click to cancel`
        : state === "done"
          ? `Saved to Downloads${q} — click to show in Finder`
          : state === "error"
            ? `Download failed: ${job.error || "unknown error"}`
            : "Download video";
    btn.title = label;
    btn.setAttribute("aria-label", label);

    clearTimeout(btn._reset);
    if (state === "error") btn._reset = setTimeout(() => render(btn), 5000);
  }

  async function send(type, videoId) {
    try {
      return await chrome.runtime.sendMessage({ type, videoId });
    } catch (e) {
      // Extension reloaded while the page stayed open.
      return { state: "error", error: "Extension was updated. Reload the page." };
    }
  }

  async function onClick(btn, videoId) {
    if (!ID_RE.test(videoId || "")) return render(btn, { state: "error", error: "No video found" });
    btn.dataset.videoId = videoId;
    const state = btn.dataset.state;
    if (state === "busy") return render(btn, await send("ytVideo:cancel", videoId));
    if (state === "done") {
      const res = await send("ytVideo:reveal", videoId);
      if (res?.ok) return;
      // File moved or deleted: allow downloading again.
      return render(btn, { state: "idle" });
    }
    render(btn, { state: "busy", percent: 0, phase: "starting" });
    render(btn, await send("ytVideo:start", videoId));
  }

  async function syncButton(btn, videoId) {
    if (!videoId || btn.dataset.videoId === videoId) return;
    btn.dataset.videoId = videoId;
    render(btn);
    const job = await send("ytVideo:status", videoId);
    if (btn.dataset.videoId === videoId) render(btn, job);
  }

  function makeButton(getVideoId, extraClass = "") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `${BTN} ${extraClass}`.trim();
    btn.innerHTML = `${RING}<span class="ytvid-icon"></span><span class="ytvid-icon-hover"></span>`;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(btn, getVideoId());
    });
    render(btn);
    return btn;
  }

  // Updates pushed by the background worker while a download runs.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "ytVideo:update") return;
    document.querySelectorAll(`.${BTN}`).forEach((btn) => {
      if (btn.dataset.videoId === msg.videoId) render(btn, msg.job);
    });
  });

  // ---- Watch page: icon button at the end of the action row (Like / Share / Save …) ----
  const currentWatchId = () =>
    location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null;

  let watchBtn = null;

  function ensureWatchButton() {
    const id = currentWatchId();
    if (!id) return;
    const menu = document.querySelector("ytd-watch-metadata #actions ytd-menu-renderer");
    if (!menu) return;
    // Same container logic as the thumbnail extension, so both buttons sit side by side.
    const flexible = menu.querySelector(":scope > #flexible-item-buttons");
    const topLevel = menu.querySelector(":scope > #top-level-buttons-computed");
    const hasFlexibleItems =
      flexible &&
      [...flexible.children].some(
        (c) => c !== watchBtn && !c.matches(".ytthumb-watch-btn") && c.getBoundingClientRect().width > 0
      );
    const target = hasFlexibleItems ? flexible : topLevel;
    if (!target) return;
    watchBtn ||= makeButton(currentWatchId, "ytvid-watch-btn");
    menu.querySelectorAll(`.ytvid-watch-btn`).forEach((b) => b !== watchBtn && b.remove());
    // Go last, but stay before the thumbnail button if that extension is installed too
    // (it always moves itself to the end; competing for the last slot would loop forever).
    const thumbBtn = target.querySelector(":scope > .ytthumb-watch-btn");
    if (thumbBtn) {
      if (watchBtn.parentElement !== target || watchBtn.nextElementSibling !== thumbBtn)
        target.insertBefore(watchBtn, thumbBtn);
    } else if (target.lastElementChild !== watchBtn) {
      target.appendChild(watchBtn);
    }
    syncButton(watchBtn, id);
  }

  // ---- Shorts: button in the vertical action bar of every reel ----
  const currentShortsId = () => location.pathname.match(/^\/shorts\/([\w-]{11})/)?.[1] || null;

  function ensureShortsButtons() {
    const id = currentShortsId();
    if (!id) return;
    document.querySelectorAll("ytd-shorts reel-action-bar-view-model").forEach((bar) => {
      let btn = bar.querySelector(":scope > .ytvid-shorts-action > .ytvid-btn");
      if (!btn) {
        const wrap = document.createElement("div");
        wrap.className = "ytvid-shorts-action";
        btn = makeButton(currentShortsId, "ytvid-watch-btn ytvid-shorts-btn");
        wrap.append(btn);
        bar.prepend(wrap);
      }
    });
    // The reel in view owns the URL; show its download state on that reel's button.
    let best = null;
    let bestVisible = 0;
    document.querySelectorAll(".ytvid-shorts-btn").forEach((btn) => {
      const r = btn.closest("reel-action-bar-view-model")?.getBoundingClientRect();
      const visible = r ? Math.min(r.bottom, innerHeight) - Math.max(r.top, 0) : 0;
      if (visible > bestVisible) [best, bestVisible] = [btn, visible];
    });
    if (best) syncButton(best, id);
  }

  // ---- Scan loop ----
  let scheduled = false;
  function scan() {
    scheduled = false;
    ensureWatchButton();
    ensureShortsButtons();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(scan);
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("yt-navigate-finish", schedule);
  scan();
})();
