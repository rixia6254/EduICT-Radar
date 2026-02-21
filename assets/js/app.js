/**
 * 情報科 Teacher Radar — Main Application JS
 * GitHub Pages 対応 / 静的サイト版
 */

'use strict';

/* ===================================================================
   定数 & グローバル状態
=================================================================== */
const STORAGE_KEY_STARS   = 'tr_starred';
const STORAGE_KEY_CLIPS   = 'tr_clips';
const STORAGE_KEY_THEME   = 'tr_theme';
const ITEMS_PER_PAGE      = 12;
const PICKUP_COUNT        = 5;

/** アプリ状態 */
const state = {
  allItems:      [],   // items.json から読んだ全記事
  clips:         [],   // 手動クリップ
  starred:       new Set(),
  filtered:      [],   // フィルタ後
  displayed:     0,    // 表示済み件数
  // フィルタ状態
  currentTab:    'pickup',
  searchQuery:   '',
  period:        'all',
  sort:          'priority',
  selectedSources: new Set(),
  selectedTags:  new Set(),
};

/* ===================================================================
   ユーティリティ
=================================================================== */

/** localStorage から JSON を安全に取得 */
function loadLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

/** localStorage に JSON を安全に保存 */
function saveLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

/** ISO 文字列 → JST の相対・絶対表示 */
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const now = new Date();
  const diffMs  = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffH   = Math.floor(diffMs / 3600000);
  const diffD   = Math.floor(diffMs / 86400000);
  if (diffMin < 1)  return 'たった今';
  if (diffMin < 60) return `${diffMin}分前`;
  if (diffH < 24)   return `${diffH}時間前`;
  if (diffD < 7)    return `${diffD}日前`;
  return d.toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'short', day: 'numeric',
    timeZone: 'Asia/Tokyo'
  });
}

/** URL の UTM パラメータなどを除去して正規化 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content',
     'ref','source','from','via'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch { return url; }
}

/** 文字列を HTML エスケープ */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

/** XSS を防いだ DOM text 設定 */
function setText(el, text) { if (el) el.textContent = text; }

/** トースト通知 */
function toast(msg, type = 'info', duration = 3000) {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]}</span><span class="toast-msg">${esc(msg)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 350);
  }, duration);
}

