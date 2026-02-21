#!/usr/bin/env node
/**
 * scripts/fetch_feeds.js
 * -------------------------------------------------------
 * RSS / HTML スクレイプで記事を収集し items.json を生成する
 * GitHub Actions から定期実行される想定
 *
 * 使い方:
 *   node scripts/fetch_feeds.js
 *   node scripts/fetch_feeds.js --dry-run   # 出力しない
 *
 * 依存:
 *   npm install node-fetch@3 rss-parser cheerio
 *
 * Node >= 18 推奨 (fetch built-in の場合 node-fetch 不要)
 * -------------------------------------------------------
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

// --- ライブラリ読み込み (互換ラッパー) ---
let fetchFn;
async function getFetch() {
  if (!fetchFn) {
    try {
      // Node 18+ ビルトイン fetch
      fetchFn = globalThis.fetch ?? (await import('node-fetch')).default;
    } catch {
      fetchFn = (await import('node-fetch')).default;
    }
  }
  return fetchFn;
}

let RSSParser;
try { RSSParser = require('rss-parser'); }
catch { console.error('[fetch_feeds] rss-parser が見つかりません: npm install rss-parser'); process.exit(1); }

let cheerio;
try { cheerio = require('cheerio'); }
catch { console.warn('[fetch_feeds] cheerio が見つかりません（スクレイプ機能が無効）'); }

/* ===================================================================
   設定読み込み
=================================================================== */
const ROOT         = path.resolve(__dirname, '..');
const SOURCES_FILE = path.join(ROOT, 'sources.json');
const RULES_FILE   = path.join(ROOT, 'tag_rules.json');
const OUTPUT_FILE  = path.join(ROOT, 'items.json');

const DRY_RUN      = process.argv.includes('--dry-run');
const MAX_ITEMS_PER_SOURCE = 20;
const MAX_TOTAL    = 200;
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT   = 'TeacherRadarBot/1.0 (+https://github.com/rixia6254/info-teacher-radar)';

let sourcesConfig, tagRulesConfig;
try {
  sourcesConfig  = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
  tagRulesConfig = JSON.parse(fs.readFileSync(RULES_FILE,   'utf8'));
} catch (e) {
  console.error('[fetch_feeds] 設定ファイル読み込み失敗:', e.message);
  process.exit(1);
}

/* ===================================================================
   ユーティリティ
=================================================================== */

/** ISO 文字列を JST に正規化 */
function toJST(dateStr) {
  if (!dateStr) return new Date().toISOString();
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** URL の UTM などのパラメータを除去 */
function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content',
     'ref','source','from','via','fbclid','gclid'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch { return url; }
}

