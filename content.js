/**
 * ホロライブショップ デジタルコンテンツライブラリー整理拡張
 *
 * 初回: ページネーション走査で全アイテム取得 → Shopify商品APIで販売日取得 → キャッシュ
 * 2回目以降: キャッシュから即時表示、再読み込みボタンで差分追加
 */

(async () => {
  const container = document.querySelector(".sky-pilot-files-list");
  if (!container) return;

  const CACHE_KEY = "hlo_items_cache";
  const CACHE_TS_KEY = "hlo_items_cache_ts";
  const NAV_STATE_KEY = "hlo_nav_state";

  // --- ユーティリティ ---

  function parseHeading(text) {
    const dashIdx = text.indexOf(" - ");
    let event = text;
    let category = "";
    let member = "";

    if (dashIdx !== -1) {
      event = text.substring(0, dashIdx).trim();
      const rest = text.substring(dashIdx + 3).trim();
      const slashIdx = rest.indexOf(" / ");
      if (slashIdx !== -1) {
        category = rest.substring(0, slashIdx).trim();
        member = rest.substring(slashIdx + 3).trim();
      } else {
        category = rest;
      }
    }

    const memberClean = member
      .replace(/[（(][^）)]*[）)]/g, "")
      .replace(/「[^」]*」/g, "")
      .replace(/フルセット\S*/g, "")
      .replace(/数量限定\S*/g, "")
      .trim();
    const yearMatch = event.match(/(20\d{2})/);
    const year = yearMatch ? parseInt(yearMatch[1]) : null;

    return { event, category, member, memberClean, year };
  }

  function parseItems(doc) {
    const items = doc.querySelectorAll(".sky-pilot-list-item");
    return Array.from(items).map((el) => {
      const heading = el.querySelector(".sky-pilot-file-heading");
      const img = el.querySelector("img");
      const href = el.getAttribute("href") || "";
      const parsed = parseHeading(heading ? heading.textContent.trim() : "");
      return {
        ...parsed,
        thumb: img ? img.getAttribute("src") || "" : "",
        href,
        fullText: heading ? heading.textContent.trim() : "",
      };
    });
  }

  function getNextPageUrl(doc) {
    const nextLink = doc.querySelector(".sky-pilot-pagination .next a");
    if (!nextLink) return null;
    const url = nextLink.getAttribute("href");
    if (!url) return null;
    return url.startsWith("http") ? url : window.location.origin + url;
  }

  // --- データ取得 ---

  async function fetchAllItems(onProgress) {
    let allItems = parseItems(document);
    let pageNum = 1;
    if (onProgress) onProgress(pageNum, allItems.length);

    let nextUrl = getNextPageUrl(document);
    const visited = new Set();

    while (nextUrl && !visited.has(nextUrl)) {
      visited.add(nextUrl);
      pageNum++;
      try {
        const resp = await fetch(nextUrl, { credentials: "include" });
        if (!resp.ok) break;
        const html = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        const pageItems = parseItems(doc);
        if (pageItems.length === 0) break;
        allItems = allItems.concat(pageItems);
        if (onProgress) onProgress(pageNum, allItems.length);
        nextUrl = getNextPageUrl(doc);
      } catch {
        break;
      }
    }

    return allItems;
  }

  // 購入アイテムに該当する商品情報をまとめて取得
  // products.jsonをページ送りし、全イベント名が見つかったら停止
  async function fetchProductInfoBatch(eventNames, onProgress) {
    const remaining = new Set(eventNames);
    const infoMap = {};
    const allKnownMembers = new Set();
    let page = 1;
    const baseUrl = `${window.location.origin}/products.json`;

    while (remaining.size > 0) {
      if (onProgress) onProgress(page, eventNames.length - remaining.size, eventNames.length);
      try {
        const url = `${baseUrl}?limit=250&page=${page}`;
        const resp = await fetch(url);
        if (!resp.ok) break;
        const data = await resp.json();
        const products = data.products || [];
        if (products.length === 0) break;

        for (const p of products) {
          const tags = Array.isArray(p.tags)
            ? p.tags
            : (p.tags || "").split(", ");
          const members = tags
            .filter((t) => t.startsWith("Talent_"))
            .map((t) => t.replace("Talent_", ""));
          members.forEach((m) => allKnownMembers.add(m));

          if (remaining.has(p.title)) {
            infoMap[p.title] = {
              publishedAt: p.published_at || "",
              members,
            };
            remaining.delete(p.title);
          }
        }

        page++;
      } catch {
        break;
      }
    }
    return { infoMap, allKnownMembers: [...allKnownMembers] };
  }

  // --- キャッシュ操作 ---

  function loadCache() {
    try {
      const data = localStorage.getItem(CACHE_KEY);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  function saveCache(items) {
    localStorage.setItem(CACHE_KEY, JSON.stringify(items));
    localStorage.setItem(CACHE_TS_KEY, new Date().toISOString());
  }

  function getCacheTimestamp() {
    return localStorage.getItem(CACHE_TS_KEY) || "";
  }

  function mergeItems(cached, fetched) {
    const map = new Map();
    for (const item of cached) map.set(item.href, item);
    let newCount = 0;
    for (const item of fetched) {
      if (!map.has(item.href)) newCount++;
      map.set(item.href, item);
    }
    return { merged: Array.from(map.values()), newCount };
  }

  // --- ナビゲーション状態の保存・復元 ---

  function saveNavState(state) {
    sessionStorage.setItem(NAV_STATE_KEY, JSON.stringify(state));
  }

  function loadAndClearNavState() {
    try {
      const data = sessionStorage.getItem(NAV_STATE_KEY);
      sessionStorage.removeItem(NAV_STATE_KEY);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  // --- 販売日の付与 ---

  async function enrichWithProductInfo(items, onProgress) {
    const uniqueEvents = [...new Set(items.map((i) => i.event))];
    const { infoMap, allKnownMembers } = await fetchProductInfoBatch(uniqueEvents, onProgress);

    // メンバー名を長い順にソート（部分一致の誤検出防止）
    const membersByLength = [...allKnownMembers].sort((a, b) => b.length - a.length);

    for (const item of items) {
      const info = infoMap[item.event];
      if (!info) continue;

      if (info.publishedAt) {
        const d = new Date(info.publishedAt);
        item.publishedAt = info.publishedAt;
        item.publishedDate = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
        if (!item.year) item.year = d.getFullYear();
      }

      // グローバルメンバーリストでfullTextを照合
      const matched = membersByLength.filter((m) => item.fullText.includes(m));
      if (matched.length > 0) {
        item.memberClean = matched.join("、");
        item.member = matched.join("、");
      } else if (info.members.length === 1) {
        item.memberClean = info.members[0];
        item.member = info.members[0];
      } else if (info.members.length > 1) {
        item.memberClean = info.members.join("、");
        item.member = info.members.join("、");
      }
    }
    return items;
  }

  // --- UI ---

  function createCard(item, onNavigate) {
    const a = document.createElement("a");
    a.className = "hlo-card";
    a.href = item.href;
    a.addEventListener("click", onNavigate);

    const img = document.createElement("img");
    img.className = "hlo-card-thumb";
    img.src = item.thumb;
    img.alt = item.event;
    img.loading = "lazy";
    a.appendChild(img);

    const body = document.createElement("div");
    body.className = "hlo-card-body";

    const eventEl = document.createElement("div");
    eventEl.className = "hlo-card-event";
    eventEl.textContent = item.event;
    body.appendChild(eventEl);

    const memberEl = document.createElement("div");
    memberEl.className = "hlo-card-member";
    memberEl.textContent = item.memberClean || item.member;
    body.appendChild(memberEl);

    if (item.publishedDate) {
      const dateEl = document.createElement("div");
      dateEl.className = "hlo-card-date";
      dateEl.textContent = item.publishedDate;
      body.appendChild(dateEl);
    } else if (item.year) {
      const yearEl = document.createElement("div");
      yearEl.className = "hlo-card-date";
      yearEl.textContent = String(item.year);
      body.appendChild(yearEl);
    }

    a.appendChild(body);
    return a;
  }

  function buildUI(allItems) {
    container.style.display = "none";
    const pagination = document.querySelector(".sky-pilot-pagination");
    if (pagination) pagination.style.display = "none";

    const old = document.getElementById("hlo-wrapper");
    if (old) old.remove();

    const wrapper = document.createElement("div");
    wrapper.id = "hlo-wrapper";

    // 戻る時の状態復元
    const savedState = loadAndClearNavState();

    // --- ツールバー ---
    const toolbar = document.createElement("div");
    toolbar.className = "hlo-toolbar";

    // メンバーフィルタ
    const memberFilter = document.createElement("select");
    memberFilter.className = "hlo-sort";
    const memberAll = document.createElement("option");
    memberAll.value = "";
    memberAll.textContent = "全メンバー";
    memberFilter.appendChild(memberAll);

    const members = [
      ...new Set(allItems.map((i) => i.memberClean).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b, "ja"));
    for (const m of members) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      memberFilter.appendChild(o);
    }
    if (savedState?.member) memberFilter.value = savedState.member;
    toolbar.appendChild(memberFilter);

    // 検索
    const search = document.createElement("input");
    search.className = "hlo-search";
    search.type = "text";
    search.placeholder = "検索（イベント名・メンバー名）";
    if (savedState?.search) search.value = savedState.search;
    toolbar.appendChild(search);

    // ソート（トグルボタン）
    let sortAsc = savedState?.sort === "date-asc";
    const sort = document.createElement("button");
    sort.className = "hlo-reload";
    sort.textContent = sortAsc ? "↑ 古い順" : "↓ 新しい順";
    sort.addEventListener("click", () => {
      sortAsc = !sortAsc;
      sort.textContent = sortAsc ? "↑ 古い順" : "↓ 新しい順";
      render();
    });
    toolbar.appendChild(sort);

    // 再読み込みボタン
    const reloadBtn = document.createElement("button");
    reloadBtn.className = "hlo-reload";
    reloadBtn.textContent = "↻ 再読み込み";
    reloadBtn.addEventListener("click", async () => {
      reloadBtn.disabled = true;
      reloadBtn.textContent = "読み込み中...";

      const fetched = await fetchAllItems((pg, n) => {
        reloadBtn.textContent = `アイテム ${pg}ページ目... (${n}件)`;
      });

      const enriched = await enrichWithProductInfo(fetched, (pg, found, total) => {
        reloadBtn.textContent = `商品情報取得中... ${found}/${total}件`;
      });

      const cached = loadCache() || [];
      const { merged, newCount } = mergeItems(cached, enriched);
      saveCache(merged);
      allItems = merged;

      reloadBtn.disabled = false;
      reloadBtn.textContent = "↻ 再読み込み";

      if (newCount > 0) {
        statusEl.textContent = `${newCount}件の新規コンテンツを追加`;
        statusEl.style.display = "";
        setTimeout(() => (statusEl.style.display = "none"), 3000);
      }

      const ts = getCacheTimestamp();
      if (ts) {
        const d = new Date(ts);
        tsEl.textContent = `最終取得: ${d.toLocaleDateString("ja-JP")} ${d.toLocaleTimeString("ja-JP")}`;
      }

      // メンバーフィルタの選択肢を更新
      const currentMember = memberFilter.value;
      const newMembers = [
        ...new Set(allItems.map((i) => i.memberClean).filter(Boolean)),
      ].sort((a, b) => a.localeCompare(b, "ja"));
      memberFilter.innerHTML = "";
      const allOpt = document.createElement("option");
      allOpt.value = "";
      allOpt.textContent = "全メンバー";
      memberFilter.appendChild(allOpt);
      for (const m of newMembers) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m;
        memberFilter.appendChild(o);
      }
      memberFilter.value = currentMember;

      render();
    });
    toolbar.appendChild(reloadBtn);

    const count = document.createElement("span");
    count.className = "hlo-count";
    toolbar.appendChild(count);

    wrapper.appendChild(toolbar);

    const statusEl = document.createElement("div");
    statusEl.className = "hlo-status";
    statusEl.style.display = "none";
    wrapper.appendChild(statusEl);

    const tsEl = document.createElement("div");
    tsEl.className = "hlo-cache-ts";
    const ts = getCacheTimestamp();
    if (ts) {
      const d = new Date(ts);
      tsEl.textContent = `最終取得: ${d.toLocaleDateString("ja-JP")} ${d.toLocaleTimeString("ja-JP")}`;
    }
    wrapper.appendChild(tsEl);

    const grid = document.createElement("div");
    grid.className = "hlo-grid";
    wrapper.appendChild(grid);

    container.parentNode.insertBefore(wrapper, container);

    // カードクリック時に状態を保存
    function onCardNavigate() {
      saveNavState({
        member: memberFilter.value,
        search: search.value,
        sort: sortAsc ? "date-asc" : "date-desc",
      });
    }

    function render() {
      const memberVal = memberFilter.value;
      const query = search.value.toLowerCase();

      let filtered = allItems;

      if (memberVal) {
        filtered = filtered.filter((item) => item.memberClean.includes(memberVal));
      }

      if (query) {
        filtered = filtered.filter(
          (item) =>
            item.fullText.toLowerCase().includes(query) ||
            item.memberClean.toLowerCase().includes(query) ||
            item.event.toLowerCase().includes(query)
        );
      }

      if (sortAsc) {
        filtered.sort((a, b) => (a.publishedAt || "").localeCompare(b.publishedAt || ""));
      } else {
        filtered.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
      }

      grid.innerHTML = "";
      for (const item of filtered) {
        grid.appendChild(createCard(item, onCardNavigate));
      }

      count.textContent = `${filtered.length} / ${allItems.length} 件`;
    }

    memberFilter.addEventListener("change", render);
    search.addEventListener("input", render);

    render();
  }

  // --- メイン処理 ---

  const cached = loadCache();
  if (cached && cached.length > 0) {
    buildUI(cached);
    return;
  }

  container.style.display = "none";
  const pagination = document.querySelector(".sky-pilot-pagination");
  if (pagination) pagination.style.display = "none";

  const loadingEl = document.createElement("div");
  loadingEl.className = "hlo-loading";
  loadingEl.textContent = "全コンテンツを読み込み中...";
  container.parentNode.insertBefore(loadingEl, container);

  const allItems = await fetchAllItems((pg, n) => {
    loadingEl.textContent = `アイテム読み込み中... ${pg}ページ目 (${n}件)`;
  });

  loadingEl.textContent = "商品情報を取得中...";
  const enriched = await enrichWithProductInfo(allItems, (pg, found, total) => {
    loadingEl.textContent = `商品情報取得中... ${found}/${total}件`;
  });

  saveCache(enriched);
  loadingEl.remove();
  buildUI(enriched);
})();