/* ===================================================================
   データ読み込み
=================================================================== */
async function loadItems() {
  showState('loading');
  try {
    const res  = await fetch(`items.json?v=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    state.allItems = Array.isArray(json.items) ? json.items : [];
    // starred フラグを localStorage で上書き
    state.starred = new Set(loadLS(STORAGE_KEY_STARS, []));
    // starred フラグを記事に反映
    state.allItems.forEach(item => {
      item.starred = state.starred.has(item.id);
    });
    // クリップ
    state.clips = loadLS(STORAGE_KEY_CLIPS, []);
    // 更新日時表示
    const ts = json.generated_at;
    setText(document.getElementById('last-updated-text'),
      ts ? `更新: ${formatDate(ts)}` : '取得済み');
    return true;
  } catch (err) {
    console.error('[TeacherRadar] items.json 読み込み失敗:', err);
    document.getElementById('error-message').textContent =
      `items.json の読み込みに失敗しました: ${err.message}`;
    showState('error');
    return false;
  }
}

/* ===================================================================
   フィルタ & 並び替え
=================================================================== */

/** 現在の状態に基づいて filtered を更新 */
function applyFilters() {
  const now  = new Date();
  const q    = state.searchQuery.toLowerCase().trim();
  const tab  = state.currentTab;

  let items = [];

  // ---- クリップタブ ----
  if (tab === 'clips') {
    items = [...state.clips];
    if (q) {
      items = items.filter(c =>
        (c.title  || '').toLowerCase().includes(q) ||
        (c.memo   || '').toLowerCase().includes(q) ||
        (c.tags   || []).some(t => t.toLowerCase().includes(q))
      );
    }
    state.filtered = items;
    return;
  }

  // ---- 通常タブ ----
  items = [...state.allItems];

  // スタータブ
  if (tab === 'starred') {
    items = items.filter(i => state.starred.has(i.id));
  }
  // ピックアップ（ソーススコア上位）
  else if (tab === 'pickup') {
    // pickup は後段でも絞り込みを適用するが、期間は「7日以内」固定
    const cutoff = new Date(now - 7 * 86400000);
    items = items.filter(i => new Date(i.published_at) >= cutoff);
  }
  // 特定カテゴリタブ
  else if (tab !== 'all') {
    items = items.filter(i => i.category === tab);
  }

  // 期間フィルタ（pickup 以外）
  if (tab !== 'pickup' && state.period !== 'all') {
    const days = parseInt(state.period, 10);
    const cutoff = new Date(now - days * 86400000);
    items = items.filter(i => new Date(i.published_at) >= cutoff);
  }

  // ソースフィルタ
  if (state.selectedSources.size > 0) {
    items = items.filter(i => state.selectedSources.has(i.source_id));
  }

  // タグフィルタ（AND 検索）
  if (state.selectedTags.size > 0) {
    items = items.filter(i =>
      [...state.selectedTags].every(t => (i.tags || []).includes(t))
    );
  }

  // キーワード検索
  if (q) {
    items = items.filter(i =>
      (i.title   || '').toLowerCase().includes(q) ||
      (i.summary || '').toLowerCase().includes(q) ||
      (i.source_name || '').toLowerCase().includes(q) ||
      (i.tags    || []).some(t => t.toLowerCase().includes(q))
    );
  }

  // 並び替え
  if (state.sort === 'priority' || tab === 'pickup') {
    items.sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));
  } else {
    items.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  }

  // スター付きを上に（pickup 以外）
  if (tab !== 'pickup') {
    items.sort((a, b) => {
      const sa = state.starred.has(a.id) ? 1 : 0;
      const sb = state.starred.has(b.id) ? 1 : 0;
      return sb - sa;
    });
  }

  state.filtered = items;
}

/* ===================================================================
   レンダリング
=================================================================== */

function showState(name) {
  document.getElementById('state-loading').hidden = name !== 'loading';
  document.getElementById('state-error').hidden   = name !== 'error';
  document.getElementById('state-empty').hidden   = name !== 'empty';
  document.getElementById('article-grid').hidden  = name !== 'articles';
  document.getElementById('load-more-wrapper').hidden = true;
}

function renderAll() {
  applyFilters();
  updateTabCounts();
  updateStats();

  const grid = document.getElementById('article-grid');
  grid.innerHTML = '';
  state.displayed = 0;

  if (state.filtered.length === 0 && state.currentTab !== 'clips') {
    showState('empty');
    return;
  }
  if (state.currentTab === 'clips' && state.clips.length === 0) {
    showClipsEmpty(grid);
    return;
  }

  showState('articles');

  // ピックアップセクションヘッダー
  if (state.currentTab === 'pickup') {
    const header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = `
      <span>⭐</span>
      <h2>今日のピックアップ</h2>
      <span class="section-badge">PICK UP</span>
      <span style="font-size:.75rem;color:var(--clr-text-3);margin-left:auto">
        直近7日間・スコア上位
      </span>
    `;
    header.style.cssText = 'grid-column: 1/-1;';
    grid.appendChild(header);
  }

  const limit = state.currentTab === 'pickup'
    ? Math.min(PICKUP_COUNT, state.filtered.length)
    : ITEMS_PER_PAGE;

  const initial = state.currentTab === 'clips'
    ? state.clips
    : state.filtered.slice(0, limit);

  initial.forEach(item => {
    const card = state.currentTab === 'clips'
      ? buildClipCard(item)
      : buildArticleCard(item);
    grid.appendChild(card);
  });

  state.displayed = initial.length;

  // クリップタブは「もっと見る」なし
  if (state.currentTab === 'clips') return;

  const remaining = state.filtered.length - state.displayed;
  if (remaining > 0) {
    const wrapper = document.getElementById('load-more-wrapper');
    wrapper.hidden = false;
    setText(document.getElementById('load-more-remaining'), remaining);
  }
}

function loadMore() {
  const grid = document.getElementById('article-grid');
  const next = state.filtered.slice(state.displayed, state.displayed + ITEMS_PER_PAGE);
  next.forEach(item => grid.appendChild(buildArticleCard(item)));
  state.displayed += next.length;
  const remaining = state.filtered.length - state.displayed;
  if (remaining <= 0) {
    document.getElementById('load-more-wrapper').hidden = true;
  } else {
    setText(document.getElementById('load-more-remaining'), remaining);
  }
}

/* ----- Article Card Builder ----- */
function buildArticleCard(item) {
  const tpl  = document.getElementById('tpl-article-card');
  const card = tpl.content.cloneNode(true).querySelector('.article-card');

  card.dataset.id       = item.id;
  card.dataset.category = item.category || '';

  // starred
  const isStarred = state.starred.has(item.id);
  if (isStarred) card.classList.add('is-starred');

  // Source badge
  const sourceEl = card.querySelector('.card-source');
  sourceEl.textContent = item.source_name || item.source_id || '不明';
  sourceEl.classList.add(`source-${item.source_id}`);

  // Date
  setText(card.querySelector('.card-date'), formatDate(item.published_at));

  // Star button
  const starBtn = card.querySelector('.btn-star');
  if (isStarred) {
    starBtn.classList.add('starred');
    starBtn.querySelector('i').className = 'fas fa-star';
    starBtn.setAttribute('aria-label', 'スターを解除');
  }
  starBtn.addEventListener('click', e => { e.preventDefault(); toggleStar(item.id, card, starBtn); });

  // Title
  const titleEl = card.querySelector('.card-title');
  titleEl.textContent = item.title || '（タイトルなし）';

  // Summary
  setText(card.querySelector('.card-summary'), item.summary || '');

  // Tags
  const tagsEl = card.querySelector('.card-tags');
  (item.tags || []).slice(0, 4).forEach(tag => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.textContent = tag;
    pill.addEventListener('click', () => toggleTagFilter(tag));
    tagsEl.appendChild(pill);
  });

  // Open button
  const link = card.querySelector('.card-open-btn');
  link.href = normalizeUrl(item.url || '#');

  // Priority badge for pickup
  if (state.currentTab === 'pickup' && (item.priority_score ?? 0) >= 90) {
    const badge = document.createElement('span');
    badge.className = 'priority-badge priority-top';
    badge.textContent = 'HOT';
    card.appendChild(badge);
  }

  return card;
}

/* ----- Clip Card Builder ----- */
function buildClipCard(clip) {
  const tpl  = document.getElementById('tpl-clip-card');
  const card = tpl.content.cloneNode(true).querySelector('.article-card');

  card.dataset.id = clip.id;

  setText(card.querySelector('.card-date'), formatDate(clip.saved_at));
  const titleEl = card.querySelector('.card-title');
  titleEl.textContent = clip.title || '（タイトルなし）';
  setText(card.querySelector('.clip-memo'), clip.memo || clip.url || '');

  const tagsEl = card.querySelector('.card-tags');
  (clip.tags || []).forEach(tag => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.textContent = tag;
    tagsEl.appendChild(pill);
  });

  card.querySelector('.card-open-btn').href = normalizeUrl(clip.url || '#');

  card.querySelector('.btn-delete-clip').addEventListener('click', () => {
    deleteClip(clip.id);
    card.remove();
    updateStats();
    if (state.clips.length === 0) {
      showClipsEmpty(document.getElementById('article-grid'));
    }
  });

  return card;
}

function showClipsEmpty(grid) {
  grid.innerHTML = '';
  showState('articles');
  const msg = document.createElement('div');
  msg.style.cssText = 'grid-column:1/-1;padding:4rem 2rem;text-align:center;color:var(--clr-text-3)';
  msg.innerHTML = '<div style="font-size:2.5rem;margin-bottom:1rem">📌</div>' +
    '<p style="font-size:.9rem">まだクリップがありません。</p>' +
    '<p style="font-size:.8rem;margin-top:.5rem">URLとメモを保存してすばやく振り返れます。</p>';
  grid.appendChild(msg);
}

/* ===================================================================
   タブカウント & 統計
=================================================================== */

function updateTabCounts() {
  const categories = ['lesson','exam','edu_news','dx','ai','security','tools'];
  const countMap   = {};
  state.allItems.forEach(i => {
    countMap[i.category] = (countMap[i.category] || 0) + 1;
  });
  setText(document.getElementById('tab-count-all'), state.allItems.length);
  categories.forEach(cat => {
    const el = document.getElementById(`tab-count-${cat}`);
    if (el) setText(el, countMap[cat] || 0);
  });
  const starredCount = state.starred.size;
  setText(document.getElementById('tab-count-starred'), starredCount);
  setText(document.getElementById('tab-count-clips'), state.clips.length);
}

function updateStats() {
  const now    = new Date();
  const todayCutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayCount  = state.allItems.filter(i => new Date(i.published_at) >= todayCutoff).length;

  setText(document.getElementById('stats-total'),   state.allItems.length);
  setText(document.getElementById('stats-starred'),  state.starred.size);
  setText(document.getElementById('stats-today'),    todayCount);
  setText(document.getElementById('stats-clips'),    state.clips.length);
}

/* ===================================================================
   ソース & タグフィルタ UI 構築
=================================================================== */

function buildSourceFilters() {
  const sources = [...new Map(
    state.allItems.map(i => [i.source_id, { id: i.source_id, name: i.source_name }])
  ).values()];

  ['source-filter-list','source-filter-list-m'].forEach(listId => {
    const container = document.getElementById(listId);
    if (!container) return;
    container.innerHTML = '';
    sources.forEach(src => {
      const label = document.createElement('label');
      label.className = 'source-item';
      label.innerHTML = `
        <input type="checkbox" value="${esc(src.id)}" aria-label="${esc(src.name)}をフィルタ">
        <span>${esc(src.name)}</span>
      `;
      const cb = label.querySelector('input');
      cb.addEventListener('change', () => {
        if (cb.checked) state.selectedSources.add(src.id);
        else state.selectedSources.delete(src.id);
        // sync the other list
        syncSourceCheckbox(src.id, cb.checked, listId);
        renderAll();
      });
      container.appendChild(label);
    });
  });
}

function syncSourceCheckbox(id, checked, exceptListId) {
  ['source-filter-list','source-filter-list-m'].forEach(listId => {
    if (listId === exceptListId) return;
    const container = document.getElementById(listId);
    if (!container) return;
    const cb = container.querySelector(`input[value="${CSS.escape(id)}"]`);
    if (cb) cb.checked = checked;
  });
}

function buildTagFilters() {
  const tagCount = {};
  state.allItems.forEach(i => (i.tags || []).forEach(t => {
    tagCount[t] = (tagCount[t] || 0) + 1;
  }));
  const topTags = Object.entries(tagCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([t]) => t);

  ['tag-filter-cloud','tag-filter-cloud-m'].forEach(cloudId => {
    const container = document.getElementById(cloudId);
    if (!container) return;
    container.innerHTML = '';
    topTags.forEach(tag => {
      const chip = document.createElement('button');
      chip.className = 'tag-chip';
      chip.textContent = tag;
      chip.dataset.tag = tag;
      if (state.selectedTags.has(tag)) chip.classList.add('active');
      chip.addEventListener('click', () => toggleTagFilter(tag));
      container.appendChild(chip);
    });
  });
}

function toggleTagFilter(tag) {
  if (state.selectedTags.has(tag)) state.selectedTags.delete(tag);
  else state.selectedTags.add(tag);
  // 両方のタグクラウドを更新
  document.querySelectorAll('.tag-chip').forEach(chip => {
    chip.classList.toggle('active', state.selectedTags.has(chip.dataset.tag));
  });
  renderAll();
}

/* ===================================================================
   スター機能
=================================================================== */

function toggleStar(id, card, btn) {
  if (state.starred.has(id)) {
    state.starred.delete(id);
    card.classList.remove('is-starred');
    btn.classList.remove('starred');
    btn.querySelector('i').className = 'far fa-star';
    btn.setAttribute('aria-label', 'スターを付ける');
    toast('スターを解除しました', 'info', 2000);
  } else {
    state.starred.add(id);
    card.classList.add('is-starred');
    btn.classList.add('starred');
    btn.querySelector('i').className = 'fas fa-star';
    btn.setAttribute('aria-label', 'スターを解除');
    toast('スターを付けました ★', 'success', 2000);
  }
  // allItems の starred フラグも更新
  const item = state.allItems.find(i => i.id === id);
  if (item) item.starred = state.starred.has(id);
  saveLS(STORAGE_KEY_STARS, [...state.starred]);
  updateTabCounts();
  updateStats();
  // starred タブにいる場合は再描画
  if (state.currentTab === 'starred') renderAll();
}

/* ===================================================================
   手動クリップ
=================================================================== */

function openClipModal() {
  document.getElementById('clip-url').value   = '';
  document.getElementById('clip-title').value = '';
  document.getElementById('clip-memo').value  = '';
  document.getElementById('clip-tags').value  = '';
  document.getElementById('modal-clip').hidden = false;
  document.getElementById('clip-url').focus();
}

function closeClipModal() {
  document.getElementById('modal-clip').hidden = true;
}

function saveClip() {
  const url   = document.getElementById('clip-url').value.trim();
  const title = document.getElementById('clip-title').value.trim();
  const memo  = document.getElementById('clip-memo').value.trim();
  const tags  = document.getElementById('clip-tags').value.trim()
    .split(',').map(t => t.trim()).filter(Boolean);

  if (!url)   { toast('URLを入力してください', 'error'); return; }
  if (!title) { toast('タイトルを入力してください', 'error'); return; }

  const clip = {
    id:       'clip_' + Date.now(),
    url, title, memo, tags,
    saved_at: new Date().toISOString(),
  };
  state.clips.unshift(clip);
  saveLS(STORAGE_KEY_CLIPS, state.clips);
  closeClipModal();
  toast('クリップを保存しました 📌', 'success');
  updateStats();
  updateTabCounts();
  if (state.currentTab === 'clips') renderAll();
}

function deleteClip(id) {
  state.clips = state.clips.filter(c => c.id !== id);
  saveLS(STORAGE_KEY_CLIPS, state.clips);
  updateStats();
  updateTabCounts();
  toast('クリップを削除しました', 'info', 2000);
}

/* ===================================================================
   エクスポート / インポート
=================================================================== */

function exportBookmarks() {
  const data = {
    exported_at: new Date().toISOString(),
    starred:     [...state.starred],
    clips:       state.clips,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `teacher-radar-bookmarks-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('エクスポートしました', 'success');
}

function importBookmarks(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (Array.isArray(data.starred)) {
        data.starred.forEach(id => state.starred.add(id));
        saveLS(STORAGE_KEY_STARS, [...state.starred]);
      }
      if (Array.isArray(data.clips)) {
        // 重複 id を除外してマージ
        const existingIds = new Set(state.clips.map(c => c.id));
        const newClips    = data.clips.filter(c => !existingIds.has(c.id));
        state.clips = [...newClips, ...state.clips];
        saveLS(STORAGE_KEY_CLIPS, state.clips);
      }
      toast('インポート完了しました', 'success');
      renderAll();
      updateTabCounts();
      updateStats();
    } catch {
      toast('インポートに失敗しました（JSONが不正）', 'error');
    }
  };
  reader.readAsText(file);
}

