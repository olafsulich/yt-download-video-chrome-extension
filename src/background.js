// Service worker: owns download jobs and talks to the native host (yt-dlp + ffmpeg).
// Jobs live here, not in the page, so a download survives YouTube's in-app navigation and
// the button shows the right state when you come back to the video.

const HOST = "com.ytvideo.downloader";
const ID_RE = /^[\w-]{11}$/;

/** videoId -> { state: "busy"|"done"|"error", percent, phase, quality, title, path, name, error, port, tabs } */
const jobs = new Map();

function publicJob(job) {
  if (!job) return { state: "idle" };
  const { port, tabs, ...rest } = job;
  return rest;
}

function broadcast(videoId) {
  const job = jobs.get(videoId);
  if (!job) return;
  const msg = { type: "ytVideo:update", videoId, job: publicJob(job) };
  for (const tabId of job.tabs) chrome.tabs.sendMessage(tabId, msg).catch(() => job.tabs.delete(tabId));
}

function hostError(raw) {
  const s = String(raw || "");
  if (/native messaging host not found|forbidden/i.test(s))
    return "Helper not installed. Run ./install.sh in the extension folder, then reload the extension.";
  return s.replace(/^ERROR:\s*(\[[^\]]+\]\s*[\w-]+:\s*)?/, "") || "Download failed";
}

function start(videoId, tabId) {
  const existing = jobs.get(videoId);
  if (existing?.state === "busy") {
    if (tabId != null) existing.tabs.add(tabId);
    return publicJob(existing);
  }

  const job = { state: "busy", percent: 0, phase: "starting", tabs: new Set(tabId != null ? [tabId] : []) };
  jobs.set(videoId, job);

  const port = chrome.runtime.connectNative(HOST);
  job.port = port;

  port.onMessage.addListener((m) => {
    if (m.type === "info") {
      job.title = m.title;
      // "1080p" names the short side, so vertical Shorts (1080x1920) read as 1080p too.
      const h = Math.min(...[m.height, m.width].map((v) => parseInt(v, 10)).filter((v) => v > 0));
      const fps = Math.round(parseFloat(m.fps));
      if (Number.isFinite(h)) job.quality = `${h}p${fps > 30 ? fps : ""}`;
    } else if (m.type === "progress") {
      job.percent = m.percent;
      job.phase = m.phase;
    } else if (m.type === "done") {
      Object.assign(job, { state: "done", percent: 100, phase: "done", path: m.path, name: m.name });
      job.port = null;
      port.disconnect();
    } else if (m.type === "error") {
      Object.assign(job, { state: "error", error: hostError(m.error) });
      job.port = null;
      port.disconnect();
    }
    broadcast(videoId);
    if (job.state === "error") jobs.delete(videoId);
  });

  port.onDisconnect.addListener(() => {
    if (job.state !== "busy" || jobs.get(videoId) !== job) return;
    Object.assign(job, { state: "error", error: hostError(chrome.runtime.lastError?.message || "Helper stopped") });
    job.port = null;
    broadcast(videoId);
    jobs.delete(videoId);
  });

  port.postMessage({ type: "download", videoId });
  return publicJob(job);
}

function cancel(videoId) {
  const job = jobs.get(videoId);
  if (job?.state !== "busy") return;
  jobs.delete(videoId);
  job.port?.disconnect(); // host sees stdin close and stops yt-dlp
  for (const tabId of job.tabs)
    chrome.tabs.sendMessage(tabId, { type: "ytVideo:update", videoId, job: { state: "idle" } }).catch(() => {});
}

function reveal(path) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, { type: "reveal", path }, (res) => {
      resolve(res?.type === "revealed" ? { ok: true } : { ok: false, error: res?.error || chrome.runtime.lastError?.message });
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const { videoId } = msg || {};
  if (msg?.type?.startsWith("ytVideo:") && !ID_RE.test(videoId || "")) {
    sendResponse({ state: "error", error: "Invalid video id" });
    return;
  }
  switch (msg?.type) {
    case "ytVideo:start":
      sendResponse(start(videoId, tabId));
      return;
    case "ytVideo:cancel":
      cancel(videoId);
      sendResponse({ state: "idle" });
      return;
    case "ytVideo:status": {
      const job = jobs.get(videoId);
      if (job && tabId != null) job.tabs.add(tabId);
      sendResponse(publicJob(job));
      return;
    }
    case "ytVideo:reveal":
      reveal(jobs.get(videoId)?.path).then(sendResponse);
      return true; // async
  }
});
