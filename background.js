/**
 * 一括ダウンロードのキュー管理
 *
 * content script から受け取ったジョブを同時実行数を絞って処理する。
 * MP3 は offscreen document でタグ・カバーを埋め込んでから保存、それ以外はそのまま保存。
 */

const CONCURRENCY = 2;

const queue = [];
let running = 0;

// tabId -> { total, done, failed }
const progress = new Map();

// --- offscreen document ---

let offscreenCreating = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "MP3へのID3タグ書き込みとBlob URL生成",
      })
      .finally(() => (offscreenCreating = null));
  }
  await offscreenCreating;
}

// --- ダウンロード完了待ち ---

// downloadId -> { resolve, blobUrl }
const pendingDownloads = new Map();

chrome.downloads.onChanged.addListener((delta) => {
  const pending = pendingDownloads.get(delta.id);
  if (!pending || !delta.state) return;
  const state = delta.state.current;
  if (state !== "complete" && state !== "interrupted") return;

  pendingDownloads.delete(delta.id);
  if (pending.blobUrl) {
    chrome.runtime
      .sendMessage({ target: "offscreen", type: "revoke", blobUrl: pending.blobUrl })
      .catch(() => {});
  }
  pending.resolve(state === "complete");
});

async function download(url, filename, blobUrl) {
  const id = await chrome.downloads.download({ url, filename, conflictAction: "uniquify" });
  return new Promise((resolve) => pendingDownloads.set(id, { resolve, blobUrl }));
}

// 大きいWAVのDL中など、イベントが途切れてもSWが停止しないよう拡張APIを定期的に叩く
let keepAliveTimer = null;

function updateKeepAlive() {
  const busy = running > 0 || queue.length > 0;
  if (busy && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  } else if (!busy && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// --- ジョブ処理 ---

async function runJob(job) {
  if (job.ext !== "mp3") return download(job.url, job.filename);

  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "tag", job });
  if (!res || res.error) throw new Error(res?.error || "タグ書き込み失敗");
  return download(res.blobUrl, job.filename, res.blobUrl);
}

function notify(tabId) {
  const p = progress.get(tabId);
  if (!p) return;
  const finished = p.done + p.failed >= p.total;
  chrome.tabs.sendMessage(tabId, { type: "hlo-progress", ...p, finished }).catch(() => {});
  if (finished) progress.delete(tabId);
}

function pump() {
  while (running < CONCURRENCY && queue.length > 0) {
    const { job, tabId } = queue.shift();
    running++;
    runJob(job)
      .then((ok) => {
        if (!ok) throw new Error("ダウンロード中断");
        progress.get(tabId).done++;
      })
      .catch((e) => {
        console.error("[holoshop-shelf] DL失敗:", job.filename, e);
        progress.get(tabId).failed++;
      })
      .finally(() => {
        running--;
        notify(tabId);
        pump();
      });
  }
  updateKeepAlive();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "hlo-download") return;
  const tabId = sender.tab?.id;
  if (tabId == null || !Array.isArray(msg.jobs) || msg.jobs.length === 0) {
    sendResponse({ accepted: false });
    return;
  }

  const p = progress.get(tabId) || { total: 0, done: 0, failed: 0 };
  p.total += msg.jobs.length;
  progress.set(tabId, p);
  for (const job of msg.jobs) queue.push({ job, tabId });

  sendResponse({ accepted: true });
  notify(tabId);
  pump();
});