/** URL から ID を生成（SHA-256の先頭16文字）*/
function genId(url) {
  return 'item_' + crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/** HTML タグを除去して要約を作成 */
function stripHtml(html, maxLen = 200) {
  if (!html) return '';
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

/** fetch with timeout & UA */
async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const fetch = await getFetch();
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/rss+xml,application/xml,text/xml,text/html,*/*' }
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/* ===================================================================
   タグ付けエンジン
=================================================================== */

/** ルールベースでタグとカテゴリを付与 */
function autoTag(item, sourceConfig) {
  const text = `${item.title || ''} ${item.summary || ''}`;
  const rules = tagRulesConfig.rules || [];

  let bestCategory   = sourceConfig.category || 'tech';
  let bestPriority   = -1;
  const tagSet = new Set(sourceConfig.tags || []);

  for (const rule of rules) {
    const matched = (rule.keywords || []).some(kw =>
      text.includes(kw)
    );
    if (matched) {
      (rule.tags || []).forEach(t => tagSet.add(t));
      if ((rule.priority || 0) > bestPriority) {
        bestPriority = rule.priority;
        bestCategory = rule.category;
      }
    }
  }

  // ソースカテゴリマップで補完
  const srcMap = tagRulesConfig.source_category_map || {};
  if (srcMap[sourceConfig.id]) {
    // 最初の要素をカテゴリのデフォルトに（ただし best_priority が高い場合は上書きしない）
    if (bestPriority < 0) {
      bestCategory = srcMap[sourceConfig.id][0];
    }
  }

  // 優先度スコア計算
  const boostKws = (tagRulesConfig.priority_boost || {}).keywords || [];
  let score = 50;
  boostKws.forEach(kw => { if (text.includes(kw)) score += 10; });
  score = Math.min(score, 100);

  return {
    category: bestCategory,
    tags:     [...tagSet].slice(0, 8),
    priority_score: score,
  };
}

/* ===================================================================
   RSS 取得
=================================================================== */

async function fetchRSS(source) {
  const parser = new RSSParser({
    timeout:     FETCH_TIMEOUT_MS,
    headers:     { 'User-Agent': USER_AGENT },
    customFields: { item: ['description','content','summary','content:encoded'] }
  });

  console.log(`  [RSS] ${source.name} => ${source.rss}`);
  try {
    const feed  = await parser.parseURL(source.rss);
    const items = (feed.items || []).slice(0, MAX_ITEMS_PER_SOURCE).map(entry => {
      const url     = normalizeUrl(entry.link || entry.url || '');
      const summary = stripHtml(
        entry.contentSnippet || entry.content || entry['content:encoded'] ||
        entry.description || entry.summary || '', 200
      );
      const base = {
        id:          genId(url),
        title:       (entry.title || '').trim(),
        url,
        source_id:   source.id,
        source_name: source.name,
        published_at: toJST(entry.pubDate || entry.isoDate || entry.date),
        summary,
        starred:     false,
      };
      const tagged = autoTag(base, source);
      return { ...base, ...tagged };
    }).filter(i => i.url && i.title);
    console.log(`    → ${items.length} 件取得`);
    return items;
  } catch (err) {
    console.warn(`    ⚠ RSS 取得失敗 [${source.name}]: ${err.message}`);
    return [];
  }
}

/* ===================================================================
   HTML スクレイプ (MEXT など RSS なし)
=================================================================== */

async function fetchScrape(source) {
  if (!cheerio) {
    console.warn(`  [SCRAPE] cheerio 未インストールのためスキップ: ${source.name}`);
    return [];
  }
  console.log(`  [SCRAPE] ${source.name} => ${source.scrape_url}`);
  try {
    const res  = await fetchWithTimeout(source.scrape_url);
    const html = await res.text();
    const $    = cheerio.load(html);
    const items = [];

    // MEXT ニュース一覧のパターン
    $('li a, .list-item a, .news-list a, dl dt a').each((_, el) => {
      if (items.length >= MAX_ITEMS_PER_SOURCE) return false;
      const $el  = $(el);
      const href = $el.attr('href') || '';
      const title = $el.text().trim();
      if (!title || title.length < 10) return;
      const absUrl = normalizeUrl(href.startsWith('http') ? href : new URL(href, source.scrape_url).toString());
      if (!absUrl) return;

      const base = {
        id:          genId(absUrl),
        title,
        url:         absUrl,
        source_id:   source.id,
        source_name: source.name,
        published_at: new Date().toISOString(),
        summary:     '',
        starred:     false,
      };
      const tagged = autoTag(base, source);
      items.push({ ...base, ...tagged });
    });

    console.log(`    → ${items.length} 件取得`);
    return items;
  } catch (err) {
    console.warn(`    ⚠ スクレイプ失敗 [${source.name}]: ${err.message}`);
    return [];
  }
}

/* ===================================================================
   重複排除
=================================================================== */

function deduplicate(items) {
  const seenUrls   = new Set();
  const seenTitles = new Map(); // 正規化タイトル → id

  return items.filter(item => {
    // URL 重複
    if (seenUrls.has(item.url)) return false;
    seenUrls.add(item.url);

    // タイトル近似重複（先頭30文字が一致）
    const titleKey = (item.title || '').slice(0, 30).toLowerCase().replace(/\s/g, '');
    if (seenTitles.has(titleKey)) return false;
    seenTitles.set(titleKey, item.id);

    return true;
  });
}

/* ===================================================================
   メイン処理
=================================================================== */

async function main() {
  console.log('===== Teacher Radar Feed Fetcher =====');
  console.log(`開始: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
  if (DRY_RUN) console.log('[DRY RUN モード]');

  const activeSources = (sourcesConfig.sources || []).filter(s => s.active !== false);
  console.log(`\nソース数: ${activeSources.length}\n`);

  const allItems = [];

  for (const source of activeSources) {
    let items = [];
    try {
      if (source.fetch_type === 'scrape') {
        items = await fetchScrape(source);
      } else if (source.rss) {
        items = await fetchRSS(source);
      } else {
        console.log(`  [SKIP] RSS なし・スクレイプ設定なし: ${source.name}`);
      }
    } catch (err) {
      console.warn(`  ⚠ 予期しないエラー [${source.name}]: ${err.message}`);
    }
    allItems.push(...items);
    // レート制限対策
    await new Promise(r => setTimeout(r, 500));
  }

  // 重複排除
  const deduped = deduplicate(allItems);
  console.log(`\n重複排除前: ${allItems.length} 件 → 後: ${deduped.length} 件`);

  // 日付降順でソート
  deduped.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  // 最大件数制限
  const finalItems = deduped.slice(0, MAX_TOTAL);

  // 既存の items.json からクリップ・starred 情報を引き継ぐ
  let existingClips = [];
  try {
    if (fs.existsSync(OUTPUT_FILE)) {
      const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      existingClips = existing.clips || [];
    }
  } catch { /* 無視 */ }

  const output = {
    generated_at: new Date().toISOString(),
    total:        finalItems.length,
    items:        finalItems,
    clips:        existingClips,
  };

  if (DRY_RUN) {
    console.log('\n[DRY RUN] 出力内容（先頭3件）:');
    console.log(JSON.stringify({ ...output, items: finalItems.slice(0, 3) }, null, 2));
  } else {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
    console.log(`\n✅ ${OUTPUT_FILE} を更新しました（${finalItems.length} 件）`);
  }

  console.log(`\n完了: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
}

main().catch(err => {
  console.error('\n❌ 致命的エラー:', err);
  process.exit(1);
});