/* ===================================================================
   テーマ切替
=================================================================== */

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
  }
  saveLS(STORAGE_KEY_THEME, theme);
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

/* ===================================================================
   フィルタリセット
=================================================================== */

function resetFilters() {
  state.searchQuery    = '';
  state.period         = 'all';
  state.sort           = 'priority';
  state.selectedSources.clear();
  state.selectedTags.clear();

  // UI 同期
  document.getElementById('search-input').value = '';
  const mSearch = document.getElementById('search-input-mobile');
  if (mSearch) mSearch.value = '';

  document.querySelectorAll('[data-period]').forEach(b =>
    b.classList.toggle('active', b.dataset.period === 'all'));
  document.querySelectorAll('[data-period-m]').forEach(b =>
    b.classList.toggle('active', b.dataset.periodM === 'all'));
  document.querySelectorAll('[data-sort]').forEach(b =>
    b.classList.toggle('active', b.dataset.sort === 'priority'));
  document.querySelectorAll('[data-sort-m]').forEach(b =>
    b.classList.toggle('active', b.dataset.sortM === 'priority'));

  document.querySelectorAll('.source-item input[type="checkbox"]').forEach(cb => cb.checked = false);
  document.querySelectorAll('.tag-chip').forEach(chip => chip.classList.remove('active'));
  document.getElementById('search-clear').hidden = true;

  renderAll();
  toast('フィルタをリセットしました', 'info', 2000);
}

