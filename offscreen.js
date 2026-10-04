/**
 * MP3へのID3タグ・カバーアート埋め込み、商品ごとのZIP化（offscreen document）
 *
 * Service Worker では URL.createObjectURL が使えないため、
 * fetch → タグ書き込み（→ ZIP化）→ Blob URL 化をここで行い、URLを background に返す。
 */

import { ID3Writer } from "./lib/browser-id3-writer.mjs";
import { downloadZip } from "./lib/client-zip.mjs";

const COVER_MAX = 1000;

// 画像をJPEGに正規化（WebP等はID3非対応プレイヤーが多いため）
async function fetchCoverJpeg(urls) {
  for (const url of urls) {
    if (!url) continue;
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const bitmap = await createImageBitmap(await resp.blob());
      const scale = Math.min(1, COVER_MAX / Math.max(bitmap.width, bitmap.height));
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
      return await jpeg.arrayBuffer();
    } catch (e) {
      console.warn("[holoshop-shelf] カバー取得失敗:", url, e);
    }
  }
  return null;
}

async function buildTaggedMp3(url, tags, cover) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`音声取得失敗: ${resp.status}`);
  const song = await resp.arrayBuffer();

  const writer = new ID3Writer(song);
  if (tags.title) writer.setFrame("TIT2", tags.title);
  if (tags.album) writer.setFrame("TALB", tags.album);
  if (tags.artist) {
    writer.setFrame("TPE1", [tags.artist]);
    writer.setFrame("TPE2", tags.artist);
  }
  if (tags.track) writer.setFrame("TRCK", `${tags.track}/${tags.trackTotal}`);
  if (tags.year) writer.setFrame("TYER", tags.year);
  if (cover) {
    // ArrayBuffer は書き込み時にコピーされるので、ZIP内の複数トラックで使い回して問題ない
    writer.setFrame("APIC", { type: 3, data: cover, description: "" });
  }

  writer.addTag();
  return writer.getBlob();
}

async function tagMp3(job) {
  const cover = await fetchCoverJpeg(job.coverUrls || []);
  const blob = await buildTaggedMp3(job.url, job.tags, cover);
  return URL.createObjectURL(blob);
}

// 商品内のMP3をすべてタグ付けして1つのZIPにまとめる（音声は圧縮が効かないため無圧縮格納）
async function zipMp3s(job, onProgress) {
  const cover = await fetchCoverJpeg(job.coverUrls || []);
  const files = [];
  for (let i = 0; i < job.entries.length; i++) {
    const entry = job.entries[i];
    onProgress(i, job.entries.length);
    const blob = await buildTaggedMp3(entry.url, entry.tags, cover);
    files.push({ name: entry.name, input: blob, lastModified: new Date() });
  }
  onProgress(job.entries.length, job.entries.length);
  const zip = await downloadZip(files).blob();
  return URL.createObjectURL(zip);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;

  if (msg.type === "tag") {
    tagMp3(msg.job)
      .then((blobUrl) => sendResponse({ blobUrl }))
      .catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }

  if (msg.type === "zip") {
    const onProgress = (done, total) =>
      chrome.runtime
        .sendMessage({ type: "hlo-zip-progress", tabId: msg.tabId, done, total })
        .catch(() => {});
    zipMp3s(msg.job, onProgress)
      .then((blobUrl) => sendResponse({ blobUrl }))
      .catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }

  if (msg.type === "revoke") {
    URL.revokeObjectURL(msg.blobUrl);
  }
});