/* ===================================================================
   イベントバインド
=================================================================== */

function bindEvents() {
  /* ---- タブ ---- */
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      state.currentTab = btn.dataset.tab;
      renderAll();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  /* ---- 期間フィルタ (desktop) ---- */
  document.querySelectorAll('[data-period]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-period]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.period = btn.dataset.period;
      // モバイルも同期
      document.querySelectorAll('[data-period-m]').forEach(b =>
        b.classList.toggle('active', b.dataset.periodM === state.period));
      renderAll();
    });
  });

  /* ---- 期間フィルタ (mobile) ---- */
  document.querySelectorAll('[data-period-m]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-period-m]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.period = btn.dataset.periodM;
      document.querySelectorAll('[data-period]').forEach(b =>
        b.classList.toggle('active', b.dataset.period === state.period));
      renderAll();
    });
  });

  /* ---- ソート (desktop) ---- */
  document.querySelectorAll('[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-sort]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.sort = btn.dataset.sort;
      document.querySelectorAll('[data-sort-m]').forEach(b =>
        b.classList.toggle('active', b.dataset.sortM === state.sort));
      renderAll();
    });
  });

  /* ---- ソート (mobile) ---- */
  document.querySelectorAll('[data-sort-m]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-sort-m]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.sort = btn.dataset.sortM;
      document.querySelectorAll('[data-sort]').forEach(b =>
        b.classList.toggle('active', b.dataset.sort === state.sort));
      renderAll();
    });
  });

  /* ---- 検索 (desktop) ---- */
  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');
  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.searchQuery = searchInput.value.trim();
      searchClear.hidden = !state.searchQuery;
      const mSearch = document.getElementById('search-input-mobile');
      if (mSearch) mSearch.value = searchInput.value;
      renderAll();
    }, 300);
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    state.searchQuery = '';
    searchClear.hidden = true;
    renderAll();
  });

  /* ---- 検索 (mobile) ---- */
  const searchMobile = document.getElementById('search-input-mobile');
  if (searchMobile) {
    searchMobile.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.searchQuery = searchMobile.value.trim();
        searchInput.value = searchMobile.value;
        searchClear.hidden = !state.searchQuery;
        renderAll();
      }, 300);
    });
  }

  /* ---- リセット ---- */
  document.getElementById('btn-reset-filter')?.addEventListener('click', resetFilters);
  document.getElementById('btn-reset-filter-2')?.addEventListener('click', resetFilters);
  document.getElementById('btn-reset-filter-m')?.addEventListener('click', resetFilters);

  /* ---- もっと見る ---- */
  document.getElementById('btn-load-more').addEventListener('click', loadMore);

  /* ---- クリップモーダル ---- */
  document.getElementById('btn-clip-modal').addEventListener('click', openClipModal);
  document.getElementById('modal-clip-close').addEventListener('click', closeClipModal);
  document.getElementById('modal-clip-cancel').addEventListener('click', closeClipModal);
  document.getElementById('modal-clip-save').addEventListener('click', saveClip);
  document.getElementById('modal-clip').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeClipModal();
  });

  /* ---- エクスポート / インポート ---- */
  document.getElementById('btn-export').addEventListener('click', exportBookmarks);
  document.getElementById('btn-import').addEventListener('click', () =>
    document.getElementById('import-file-input').click());
  document.getElementById('import-file-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) importBookmarks(file);
    e.target.value = '';
  });

  /* ---- テーマ ---- */
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  /* ---- モバイルフィルタドロワー ---- */
  const openDrawer = () => {
    document.getElementById('filter-drawer').hidden  = false;
    document.getElementById('drawer-overlay').hidden = false;
    document.body.style.overflow = 'hidden';
  };
  const closeDrawer = () => {
    document.getElementById('filter-drawer').hidden  = true;
    document.getElementById('drawer-overlay').hidden = true;
    document.body.style.overflow = '';
  };
  document.getElementById('btn-mobile-filter').addEventListener('click', openDrawer);
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('drawer-overlay').addEventListener('click', closeDrawer);
  document.getElementById('drawer-apply').addEventListener('click', closeDrawer);

  /* ---- リトライ ---- */
  document.getElementById('btn-retry').addEventListener('click', async () => {
    const ok = await loadItems();
    if (ok) {
      buildSourceFilters();
      buildTagFilters();
      renderAll();
    }
  });

  /* ---- スクロールトップ ---- */
  const scrollBtn = document.getElementById('scroll-top-btn');
  window.addEventListener('scroll', () => {
    scrollBtn.hidden = window.scrollY < 400;
  }, { passive: true });
  scrollBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  /* ---- タブスクロールアロウ ---- */
  const tabScroll     = document.getElementById('tab-scroll');
  const tabNav        = document.getElementById('tab-nav');
  const arrowLeft     = document.getElementById('tab-arrow-left');
  const arrowRight    = document.getElementById('tab-arrow-right');
  const SCROLL_AMOUNT = 200;

  function updateTabArrows() {
    if (!tabScroll) return;
    const scrollLeft  = tabScroll.scrollLeft;
    const maxScroll   = tabScroll.scrollWidth - tabScroll.clientWidth;
    const hasOverflow = tabScroll.scrollWidth > tabScroll.clientWidth + 4;

    // 左矢印：スクロール済みなら表示
    arrowLeft.hidden  = scrollLeft <= 4;
    // 右矢印：まだ右に余地があるなら表示
    arrowRight.hidden = !hasOverflow || scrollLeft >= maxScroll - 4;

    // フェード用クラス制御
    tabNav.classList.toggle('scrolled', scrollLeft > 4);
    tabNav.classList.toggle('at-end',   !hasOverflow || scrollLeft >= maxScroll - 4);
  }

  if (tabScroll) {
    tabScroll.addEventListener('scroll', updateTabArrows, { passive: true });
    // リサイズ時も再計算
    new ResizeObserver(updateTabArrows).observe(tabScroll);
    // 初期状態を設定
    updateTabArrows();
  }

  arrowRight?.addEventListener('click', () => {
    tabScroll.scrollBy({ left: SCROLL_AMOUNT, behavior: 'smooth' });
  });
  arrowLeft?.addEventListener('click', () => {
    tabScroll.scrollBy({ left: -SCROLL_AMOUNT, behavior: 'smooth' });
  });

  // タブクリック時、選択タブが見えるようスクロール調整
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setTimeout(() => {
        btn.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
      }, 50);
    });
  });

  /* ---- キーボードショートカット ---- */
  document.addEventListener('keydown', e => {
    // Escape でモーダルを閉じる
    if (e.key === 'Escape') {
      closeClipModal();
      closeDrawer();
    }
    // '/' でサイドバー検索フォーカス
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' &&
        document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      searchInput.focus();
    }
  });

  /* ---- Clip modal: Enter で保存 ---- */
  ['clip-url','clip-title','clip-tags'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => {
      if (e.key === 'Enter') saveClip();
    });
  });
}

/* ===================================================================
   初期化
=================================================================== */

async function init() {
  // テーマ復元
  const savedTheme = loadLS(STORAGE_KEY_THEME, null);
  if (savedTheme) {
    applyTheme(savedTheme);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    applyTheme('dark');
  }

  // イベントバインド
  bindEvents();

  // データ読み込み
  const ok = await loadItems();
  if (!ok) return;

  // フィルタ UI 構築
  buildSourceFilters();
  buildTagFilters();

  // 初回描画
  renderAll();
}

// DOM 準備完了後に実行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
