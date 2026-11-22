// ==UserScript==
// @name         BiliBlocker — B站推荐流屏蔽器
// @name:en      BiliBlocker — Bilibili Feed Blocker
// @namespace    biliblocker
// @version      1.0.2
// @description  拦截搬运知乎热榜的 B 站视频（渲染前删除，无留白），并按关键词/UP/分区/数值规则过滤推荐流与评论区
// @description:en Block Bilibili feed videos that copy Zhihu hot-list questions, plus rule-based filtering of feeds and comments
// @author       ConspiracyThorist
// @homepageURL  https://github.com/ConspiracyThorist/biliblocker
// @supportURL   https://github.com/ConspiracyThorist/biliblocker/issues
// @icon         https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker@main/assets/icons/icon128.png
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.zhihu.com
// @connect      www.zhihu.com
// @connect      gh-proxy.com
// @connect      fcapp.run
// @connect      fastly.jsdelivr.net
// @connect      raw.githubusercontent.com
// @license      MIT
// @noframes
// ==/UserScript==

"use strict";
(() => {
  // src/core/dice.ts
  function gramHash(g) {
    let h = 2166136261;
    for (let i = 0; i < g.length; i += 1) {
      h ^= g.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function hashBigrams(s) {
    if (!s) return { hashes: new Uint32Array(0), total: 0 };
    if (s.length < 2) return { hashes: Uint32Array.from([gramHash(s)]), total: 1 };
    const out = new Uint32Array(s.length - 1);
    for (let i = 0; i < s.length - 1; i += 1) out[i] = gramHash(s.slice(i, i + 2));
    out.sort();
    return { hashes: out, total: out.length };
  }
  function sortedOverlap(a, b) {
    let i = 0;
    let j = 0;
    let overlap = 0;
    while (i < a.length && j < b.length) {
      const x = a[i];
      const y = b[j];
      if (x === y) {
        overlap += 1;
        i += 1;
        j += 1;
      } else if (x < y) {
        i += 1;
      } else {
        j += 1;
      }
    }
    return overlap;
  }
  function diceFromHashed(a, aTotal, b, bTotal) {
    if (aTotal === 0 || bTotal === 0) return 0;
    return 2 * sortedOverlap(a, b) / (aTotal + bTotal);
  }
  function coverageFromHashed(a, aTotal, b, bTotal) {
    const denominator = Math.min(aTotal, bTotal);
    if (denominator === 0) return 0;
    return sortedOverlap(a, b) / denominator;
  }

  // src/core/normalize.ts
  var TEMPLATE_WORDS = [
    "是一种什么样的体验",
    "是一种怎样的体验",
    "是一种什么体验",
    "是怎样的一种体验",
    "是一种什么感受",
    "如何看待",
    "怎样看待",
    "怎么看待",
    "如何评价",
    "怎么评价",
    "是怎样的体验",
    "是什么体验",
    "是什么意思",
    "有哪些",
    "为什么",
    "是什么",
    "高赞回答",
    "高赞",
    "神回复",
    "热榜",
    "搬运",
    "知乎",
    "问题"
  ].sort((a, b) => b.length - a.length);
  var EMOJI_RE = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;
  var PUNCT_RE = /[\p{P}\p{S}\s]/gu;
  function toHalfWidth(input) {
    let out = "";
    for (const ch of input) {
      const code = ch.codePointAt(0);
      if (code === 12288) {
        out += " ";
      } else if (code >= 65281 && code <= 65374) {
        out += String.fromCodePoint(code - 65248);
      } else {
        out += ch;
      }
    }
    return out;
  }
  function normalize(input) {
    if (!input) return "";
    let s = toHalfWidth(input).toLowerCase();
    s = s.replace(EMOJI_RE, " ");
    s = s.replace(PUNCT_RE, "");
    for (const word of TEMPLATE_WORDS) {
      if (s.includes(word)) s = s.split(word).join("");
    }
    return s.trim();
  }

  // src/core/engine.ts
  var NO_HIT = { hit: false, score: 0, zhihuTitle: "", reason: "none" };
  function round(n) {
    return Math.round(n * 1e3) / 1e3;
  }
  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }
  function prepareHot(titles) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const raw of titles) {
      if (typeof raw !== "string") continue;
      const norm = normalize(raw);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      const grams = hashBigrams(norm);
      out.push({ raw, norm, hashes: grams.hashes, gramTotal: grams.total });
    }
    return out;
  }
  var MIN_LEN_RATIO = 0.3;
  var INDEXES = /* @__PURE__ */ new WeakMap();
  function buildIndex(entries) {
    const postings = /* @__PURE__ */ new Map();
    for (let i = 0; i < entries.length; i += 1) {
      const hashes = entries[i].hashes;
      if (!hashes) continue;
      let prev = -1;
      for (let k = 0; k < hashes.length; k += 1) {
        const h = hashes[k];
        if (h === prev) continue;
        prev = h;
        const list = postings.get(h);
        if (list) list.push(i);
        else postings.set(h, [i]);
      }
    }
    return { postings };
  }
  function attachIndex(entries) {
    INDEXES.set(entries, buildIndex(entries));
    return entries;
  }
  var WORK_BUDGET = 3e4;
  function preparePool(titles, staleTitles = []) {
    const entries = [
      ...prepareHot(titles),
      ...prepareHot(staleTitles).map((entry) => ({ ...entry, stale: true }))
    ];
    return attachIndex(entries);
  }
  function matchTitle(biliTitle, hot, settings) {
    if (!settings.enabled || hot.length === 0) return NO_HIT;
    const norm = normalize(biliTitle);
    if (!norm) return NO_HIT;
    for (const raw of settings.whitelist) {
      const nw = normalize(raw);
      if (!nw) continue;
      if (norm === nw || norm.includes(nw) || nw.includes(norm)) return NO_HIT;
    }
    const threshold = clamp(settings.threshold, 0.5, 0.98);
    const minLen = Math.max(2, settings.minLen);
    const q = norm.length >= 2 ? hashBigrams(norm) : null;
    const qTotal = q ? q.total : 0;
    const index = INDEXES.get(hot);
    if (index && q && norm.length >= minLen) {
      const viaIndex = matchCandidates(norm, q.hashes, qTotal, hot, index, threshold, minLen);
      if (viaIndex) return viaIndex;
    }
    return matchLinear(norm, q ? q.hashes : null, qTotal, hot, threshold, minLen);
  }
  function matchCandidates(norm, qHashes, qTotal, hot, index, threshold, minLen) {
    const ub = /* @__PURE__ */ new Map();
    let work = 0;
    let prev = -1;
    let count = 0;
    for (let k = 0; k <= qHashes.length; k += 1) {
      const h = k < qHashes.length ? qHashes[k] : -1;
      if (h === prev) {
        count += 1;
        continue;
      }
      if (prev !== -1) {
        const list = index.postings.get(prev);
        if (list) {
          work += list.length;
          if (work > WORK_BUDGET) return null;
          for (let j = 0; j < list.length; j += 1) {
            const i = list[j];
            ub.set(i, (ub.get(i) ?? 0) + count);
          }
        }
      }
      prev = h;
      count = 1;
    }
    const order = [...ub.keys()].sort((a, b) => a - b);
    let best = NO_HIT;
    for (const i of order) {
      const entry = hot[i];
      if (entry.norm === norm) return { hit: true, score: 1, zhihuTitle: entry.raw, reason: "exact" };
    }
    for (const i of order) {
      const entry = hot[i];
      const entryHashes = entry.hashes;
      if (!entryHashes) continue;
      const entryThreshold = Math.min(0.98, threshold + (entry.stale ? 0.05 : 0));
      const eTotal = entry.gramTotal ?? entryHashes.length;
      if ((ub.get(i) ?? 0) < entryThreshold * Math.min(qTotal, eTotal)) continue;
      const shorterLen = Math.min(norm.length, entry.norm.length);
      const longerLen = Math.max(norm.length, entry.norm.length);
      if (shorterLen / longerLen < MIN_LEN_RATIO) continue;
      best = consider(norm, qHashes, qTotal, entry, entryHashes, eTotal, entryThreshold, minLen, best);
    }
    return best;
  }
  function matchLinear(norm, qHashes, qTotal, hot, threshold, minLen) {
    let best = NO_HIT;
    for (const entry of hot) {
      const entryThreshold = Math.min(0.98, threshold + (entry.stale ? 0.05 : 0));
      if (entry.norm === norm) {
        return { hit: true, score: 1, zhihuTitle: entry.raw, reason: "exact" };
      }
      if (!qHashes || norm.length < minLen) {
        best = considerContain(norm, entry, entryThreshold, minLen, best);
        continue;
      }
      const entryHashes = entry.hashes;
      if (!entryHashes) continue;
      const shorterLen = Math.min(norm.length, entry.norm.length);
      const longerLen = Math.max(norm.length, entry.norm.length);
      if (shorterLen / longerLen < MIN_LEN_RATIO) {
        best = considerContain(norm, entry, entryThreshold, minLen, best);
        continue;
      }
      const eTotal = entry.gramTotal ?? entryHashes.length;
      best = considerContain(norm, entry, entryThreshold, minLen, best);
      best = considerScored(
        qHashes,
        qTotal,
        entry,
        entryHashes,
        eTotal,
        entryThreshold,
        best
      );
    }
    return best;
  }
  function considerContain(norm, entry, entryThreshold, minLen, best) {
    if (norm.length < 2 || entry.norm.length < 2) return best;
    const shorter = norm.length <= entry.norm.length ? norm : entry.norm;
    const longer = shorter === norm ? entry.norm : norm;
    if (!longer.includes(shorter)) return best;
    const ratio = shorter.length / longer.length;
    const need = shorter.length < minLen ? Math.max(0.95, entryThreshold) : Math.max(0.55, entryThreshold);
    if (ratio >= need && ratio > best.score) {
      return { hit: true, score: round(ratio), zhihuTitle: entry.raw, reason: "contain" };
    }
    return best;
  }
  function considerScored(qHashes, qTotal, entry, entryHashes, eTotal, entryThreshold, best) {
    let next = best;
    const score = diceFromHashed(qHashes, qTotal, entryHashes, eTotal);
    if (score >= entryThreshold && score > next.score) {
      next = { hit: true, score: round(score), zhihuTitle: entry.raw, reason: "dice" };
    }
    const cover = coverageFromHashed(qHashes, qTotal, entryHashes, eTotal);
    if (cover >= entryThreshold && cover > next.score) {
      next = { hit: true, score: round(cover), zhihuTitle: entry.raw, reason: "cover" };
    }
    return next;
  }
  function consider(norm, qHashes, qTotal, entry, entryHashes, eTotal, entryThreshold, minLen, best) {
    const withContain = considerContain(norm, entry, entryThreshold, minLen, best);
    return considerScored(qHashes, qTotal, entry, entryHashes, eTotal, entryThreshold, withContain);
  }

  // src/core/dom.ts
  var CARD_SELECTORS = [
    ".bili-video-card",
    ".feed-card",
    ".bili-video-card.is-rcmd",
    ".recommended-container .bili-video-card"
  ];
  var TITLE_SELECTORS = [".bili-video-card__info--tit", 'h3[class*="tit"]', "a[title]"];
  var STYLE_ID = "zbb-style";
  function extractTitle(card) {
    for (const sel of TITLE_SELECTORS) {
      const el = card.querySelector(sel);
      if (!el) continue;
      const text = (el.getAttribute("title") ?? el.textContent ?? "").trim();
      if (text) return text;
    }
    return "";
  }
  function hideCard(card) {
    const target = layoutItemOf(card);
    if (target instanceof HTMLElement) {
      target.style.setProperty("display", "none", "important");
    }
    target.setAttribute("data-zbb", "1");
    repackIfSparse(target);
  }
  function isLayoutContainer(el) {
    if (typeof getComputedStyle !== "function") return false;
    const display = getComputedStyle(el).display;
    return display === "grid" || display === "inline-grid" || display.includes("flex");
  }
  function layoutItemOf(card) {
    let target = card;
    for (let i = 0; i < 3; i += 1) {
      const parent = target.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (isLayoutContainer(parent)) break;
      const cls = typeof parent.className === "string" ? parent.className : "";
      const looksLikeCell = /(^|[\s_-])(card|cell|item)([\s_-]|$)/i.test(cls);
      if (parent.childElementCount === 1 || looksLikeCell) {
        target = parent;
        continue;
      }
      break;
    }
    return target;
  }
  function repackIfSparse(target) {
    const grid = target.parentElement;
    if (!grid || typeof getComputedStyle !== "function") return;
    const cs = getComputedStyle(grid);
    if (cs.display !== "grid" && cs.display !== "inline-grid") return;
    if (cs.gridAutoFlow.includes("dense")) return;
    if (grid instanceof HTMLElement) grid.style.setProperty("grid-auto-flow", "row dense");
  }
  function ensureStyle(doc = document) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = '[data-zbb="1"]{display:none!important}';
    const root = doc.head ?? doc.documentElement;
    if (!root) return;
    root.appendChild(style);
  }
  var UP_STYLE_ID = "zbb-up-style";
  function cardOwner(card) {
    const link = card.querySelector('a[href*="space.bilibili.com"]');
    const href = link?.getAttribute("href") ?? "";
    const mid = Number(href.match(/space\.bilibili\.com\/(\d+)/)?.[1] ?? 0);
    if (!mid) return null;
    const name = card.querySelector('.bili-video-card__info--author, .up-name, [class*="author"]')?.textContent?.trim() ?? "";
    return { mid, name: name.slice(0, 40) };
  }
  function ensureUpStyle(doc) {
    if (doc.getElementById(UP_STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = UP_STYLE_ID;
    style.textContent = `
[data-zbb-up] {
  /* 左上角：B 站自己的「稍后观看」等在右上角，这里避开它，也避开其它净化脚本的按钮 */
  position: absolute; top: 6px; left: 6px; right: auto; z-index: 2147483000;
  padding: 3px 8px; border-radius: 999px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.28);
  background: rgba(20,22,27,.82); color: #fff;
  font: 11px/1.4 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  opacity: 0; transition: opacity .15s; backdrop-filter: blur(6px);
  /* 只让自己可点，不挡住卡片的其它交互 */
  pointer-events: auto; contain: layout style;
}
.bili-video-card:hover [data-zbb-up],
.feed-card:hover [data-zbb-up],
a:hover > [data-zbb-up],
[data-zbb-up]:hover { opacity: 1; }
[data-zbb-up]:hover { border-color: #fb7299; color: #fb7299; }
`;
    const root = doc.head ?? doc.documentElement;
    if (!root) return;
    root.appendChild(style);
  }
  function attachUpButton(card, owner, onBlock) {
    if (card.querySelector("[data-zbb-up]")) return;
    if (!card.textContent || card.textContent.trim().length < 2) return;
    ensureUpStyle(card.ownerDocument ?? document);
    const cover = card.querySelector(
      '.bili-video-card__cover, [class*="bili-video-card__cover"], .bili-cover, [class*="cover"], .pic'
    );
    if (!cover) return;
    if (/skeleton/i.test(String(cover.className))) return;
    const box = cover;
    if (box.clientWidth < 40 || box.clientHeight < 40) return;
    const host = box;
    try {
      const pos = getComputedStyle(host).position;
      if (!pos || pos === "static") return;
    } catch {
      return;
    }
    const btn = document.createElement("button");
    btn.setAttribute("data-zbb-up", "1");
    btn.textContent = "屏蔽此 UP";
    btn.title = `把 ${owner.name || owner.mid} 加入 UP 库，此后其视频不再出现在首页`;
    const swallow = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    btn.addEventListener("pointerdown", swallow);
    btn.addEventListener("mousedown", swallow);
    btn.addEventListener("click", (event) => {
      swallow(event);
      onBlock(owner);
    });
    host.appendChild(btn);
  }
  function startScanner(opts) {
    let seen = /* @__PURE__ */ new WeakSet();
    let timer = 0;
    let stopped = false;
    const pending = /* @__PURE__ */ new Set();
    const CARD_SEL = CARD_SELECTORS.join(",");
    const handleCard = (card, canMatch2) => {
      if (card !== card.closest(CARD_SEL)) return;
      if (opts.onCard?.(card) === true) return;
      if (!canMatch2) return;
      if (seen.has(card)) return;
      const title = extractTitle(card);
      if (!title) return;
      seen.add(card);
      const result = matchTitle(title, hot, settings);
      if (!result.hit) return;
      hideCard(card);
      opts.onHit(title, result);
    };
    let settings = opts.settings();
    let hot = opts.hot();
    let canMatch = false;
    const scan = () => {
      if (stopped || document.hidden) return;
      settings = opts.settings();
      hot = opts.hot();
      canMatch = settings.enabled && hot.length > 0;
      ensureStyle();
      document.querySelectorAll(CARD_SEL).forEach((card) => handleCard(card, canMatch));
    };
    const scanPending = () => {
      if (stopped || document.hidden) return;
      if (pending.size === 0) return;
      settings = opts.settings();
      hot = opts.hot();
      canMatch = settings.enabled && hot.length > 0;
      for (const node of pending) {
        if (!node.isConnected) continue;
        if (node.matches(CARD_SEL)) handleCard(node, canMatch);
        node.querySelectorAll(CARD_SEL).forEach((card) => handleCard(card, canMatch));
      }
      pending.clear();
    };
    const schedule = () => {
      if (timer || stopped) return;
      timer = window.setTimeout(() => {
        timer = 0;
        scanPending();
      }, 200);
    };
    scan();
    const root = document.documentElement ?? document;
    const observer = new MutationObserver((muts) => {
      for (const mut of muts) {
        for (const node of mut.addedNodes) {
          if (node.nodeType === 1) pending.add(node);
        }
      }
      if (pending.size) schedule();
    });
    observer.observe(root, { childList: true, subtree: true });
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      scan();
    }, 2e3);
    window.setTimeout(() => window.clearInterval(interval), 6e4);
    return {
      scan,
      rescan: () => {
        seen = /* @__PURE__ */ new WeakSet();
        scan();
      },
      stop: () => {
        stopped = true;
        observer.disconnect();
        window.clearInterval(interval);
        if (timer) window.clearTimeout(timer);
      }
    };
  }

  // src/core/rules/card.ts
  function parseDuration(s) {
    if (!s) return null;
    const parts = s.trim().split(":").map((x) => parseInt(x, 10));
    if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  function parseCount(s) {
    if (!s) return null;
    const t = s.trim().replace(/[,\s]/g, "");
    const m = t.match(/^([\d.]+)\s*(万|亿)?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    if (m[2] === "万") n *= 1e4;
    else if (m[2] === "亿") n *= 1e8;
    return Math.round(n);
  }
  function normFeedItem(it) {
    if (!it || typeof it !== "object") return null;
    const node = it;
    const goto = node.goto || node.card_goto || "";
    const owner = node.owner || {};
    const stat = node.stat || {};
    const ad = node.ad_info || node.cm_info || node.cm || null;
    const adC = ad && (ad.creative_content || ad.creative) || {};
    const rawTitle = node.title || adC.title || adC.description || ad?.title || "";
    return {
      title: String(rawTitle || "").replace(/<[^>]*>/g, ""),
      up: owner.name || node.author || node.name || ad && ad.source_content && ad.source_content.name || "",
      uid: owner.mid != null ? String(owner.mid) : node.mid != null ? String(node.mid) : "",
      // 只认真正的分区字段：rcmd_reason.content 是「已关注/高播放」这类推荐理由，语义不同
      partition: node.tname || node.typename || "",
      bvid: node.bvid || "",
      link: node.uri || node.jump_url || adC.url || adC.jump_url || "",
      duration: typeof node.duration === "number" ? node.duration : node.duration ? parseDuration(node.duration) : null,
      views: stat.view != null ? stat.view : stat.play != null ? stat.play : node.play != null ? node.play : null,
      likes: stat.like != null ? stat.like : null,
      isLive: goto === "live" || !!node.live_info,
      isAd: goto === "ad" || goto === "cm" || !!node.ad_info || !!node.is_ad
    };
  }

  // src/core/rules/domCard.ts
  var CARD_TITLE_SELECTORS = [
    ".bili-video-card__info--tit",
    ".video-name",
    "h3[title]",
    ".title"
  ];
  var CARD_UP_SELECTORS = [
    ".bili-video-card__info--author",
    ".up-name__text",
    ".up-name",
    ".bili-video-card__info--owner span"
  ];
  var CARD_PARTITION_SELECTORS = [".bili-video-card__info--tag", ".rcmd-tag"];
  var CARD_DURATION_SELECTORS = [
    ".bili-video-card__stats__duration",
    ".duration",
    ".bili-dyn-card-video__duration",
    ".video-card-cover-stats__item--duration"
    // BewlyCat
  ];
  var CARD_VIEWS_SELECTORS = [
    ".bili-video-card__stats--item",
    ".play-text",
    ".cover-stat-view .video-card-cover-stats__value"
    // BewlyCat
  ];
  var CARD_LIKES_SELECTORS = [".cover-stat-like .video-card-cover-stats__value"];
  var CARD_MID_ATTR_SELECTOR = "[data-mid],[data-up-mid],[data-user-id]";
  var CARD_MID_ATTRS = ["data-mid", "data-up-mid", "data-user-id"];
  var LIVE_CARD_SELECTOR = '.bili-live-card, [class*="live-card"]';
  var AD_CARD_SELECTOR = [
    ".bili-video-card__info--ad",
    'a[href*="cm.bilibili.com"]',
    'a[href*="//mall.bilibili.com"]',
    'a[href*="specialRecommendByOp"]'
  ].join(",");
  function pickText(card, selectors) {
    for (const sel of selectors) {
      const el = card.querySelector(sel);
      if (!el) continue;
      const v = el.getAttribute("title") || el.textContent;
      if (v && v.trim()) return v.trim();
    }
    return "";
  }
  function extractCardInfo(card, opts = {}) {
    const deepUid = opts.deepUid ?? false;
    const detectAd = opts.detectAd ?? true;
    const info = {
      title: "",
      up: "",
      uid: "",
      partition: "",
      bvid: "",
      duration: null,
      views: null,
      likes: null,
      isLive: false,
      isAd: false
    };
    info.title = pickText(card, CARD_TITLE_SELECTORS);
    info.up = pickText(card, CARD_UP_SELECTORS);
    const upA = card.querySelector('a[href*="space.bilibili.com"]');
    if (upA) {
      info.uid = ((upA.getAttribute("href") || "").match(/space\.bilibili\.com\/(\d+)/) || [])[1] || "";
    }
    if (!info.uid) {
      const midEl = card.querySelector(CARD_MID_ATTR_SELECTOR);
      if (midEl) {
        for (const attr of CARD_MID_ATTRS) {
          const v = midEl.getAttribute(attr);
          if (v) {
            info.uid = v;
            break;
          }
        }
      }
    }
    info.partition = pickText(card, CARD_PARTITION_SELECTORS);
    const aVideo = card.querySelector('a[href*="/video/"]');
    if (aVideo) {
      const m = (aVideo.getAttribute("href") || "").match(/(BV[0-9A-Za-z]+)/);
      if (m) info.bvid = m[1];
    }
    info.duration = parseDuration(pickText(card, CARD_DURATION_SELECTORS));
    for (const sel of CARD_VIEWS_SELECTORS) {
      const el = card.querySelector(sel);
      if (el) {
        info.views = parseCount(el.textContent);
        break;
      }
    }
    for (const sel of CARD_LIKES_SELECTORS) {
      const el = card.querySelector(sel);
      if (el) {
        info.likes = parseCount(el.textContent);
        break;
      }
    }
    const text = card.textContent || "";
    info.isLive = !!(card.querySelector('a[href*="live.bilibili.com"]') || card.querySelector(LIVE_CARD_SELECTOR) || /直播中|正在直播/.test(text));
    if (!info.uid && deepUid && text.trim()) {
      const html = card.innerHTML;
      info.uid = (html.match(/space\.bilibili\.com\/(\d+)/) || [])[1] || (html.match(/"(?:mid|owner_?id|up_?mid)"\s*:\s*"?(\d{2,})"?/) || [])[1] || "";
    }
    if (detectAd && !info.isLive) {
      info.isAd = !!card.querySelector(AD_CARD_SELECTOR);
      if (!info.isAd) {
        info.isAd = Array.from(card.querySelectorAll("span,div")).some((el) => {
          const tx = (el.textContent || "").trim();
          return tx === "广告" || tx === "赞助" || tx === "推广";
        });
      }
    }
    return info;
  }

  // src/core/rules/text.ts
  var lc = (s) => (s || "").toString().trim().toLowerCase();
  function toHalfWidth2(s) {
    return (s || "").toString().replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248)).replace(/\u3000/g, " ");
  }
  var escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  var INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
  var stripInvisible = (s) => (s || "").toString().replace(INVISIBLE_RE, "");
  var SEP_RE = /[\s_.·・･﹒。,，、;；:：!！?？~～^*"'`|｜/\\()（）【】<>《》[\]—-]+/g;
  var getFuzzy = () => true;
  function configureFuzzy(fn) {
    getFuzzy = fn;
  }
  var memoSrc;
  var memoFuzzy;
  var memoOut = "";
  function normMatch(s) {
    const fuzzy = getFuzzy();
    if (s === memoSrc && fuzzy === memoFuzzy) return memoOut;
    let t = stripInvisible(toHalfWidth2(s)).toLowerCase();
    if (fuzzy) t = t.replace(SEP_RE, "");
    memoSrc = s;
    memoFuzzy = fuzzy;
    memoOut = t;
    return t;
  }
  var MAX_REGEX_LEN = 1e3;
  function looksCatastrophic(src) {
    return /\((?:[^()]*[*+]|[^()]*\{\d+,\}?)[^()]*\)\s*(?:[*+]|\{\d+,\}?)/.test(src);
  }
  function regexRejectReason(body) {
    if (body.length > MAX_REGEX_LEN) return `模式体超过 ${MAX_REGEX_LEN} 字符`;
    if (looksCatastrophic(body)) return "疑似灾难性回溯（量词套在含无界量词的分组上，如 (a+)+），可能卡死页面";
    return null;
  }
  function ruleLines(lines) {
    if (!Array.isArray(lines)) return [];
    return lines.filter((x) => typeof x === "string");
  }
  function compileLines(lines) {
    const plainParts = [];
    const plainSrc = [];
    const plainNorm = [];
    const regexes = [];
    const regexSrc = [];
    for (const raw of ruleLines(lines)) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^\/(.*)\/([a-z]*)$/);
      if (m) {
        if (regexRejectReason(m[1])) continue;
        try {
          const flags = (m[2] || "i").replace(/[gy]/g, "");
          regexes.push(new RegExp(m[1], flags.includes("i") ? flags : `${flags}i`));
          regexSrc.push(line);
        } catch {
        }
      } else {
        const w = normMatch(line);
        if (w) {
          plainParts.push(escapeRe(w));
          plainSrc.push(line);
          plainNorm.push(w);
        }
      }
    }
    let plain = null;
    if (plainParts.length) {
      try {
        plain = new RegExp(plainParts.join("|"), "i");
      } catch {
      }
    }
    return { plain, regexes, empty: !plain && !regexes.length, plainSrc, plainNorm, regexSrc };
  }
  function textHit(text, matcher) {
    if (!text || !matcher) return false;
    if (matcher.plain && matcher.plain.test(normMatch(text))) return true;
    if (matcher.regexes.length) {
      const t = stripInvisible(text);
      for (const r of matcher.regexes) if (r.test(t)) return true;
    }
    return false;
  }
  function whichHit(text, matcher) {
    if (!text || !matcher) return null;
    if (matcher.plain) {
      const t = normMatch(text);
      for (let i = 0; i < matcher.plainNorm.length; i += 1) {
        if (t.includes(matcher.plainNorm[i])) return matcher.plainSrc[i];
      }
    }
    if (matcher.regexes.length) {
      const t = stripInvisible(text);
      for (let i = 0; i < matcher.regexes.length; i += 1) {
        if (matcher.regexes[i].test(t)) return matcher.regexSrc[i];
      }
    }
    return null;
  }
  function compileScopedKeywords(lines) {
    const buckets = { all: [], title: [], up: [], part: [] };
    for (const raw of ruleLines(lines)) {
      const line = raw.trim();
      if (!line) continue;
      const m = !line.startsWith("/") && line.match(/^(title|up|part)\s*:\s*(.+)$/i);
      if (m) buckets[m[1].toLowerCase()].push(m[2].trim());
      else buckets.all.push(line);
    }
    return {
      all: compileLines(buckets.all),
      title: compileLines(buckets.title),
      up: compileLines(buckets.up),
      part: compileLines(buckets.part)
    };
  }
  function kwHit(scoped, field, text) {
    if (!scoped || !text) return false;
    return textHit(text, scoped.all) || textHit(text, scoped[field]);
  }
  function kwWhich(scoped, field, text) {
    if (!scoped || !text) return null;
    return whichHit(text, scoped.all) || whichHit(text, scoped[field]);
  }

  // src/core/rules/rules.ts
  var DEFAULT_RULES = {
    keywords: [],
    allowKeywords: [],
    upNames: [],
    uids: [],
    bvids: [],
    partitions: [],
    allowUids: [],
    block: {
      minViews: 0,
      maxViews: 0,
      minLikes: 0,
      maxLikes: 0,
      spamLikeRatio: 0,
      spamMinViews: 10,
      minDuration: 0,
      maxDuration: 0
    },
    hideAd: true,
    hideLive: false,
    fuzzyMatch: true
  };
  function compileRules(set) {
    configureFuzzy(() => set.fuzzyMatch !== false);
    const upNames = /* @__PURE__ */ new Map();
    for (const name of set.upNames ?? []) {
      const key = lc(name);
      if (key) upNames.set(key, String(name).trim());
    }
    const uids = /* @__PURE__ */ new Set();
    for (const uid of set.uids ?? []) {
      const v = String(uid).trim();
      if (/^\d+$/.test(v)) uids.add(v);
    }
    const bvids = /* @__PURE__ */ new Set();
    for (const bv of set.bvids ?? []) {
      const v = String(bv).trim();
      if (v) bvids.add(v);
    }
    const allowUids = /* @__PURE__ */ new Set();
    for (const uid of set.allowUids ?? []) {
      const v = String(uid).trim();
      if (/^\d+$/.test(v)) allowUids.add(v);
    }
    return {
      kw: compileScopedKeywords(set.keywords),
      allowKw: compileScopedKeywords(set.allowKeywords),
      partitions: compileLines(set.partitions),
      upNames,
      uids,
      bvids,
      allowUids,
      block: { ...DEFAULT_RULES.block, ...set.block },
      hideAd: set.hideAd !== false,
      hideLive: !!set.hideLive
    };
  }
  function isWhitelisted(info, rules) {
    if (kwHit(rules.allowKw, "title", info.title)) return true;
    if (info.up && kwHit(rules.allowKw, "up", info.up)) return true;
    if (info.partition && kwHit(rules.allowKw, "part", info.partition)) return true;
    if (info.uid && rules.allowUids.has(info.uid)) return true;
    return false;
  }
  function matchCard(info, rules) {
    if (isWhitelisted(info, rules)) return null;
    const b = rules.block;
    if (rules.hideAd && info.isAd) return { reason: "广告卡" };
    if (rules.hideLive && info.isLive) return { reason: "直播卡" };
    if (info.views != null) {
      if (b.minViews > 0 && info.views < b.minViews * 1e4) return { reason: `播放<${b.minViews}万` };
      if (b.maxViews > 0 && info.views > b.maxViews * 1e4) return { reason: `播放>${b.maxViews}万` };
    }
    if (info.likes != null) {
      if (b.minLikes > 0 && info.likes < b.minLikes) return { reason: `点赞<${b.minLikes}` };
      if (b.maxLikes > 0 && info.likes > b.maxLikes) return { reason: `点赞>${b.maxLikes}` };
    }
    if (b.spamLikeRatio > 0 && info.likes != null && info.views) {
      if (info.views >= b.spamMinViews * 1e4 && info.likes / info.views * 100 < b.spamLikeRatio) {
        return { reason: `营销号(赞率<${b.spamLikeRatio}%)` };
      }
    }
    const field = kwHit(rules.kw, "title", info.title) ? "title" : info.up && kwHit(rules.kw, "up", info.up) ? "up" : info.partition && kwHit(rules.kw, "part", info.partition) ? "part" : null;
    if (field) {
      const text = field === "title" ? info.title : field === "up" ? info.up : info.partition;
      const rule = kwWhich(rules.kw, field, text);
      return { reason: rule ? `关键词:${rule}` : "关键词" };
    }
    if (info.partition && textHit(info.partition, rules.partitions)) {
      return { reason: `分区:${whichHit(info.partition, rules.partitions) || info.partition}` };
    }
    if (info.up && rules.upNames.has(lc(info.up))) {
      return { reason: `UP主:${rules.upNames.get(lc(info.up))}` };
    }
    if (info.uid && rules.uids.has(info.uid)) return { reason: `UID:${info.uid}` };
    if (info.bvid && rules.bvids.has(info.bvid)) return { reason: `BV:${info.bvid}` };
    if (info.duration != null) {
      if (b.minDuration > 0 && info.duration < b.minDuration) return { reason: `时长<${b.minDuration}s` };
      if (b.maxDuration > 0 && info.duration > b.maxDuration) return { reason: `时长>${b.maxDuration}s` };
    }
    return null;
  }

  // src/core/pruner.ts
  var CARD_KEYS = ["bvid", "aid", "goto", "cid"];
  function looksLikeCard(el) {
    if (!el || typeof el !== "object" || Array.isArray(el)) return false;
    const obj = el;
    if (typeof obj.title !== "string" || obj.title.trim() === "") return false;
    return CARD_KEYS.some((k) => k in obj);
  }
  function pruneFeed(root, hooks) {
    let removed = 0;
    const maxDepth = 14;
    const walk = (node, depth) => {
      if (!node || typeof node !== "object" || depth > maxDepth) return;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i -= 1) {
          const el = node[i];
          if (looksLikeCard(el)) {
            if (hooks.shouldDrop?.(el)) {
              node.splice(i, 1);
              removed += 1;
              continue;
            }
            const byRule = hooks.matchItem?.(el);
            if (byRule?.hit) {
              hooks.onHit(el.title, byRule);
              node.splice(i, 1);
              removed += 1;
              continue;
            }
            const result = hooks.match(el.title);
            if (result.hit) {
              hooks.onHit(el.title, result);
              node.splice(i, 1);
              removed += 1;
              continue;
            }
          }
          walk(el, depth + 1);
        }
        return;
      }
      for (const key of Object.keys(node)) {
        walk(node[key], depth + 1);
      }
    };
    walk(root, 0);
    return removed;
  }

  // src/core/urlFilter.ts
  var FEED_PATHS = [/\/feed\/rcmd\b/, /\/top\/feed\b/, /\/index\/top\/feed\b/, /\/wbi\/index\/top\/feed\b/];
  var BILI_HOSTS = /* @__PURE__ */ new Set(["bilibili.com", "www.bilibili.com"]);
  function isFeedUrl(input, base = "https://www.bilibili.com/") {
    if (!input) return false;
    try {
      const url = new URL(input, base);
      const host = url.hostname.toLowerCase();
      if (!BILI_HOSTS.has(host) && !host.endsWith(".bilibili.com")) return false;
      return FEED_PATHS.some((re) => re.test(url.pathname));
    } catch {
      return false;
    }
  }

  // src/core/hook.ts
  function ruleHit(item, rules) {
    const info = normFeedItem(item);
    if (!info) return null;
    const hit = matchCard(info, rules);
    if (!hit) return null;
    return { hit: true, score: 1, zhihuTitle: "", reason: "rule", detail: hit.reason };
  }
  function pruneOptions(state2, onHit) {
    return {
      match: (title) => matchTitle(title, state2.hot, state2.settings),
      onHit,
      shouldDrop: (item) => {
        const ups = state2.blockedUps;
        return !!ups && ups.size > 0 && ups.has(ownerMid(item));
      },
      matchItem: state2.rules ? (item) => ruleHit(item, state2.rules) : void 0
    };
  }
  function ownerMid(item) {
    const node = item;
    const mid = Number(node?.owner?.mid ?? node?.mid);
    return Number.isFinite(mid) ? mid : 0;
  }
  function installFeedHook(opts) {
    const { win: win2, ready, getState, onHit } = opts;
    const check = opts.checkUrl ?? ((u) => isFeedUrl(u, win2.location?.href));
    patchFetch(win2, check, ready, getState, onHit);
    patchXhr(win2, check, getState, onHit);
  }
  function patchFetch(win2, isFeed, ready, getState, onHit) {
    const nativeFetch = win2.fetch;
    if (typeof nativeFetch !== "function") return;
    const patched = function(...args) {
      const input = args[0];
      const pending = nativeFetch.apply(this, args);
      let url = "";
      try {
        if (typeof input === "string") url = input;
        else if (typeof Request !== "undefined" && input instanceof Request) url = input.url;
        else url = String(input);
      } catch {
        url = "";
      }
      if (!url || !isFeed(url)) return pending;
      return pending.then(async (res) => {
        if (!res || !res.ok) return res;
        try {
          await ready;
        } catch {
        }
        const state2 = getState();
        if (!state2.settings.enabled) return res;
        if (state2.hot.length === 0 && !state2.rules) return res;
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType && !contentType.includes("json")) return res;
        const json = await res.clone().json();
        const removed = pruneFeed(json, pruneOptions(state2, onHit));
        if (removed === 0) return res;
        const headers = new Headers(res.headers);
        headers.delete("content-encoding");
        headers.delete("content-length");
        return new Response(JSON.stringify(json), {
          status: res.status,
          statusText: res.statusText,
          headers
        });
      }).catch(() => pending);
    };
    win2.fetch = patched;
  }
  function patchXhr(win2, isFeed, getState, onHit) {
    const XHR = win2.XMLHttpRequest;
    if (!XHR || !XHR.prototype) return;
    const nativeOpen = XHR.prototype.open;
    const nativeSend = XHR.prototype.send;
    XHR.prototype.open = function(...args) {
      this.__zbbUrl = String(args[1]);
      return nativeOpen.apply(this, args);
    };
    XHR.prototype.send = function(...args) {
      const self = this;
      const url = self.__zbbUrl ?? "";
      if (url && isFeed(url)) {
        self.addEventListener("load", () => {
          try {
            if (self.status < 200 || self.status >= 300) return;
            const state2 = getState();
            if (!state2.settings.enabled) return;
            if (state2.hot.length === 0 && !state2.rules) return;
            const raw = self.responseType === "json" ? self.response : self.responseText;
            if (!raw) return;
            const json = typeof raw === "string" ? JSON.parse(raw) : raw;
            const removed = pruneFeed(json, pruneOptions(state2, onHit));
            if (removed === 0) return;
            const text = JSON.stringify(json);
            if (self.responseType === "" || self.responseType === "text") {
              Object.defineProperty(self, "responseText", { value: text, configurable: true });
            } else if (self.responseType === "json") {
              Object.defineProperty(self, "response", { value: json, configurable: true });
            }
          } catch {
          }
        });
      }
      return nativeSend.apply(this, args);
    };
  }

  // src/core/comments.ts
  var DEFAULT_COMMENT_RULES = {
    enabled: false,
    keywords: [],
    userKeywords: [],
    users: [],
    minLevel: 0,
    hideNoFace: false,
    hideBot: false,
    hideCallBot: false,
    hideAd: false,
    hideCallOnly: false,
    hideEmojiOnly: false,
    allowUp: true,
    allowPin: true,
    allowMe: true
  };
  var COMMENT_BOTS = /* @__PURE__ */ new Set([
    "机器工具人",
    "有趣的程序员",
    "AI视频小助理",
    "AI视频小助理总结一下",
    "AI笔记侠",
    "AI视频助手",
    "哔哩哔理点赞姬",
    "课代表猫",
    "AI课代表呀",
    "木几萌Moe",
    "星崽丨StarZai",
    "AI沈阳美食家",
    "AI头脑风暴",
    "GPT_5",
    "Juice_AI",
    "AI全文总结",
    "AI视频总结",
    "AI总结视频",
    "AI工具集",
    "Ai的评论",
    "AI识片酱",
    "AI知识总结",
    "AI小精灵呀",
    "AI课程教学",
    "Ai好记",
    "MilkyAi",
    "视频AI问答助手"
  ]);
  var COMMENT_AD_RE = /(bili2233\.cn|b23\.tv)\/(mall-|cm-)|领券|gaoneng\.bilibili\.com/i;
  var COMMENT_TAGS = {
    // true = 楼中楼（二级评论）
    "BILI-COMMENT-THREAD-RENDERER": false,
    "BILI-COMMENT-REPLY-RENDERER": true
  };
  function isCommentTag(tagName) {
    return COMMENT_TAGS[tagName] !== void 0;
  }
  function readCmt(host) {
    const d = host && host.__data || {};
    const member = d.member || {};
    const content = d.content || {};
    const lv = member.level_info && member.level_info.current_level;
    const vipStatus = member.vip && member.vip.vipStatus;
    return {
      uname: ((member.uname || "") + "").trim(),
      mid: d.mid,
      level: typeof lv === "number" ? lv : null,
      noface: (member.avatar || "").endsWith("noface.jpg") && (vipStatus === 0 || vipStatus == null),
      message: (content.message || "") + "",
      members: Array.isArray(content.members) ? content.members : [],
      isUpTop: !!(d.reply_control && d.reply_control.is_up_top),
      upMid: host ? host.__upMid : void 0,
      me: host && host.__user ? host.__user.uname : void 0
    };
  }
  var EMOJI_RE2 = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u200d\u{20E3}]/gu;
  function cleanComment(message, isSub) {
    let s = (message || "").toString();
    if (isSub) s = s.replace(/^回复\s?@[^@\s:：]+\s?[:：]/, "");
    return s.replace(/@[^@\s]+/g, " ").replace(/(\[[^[\]]+\])+/g, " ").trim();
  }
  function compileComments(rules) {
    const users = /* @__PURE__ */ new Set();
    for (const name of ruleLines(rules.users)) {
      const key = lc(name);
      if (key) users.add(key);
    }
    return { kw: compileLines(rules.keywords), userKw: compileLines(rules.userKeywords), users, rules };
  }
  function matchComment(c, isSub, cc) {
    const r = cc.rules;
    if (!r.enabled) return null;
    if (r.allowUp && c.upMid != null && c.mid != null && String(c.mid) === String(c.upMid)) return null;
    if (r.allowPin && !isSub && c.isUpTop) return null;
    if (r.allowMe && c.me && (c.uname === c.me || c.message.includes(`@${c.me}`))) return null;
    if (c.uname && cc.users.has(lc(c.uname))) return `评论用户:${c.uname}`;
    if (c.uname && textHit(c.uname, cc.userKw)) return "评论昵称词";
    const clean = cleanComment(c.message, isSub);
    if (textHit(clean, cc.kw)) return "评论关键词";
    if (r.minLevel > 0 && c.level != null && c.level < r.minLevel) return `评论等级<${r.minLevel}`;
    if (r.hideNoFace && c.noface) return "默认头像非会员";
    if (r.hideBot && c.uname && COMMENT_BOTS.has(c.uname)) return "AI机器人";
    if (r.hideCallBot && c.members.some((m) => !!(m && m.uname && COMMENT_BOTS.has(m.uname)))) return "召唤AI";
    if (r.hideAd && COMMENT_AD_RE.test(c.message)) return "带货评论";
    if (r.hideCallOnly && c.message.replace(/@[^@\s]+/g, " ").trim() === "") return "纯@评论";
    if (r.hideEmojiOnly && clean.replace(EMOJI_RE2, "").trim() === "") return "纯表情评论";
    return null;
  }
  var PH_CLASS = "zbb-cmt-ph";
  function renderPlaceholder(ph, host, reason) {
    const expanded = !!host.__cmtExpanded;
    const txt = ph.querySelector(".zbb-ph-txt");
    const act = ph.querySelector(".zbb-ph-act");
    if (txt) txt.textContent = `${expanded ? "已展开" : "已折叠"} · 命中：${reason}`;
    if (act) act.textContent = expanded ? "点击收起 ▴" : "点击展开 ▾";
    host.style.display = expanded ? "" : "none";
  }
  function collapseComment(host, reason) {
    host.__cmtHit = reason;
    if (host.__cmtPh && host.__cmtPh.isConnected) {
      renderPlaceholder(host.__cmtPh, host, reason);
      return;
    }
    const parent = host.parentNode;
    if (!parent) {
      host.style.display = "none";
      return;
    }
    const ph = document.createElement("div");
    ph.className = PH_CLASS;
    ph.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:8px",
      "margin:4px 0",
      "padding:6px 10px",
      "border-radius:8px",
      "background:rgba(251,114,153,.08)",
      "border:1px dashed rgba(251,114,153,.45)",
      "font-size:12px",
      "color:#9499a0",
      "cursor:pointer",
      "user-select:none",
      "line-height:1.5"
    ].join(";");
    ph.innerHTML = '<span class="zbb-ph-txt" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span><span class="zbb-ph-act" style="color:#fb7299;flex:none"></span>';
    ph.addEventListener("click", () => {
      host.__cmtExpanded = !host.__cmtExpanded;
      renderPlaceholder(ph, host, reason);
    });
    parent.insertBefore(ph, host);
    host.__cmtPh = ph;
    renderPlaceholder(ph, host, reason);
  }
  function installCommentFilter(opts) {
    const doc = opts.doc ?? document;
    const roots = /* @__PURE__ */ new Set();
    let stopped = false;
    const scanRoot = (root) => {
      if (stopped) return;
      const cc = opts.getRules();
      if (!cc.rules.enabled) return;
      const tags = Object.keys(COMMENT_TAGS).join(",");
      root.querySelectorAll(tags).forEach((el) => evaluateHost(el));
    };
    const evaluateHost = (host) => {
      if (stopped) return;
      const cc = opts.getRules();
      if (!cc.rules.enabled) return;
      const isSub = COMMENT_TAGS[host.tagName] === true;
      const info = readCmt(host);
      const reason = matchComment(info, isSub, cc);
      if (!reason) {
        if (host.__cmtHit) {
          host.__cmtHit = null;
          host.__cmtExpanded = false;
          host.style.display = "";
          host.__cmtPh?.remove();
          host.__cmtPh = null;
        }
        return;
      }
      if (host.__cmtHit === reason) return;
      collapseComment(host, reason);
      opts.onHit?.(info.uname, reason);
    };
    const scanAll = () => {
      for (const root of roots) scanRoot(root);
    };
    const observer = new MutationObserver(() => scanAll());
    const watchRoot = (root) => {
      if (roots.has(root)) return;
      roots.add(root);
      try {
        observer.observe(root, { childList: true, subtree: true });
      } catch {
      }
      scanRoot(root);
    };
    const win2 = doc.defaultView;
    const ElementCtor = win2 && win2.Element || (typeof Element !== "undefined" ? Element : void 0);
    const proto = ElementCtor?.prototype;
    const orig = proto?.attachShadow;
    if (proto && typeof orig === "function" && !orig.__zbb) {
      const patched = function(init) {
        const root = orig.call(this, init);
        try {
          if (isCommentTag(this.tagName)) watchRoot(root);
        } catch {
        }
        return root;
      };
      patched.__zbb = true;
      proto.attachShadow = patched;
    }
    doc.querySelectorAll(Object.keys(COMMENT_TAGS).join(",")).forEach((el) => {
      const host = el;
      evaluateHost(host);
      if (el.shadowRoot) watchRoot(el.shadowRoot);
    });
    return {
      rescan: scanAll,
      stop: () => {
        stopped = true;
        observer.disconnect();
        roots.clear();
      }
    };
  }

  // src/core/store.ts
  var SETTINGS_KEY = "zbb:settings";
  var BACKUP_KEY = "zbb:settings-backups";
  var BACKUP_MAX = 5;
  function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }
  function unwrapSettings(raw, defaults) {
    if (!raw || typeof raw !== "object") return { rev: 0, data: defaults };
    const obj = raw;
    if (typeof obj.rev === "number" && isPlainObject(obj.data)) {
      return { rev: obj.rev, data: mergeSettings(defaults, obj.data) };
    }
    return { rev: 0, data: mergeSettings(defaults, obj) };
  }
  function mergeSettings(base, patch) {
    if (!isPlainObject(patch)) return base;
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (value === void 0) continue;
      const prev = out[key];
      out[key] = isPlainObject(prev) && isPlainObject(value) ? mergeSettings(prev, value) : value;
    }
    return out;
  }
  function createSettingsStore(io, defaults, now = () => Date.now()) {
    let queue = Promise.resolve();
    function serialize(fn) {
      const next = queue.then(fn, fn);
      queue = next.catch(() => void 0);
      return next;
    }
    async function read() {
      return unwrapSettings(await io.get(SETTINGS_KEY), defaults);
    }
    async function saveBackup(env) {
      const raw = await io.get(BACKUP_KEY);
      const list = Array.isArray(raw) ? raw : [];
      list.unshift({ at: now(), data: env.data });
      await io.set(BACKUP_KEY, list.slice(0, BACKUP_MAX));
    }
    return {
      read,
      patch(patch) {
        return serialize(async () => {
          const current = await read();
          const data = mergeSettings(current.data, patch);
          await saveBackup(current);
          const next = { rev: current.rev + 1, data };
          await io.set(SETTINGS_KEY, next);
          return next;
        });
      },
      async backups() {
        const raw = await io.get(BACKUP_KEY);
        return Array.isArray(raw) ? raw : [];
      },
      async restore(index) {
        const list = await io.get(BACKUP_KEY);
        if (!Array.isArray(list) || !list[index]) return null;
        const env = await read();
        await saveBackup(env);
        const next = { rev: env.rev + 1, data: list[index].data };
        await io.set(SETTINGS_KEY, next);
        return next;
      }
    };
  }

  // src/core/preload.ts
  var PRELOADED = /* @__PURE__ */ new Set();
  var MAX_REMEMBER = 400;
  function originalUrl(src) {
    if (!src || !/hdslb\.com/.test(src)) return null;
    const base = src.split("@")[0];
    if (!base) return null;
    return base.replace(/\/\/i\d\.hdslb\.com\//, "//i0.hdslb.com/");
  }
  function installCommentImagePreload(opts) {
    const doc = opts.doc ?? document;
    const limit = opts.maxConcurrent ?? 2;
    let active = 0;
    const queue = [];
    const pump = () => {
      while (active < limit && queue.length) {
        const url = queue.shift();
        active += 1;
        const img = new Image();
        const done = () => {
          active -= 1;
          pump();
        };
        img.onload = done;
        img.onerror = done;
        img.src = url;
      }
    };
    const preload = (url) => {
      if (!opts.enabled()) return;
      if (PRELOADED.has(url)) return;
      if (PRELOADED.size >= MAX_REMEMBER) PRELOADED.clear();
      PRELOADED.add(url);
      queue.push(url);
      pump();
    };
    const io = typeof IntersectionObserver === "function" ? new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const img = entry.target;
          const url = originalUrl(img.currentSrc || img.src);
          if (url) preload(url);
          io.unobserve(img);
        }
      },
      { rootMargin: "200px" }
    ) : null;
    const observe = (root) => {
      if (!io) return;
      root.querySelectorAll("img").forEach((img) => {
        const src = img.currentSrc || img.src;
        if (src && /hdslb\.com/.test(src) && /new_dyn|bfs\//.test(src)) io.observe(img);
      });
    };
    const roots = /* @__PURE__ */ new Set();
    const watch = (root) => {
      if (roots.has(root)) return;
      roots.add(root);
      observe(root);
      try {
        const mo = new MutationObserver((muts) => {
          for (const m of muts) {
            for (const n of m.addedNodes) {
              if (n.nodeType === 1) observe(n);
            }
          }
        });
        mo.observe(root, { childList: true, subtree: true });
      } catch {
      }
    };
    const proto = doc.defaultView?.Element?.prototype;
    const orig = proto?.attachShadow;
    if (proto && typeof orig === "function" && !orig.__zbbPreload) {
      const patched = function(init) {
        const root = orig.call(this, init);
        try {
          if (/COMMENT/i.test(this.tagName)) watch(root);
        } catch {
        }
        return root;
      };
      patched.__zbbPreload = true;
      proto.attachShadow = patched;
    }
    doc.querySelectorAll("bili-comment-thread-renderer, bili-comment-reply-renderer, bili-comments").forEach((el) => {
      if (el.shadowRoot) watch(el.shadowRoot);
    });
    return () => {
      io?.disconnect();
      roots.clear();
      queue.length = 0;
    };
  }

  // src/core/hotparse.ts
  function pickTitles(json) {
    const root = json;
    const data = root?.data ?? root?.items ?? root?.result;
    if (!Array.isArray(data)) return [];
    const out = [];
    for (const item of data) {
      const node = item;
      const title = node?.target?.title ?? node?.target?.title?.area?.title ?? node?.title ?? node?.name ?? "";
      if (typeof title === "string" && title.trim()) out.push(title.trim());
    }
    return out;
  }
  function parseRss(text) {
    try {
      const json = JSON.parse(text);
      const items = json.items ?? json.data;
      if (Array.isArray(items)) {
        return items.map((item) => item?.title).filter((t) => typeof t === "string" && t.trim() !== "").map((t) => t.trim());
      }
    } catch {
    }
    const out = [];
    const re = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const title = match[1].trim();
      if (title) out.push(title);
    }
    return out.length > 1 ? out.slice(1) : out;
  }

  // src/core/ups.ts
  function parseUpsFile(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return [];
    }
    const entries = json?.entries;
    if (!Array.isArray(entries)) return [];
    const out = [];
    for (const raw of entries) {
      const mid = Number(raw?.mid);
      if (!Number.isFinite(mid) || mid <= 0) continue;
      const name = String(raw?.name ?? "").slice(0, 60);
      out.push({ mid, name, source: "auto" });
    }
    return out;
  }
  function mergeUps(current, remote) {
    const manual = current.filter((e) => e.source === "manual");
    const byMid = /* @__PURE__ */ new Map();
    for (const entry of manual) byMid.set(entry.mid, entry);
    for (const entry of remote) {
      if (!byMid.has(entry.mid)) byMid.set(entry.mid, entry);
    }
    return [...byMid.values()];
  }

  // src/core/pool.ts
  var DAY = 24 * 60 * 60 * 1e3;
  function mergePool(current, incoming, now) {
    const byKey = /* @__PURE__ */ new Map();
    for (const entry of current) {
      const key = normalize(entry.title);
      if (key) byKey.set(key, entry);
    }
    for (const item of incoming) {
      const key = normalize(item.title);
      if (!key) continue;
      const existing = byKey.get(key);
      if (existing) {
        existing.lastSeen = Math.max(existing.lastSeen, now);
      } else {
        byKey.set(key, { title: item.title, firstSeen: now, lastSeen: now, origin: item.origin });
      }
    }
    return [...byKey.values()];
  }
  function prunePool(entries, now, opts = {}) {
    const maxAgeDays = opts.maxAgeDays ?? 30;
    const maxEntries = opts.maxEntries ?? 12e3;
    const cutoff = now - maxAgeDays * DAY;
    const alive = entries.filter((e) => e.lastSeen >= cutoff);
    if (alive.length <= maxEntries) return alive;
    return [...alive].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, maxEntries);
  }
  function replaceOrigin(entries, origin, incoming, now) {
    const kept = entries.filter((e) => e.origin !== origin);
    const added = incoming.map((title) => ({
      title,
      firstSeen: now,
      lastSeen: now,
      origin
    }));
    return mergePool(kept, added, now);
  }
  function splitByFreshness(entries, now, staleDays = 7) {
    const cutoff = now - staleDays * DAY;
    const fresh = [];
    const stale = [];
    for (const entry of entries) {
      if (entry.lastSeen >= cutoff) fresh.push(entry);
      else stale.push(entry);
    }
    return { fresh, stale };
  }
  function parseSeed(text, maxLines = 2e4, maxLength = 120) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const line of text.split(/\r?\n/)) {
      const title = line.trim();
      if (!title || title.startsWith("#")) continue;
      if (title.length > maxLength) continue;
      if (/[<>]/.test(title) || /^https?:\/\//i.test(title)) continue;
      const key = normalize(title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(title);
      if (out.length >= maxLines) break;
    }
    return out;
  }

  // src/core/types.ts
  var DEFAULT_SETTINGS = {
    enabled: true,
    // 默认落在「保守」：体检数据显示 1.00 分那批几乎都是原样照搬，
    // 而 0.85 以下开始出现改写，默认值宁可少拦也别误伤。
    threshold: 0.86,
    minLen: 8,
    whitelist: [],
    refreshMinutes: 45,
    // raw.githubusercontent 在国内多数网络访问不了，所以走两个镜像：
    //   gh-proxy 无缓存、能立刻拿到最新；jsDelivr 边缘缓存 12h，胜在稳定
    remoteSeedUrls: [
      "https://gh-proxy.com/https://raw.githubusercontent.com/ConspiracyThorist/zhihu-bili-blocker/main/data/seed.txt",
      "https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker@main/seed.txt"
    ],
    poolDays: 30,
    poolMax: 12e3,
    rsshub: "",
    upBlockEnabled: true,
    remoteUpsUrls: [
      "https://gh-proxy.com/https://raw.githubusercontent.com/ConspiracyThorist/zhihu-bili-blocker/main/data/ups.json",
      "https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker@main/ups.json"
    ],
    // 静默贡献：只在用户手动拉黑时上报 mid，不带任何标识
    contributeUps: true,
    // 只保留国内端点：Cloudflare 的 workers.dev 在国内被 DNS 污染，留着只会白等超时。
    upsEndpoints: ["https://zbb-ups-nwwblkigcf.cn-hangzhou.fcapp.run"],
    // 规则默认全空：装了不配也能用，只靠知乎题库这一路生效
    rules: DEFAULT_RULES,
    // 评论过滤默认关：它依赖 B 站组件内部数据结构，默认不开启更稳妥
    comments: DEFAULT_COMMENT_RULES,
    preloadCommentImages: true
  };
  var MODES = [
    { id: "conservative", name: "保守", threshold: 0.86, hint: "只拦照搬" },
    { id: "standard", name: "标准", threshold: 0.78, hint: "多数搬运" },
    { id: "aggressive", name: "激进", threshold: 0.66, hint: "改写也拦" }
  ];
  function modeOf(threshold) {
    return MODES.find((m) => Math.abs(m.threshold - threshold) < 5e-3);
  }
  var KEYS = {
    settings: "zbb:settings",
    hot: "zbb:hot",
    records: "zbb:records",
    stats: "zbb:stats",
    ups: "zbb:ups",
    outbox: "zbb:outbox"
  };
  var RECORD_LIMIT = 50;
  var REMOTE_MAX_BYTES = 4 * 1024 * 1024;

  // src/core/rules/import.ts
  function strList(v) {
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim() !== "") : [];
  }
  function parseImport(raw) {
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, error: "不是合法的 JSON 文件", imported: 0, skipped: [] };
    }
    const root = json;
    if (!root || typeof root !== "object" || !root.config) {
      return { ok: false, error: "文件里没有 config 字段，可能不是规则导出文件", imported: 0, skipped: [] };
    }
    if (root.app && root.app !== "biliHoyoFairy") {
      return { ok: false, error: `不认识的来源：${root.app}`, imported: 0, skipped: [] };
    }
    const cfg = root.config;
    const block = cfg.block ?? {};
    const allow = cfg.allow ?? {};
    const cmt = cfg.comment ?? {};
    const skipped = [];
    const keywords = strList(block.keywords);
    const partitions = strList(block.partitions);
    const upNames = strList(block.upNames);
    const uids = strList(block.uids);
    const bvids = strList(block.bvids);
    const allowUpAsKw = strList(allow.upNames).map((n) => `up:${n}`);
    const allowKeywords = [...strList(allow.keywords), ...allowUpAsKw];
    const allowUids = strList(allow.uids);
    const rules = {
      keywords,
      partitions,
      upNames,
      uids,
      bvids,
      allowKeywords,
      allowUids,
      block: {
        minViews: Number(block.minViews ?? 0) || 0,
        maxViews: Number(block.maxViews ?? 0) || 0,
        minLikes: Number(block.minLikes ?? 0) || 0,
        maxLikes: Number(block.maxLikes ?? 0) || 0,
        spamLikeRatio: Number(block.spamLikeRatio ?? 0) || 0,
        spamMinViews: Number(block.spamMinViews ?? 10) || 10,
        minDuration: Number(block.minDuration ?? 0) || 0,
        maxDuration: Number(block.maxDuration ?? 0) || 0
      },
      hideAd: cfg.hideAd ?? false,
      hideLive: cfg.hideLiveCard ?? false,
      fuzzyMatch: cfg.fuzzyMatch !== false
    };
    const comments = {
      enabled: cmt.enabled ?? false,
      keywords: strList(cmt.keywords),
      users: strList(cmt.userNames),
      userKeywords: strList(cmt.userNameKeywords),
      minLevel: Number(cmt.minLevel ?? 0) || 0,
      hideNoFace: !!cmt.hideNoFace,
      hideEmojiOnly: !!cmt.hideEmojiOnly,
      hideCallOnly: !!cmt.hideCallOnly,
      hideAd: !!cmt.hideAd,
      hideCallBot: !!cmt.hideCallBot,
      hideBot: !!cmt.hideBot,
      allowUp: cmt.allowUp !== false,
      allowPin: cmt.allowPin !== false,
      allowMe: cmt.allowMe !== false
    };
    if (strList(block.tags).length) skipped.push("视频标签（需要联网取数据，本产品未实现）");
    if (strList(block.dualTags).length) skipped.push("组合标签（同上）");
    if (strList(block.upBio).length) skipped.push("UP 简介关键词（同上）");
    const imported = keywords.length + partitions.length + upNames.length + uids.length + bvids.length + allowKeywords.length + allowUids.length + comments.keywords.length + comments.users.length + comments.userKeywords.length;
    return { ok: true, patch: { rules, comments }, imported, skipped, source: root.app };
  }
  function buildExport(settings) {
    return JSON.stringify(
      { app: "BiliBlocker", version: 1, exportedAt: (/* @__PURE__ */ new Date()).toISOString(), config: { rules: settings.rules, comments: settings.comments } },
      null,
      2
    );
  }

  // src/core/panel.ts
  var STYLE_ID2 = "zbb-panel-style";
  var CSS = `
.zbb-panel{
  --bg:#16171a; --panel:#1b1c20; --surface:#22242a; --surface2:#272a31;
  --line:#2c2f36; --line-soft:#24272d;
  --text:#e9eaee; --text2:#a4a9b4; --text3:#71767f;
  --pink:#fb7299; --pink-dim:rgba(251,114,153,.14); --pink-line:rgba(251,114,153,.38);
  --green:#4cc38a; --blue:#5aa9e6;
  background:var(--panel); color:var(--text);
  font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
  display:flex; flex-direction:column; height:100%; box-sizing:border-box;
  -webkit-font-smoothing:antialiased;
}
.zbb-panel *{box-sizing:border-box}
.zbb-head{display:flex;align-items:center;gap:9px;padding:13px 15px 10px}
.zbb-logo{width:22px;height:22px;border-radius:7px;background:linear-gradient(160deg,#fb7299,#d4517a);display:grid;place-items:center;flex:none}
.zbb-logo svg{width:13px;height:13px}
.zbb-name{font-size:13px;font-weight:600;letter-spacing:.2px}
.zbb-state{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text3)}
.zbb-dot{width:5px;height:5px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(76,195,138,.12)}
.zbb-dot.off{background:var(--text3);box-shadow:none}
.zbb-spacer{flex:1}
.zbb-iconbtn{width:26px;height:26px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--text3);display:grid;place-items:center;cursor:pointer}
.zbb-iconbtn:hover{background:var(--surface);color:var(--text2)}
.zbb-seg{margin:0 15px 6px;padding:3px;background:#141518;border:1px solid var(--line-soft);border-radius:10px;display:grid;grid-template-columns:repeat(4,1fr);gap:2px}
.zbb-seg button{appearance:none;border:0;background:transparent;color:var(--text3);font:inherit;font-size:12px;padding:6px 0;border-radius:7px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px}
.zbb-seg button.on{background:var(--surface2);color:var(--text)}
.zbb-seg svg{width:12px;height:12px}
.zbb-body{flex:1;overflow:auto;padding:10px 15px 16px}
.zbb-body::-webkit-scrollbar{width:8px}
.zbb-body::-webkit-scrollbar-thumb{background:#2f323a;border-radius:8px}
.zbb-card{background:var(--surface);border:1px solid var(--line-soft);border-radius:12px;padding:12px 13px}
.zbb-card+.zbb-card{margin-top:9px}
.zbb-eyebrow{font-size:11px;color:var(--text3)}
.zbb-huge{font-variant-numeric:tabular-nums;font-size:29px;font-weight:650;line-height:1.15;margin:3px 0 2px}
.zbb-huge small{font-size:12px;font-weight:500;color:var(--text3);margin-left:5px}
.zbb-bar{height:6px;border-radius:6px;overflow:hidden;display:flex;gap:2px;margin:11px 0 8px;background:#2a2d34}
.zbb-bar i{display:block;height:100%}
.zbb-legend{display:flex;flex-wrap:wrap;gap:11px;font-size:11px;color:var(--text2)}
.zbb-legend span{display:flex;align-items:center;gap:5px}
.zbb-legend b{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums}
.zbb-sw{width:7px;height:7px;border-radius:2px}
.zbb-sect{display:flex;align-items:center;gap:8px;margin:15px 2px 7px}
.zbb-sect h4{margin:0;font-size:12px;font-weight:600;color:var(--text2)}
.zbb-sect .more{margin-left:auto;font-size:11px;color:var(--text3);cursor:pointer}
.zbb-hit{display:flex;gap:9px;padding:9px 1px;border-bottom:1px solid var(--line-soft)}
.zbb-hit:last-child{border-bottom:0}
.zbb-hit .ico{width:22px;height:22px;border-radius:6px;background:var(--pink-dim);display:grid;place-items:center;flex:none;margin-top:1px}
.zbb-hit .ico svg{width:11px;height:11px;stroke:var(--pink);fill:none;stroke-width:2.4;stroke-linecap:round}
.zbb-hit .txt{min-width:0;flex:1}
.zbb-hit .t{font-size:12.5px;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;cursor:pointer}
.zbb-hit:hover .t{-webkit-line-clamp:4}
.zbb-hit .meta{display:flex;align-items:center;gap:6px;margin-top:3px;font-size:11px;color:var(--text3);min-width:0;flex-wrap:wrap}
.zbb-tag{font-size:10.5px;padding:1px 6px;border-radius:5px;background:#2a2d34;color:var(--text2);white-space:nowrap}
.zbb-tag.zh{background:var(--pink-dim);color:#ffa8bf}
.zbb-tag.rule{background:rgba(90,169,230,.14);color:#8cc6f0}
.zbb-tag.up{background:rgba(229,165,75,.14);color:#e9bd7d}
.zbb-allow{appearance:none;border:1px solid var(--line);background:transparent;color:var(--text3);font:inherit;font-size:11px;padding:3px 8px;border-radius:7px;cursor:pointer;white-space:nowrap;align-self:center}
.zbb-allow:hover{border-color:var(--pink-line);color:var(--pink)}
.zbb-quick{display:flex;gap:7px}
.zbb-quick input{flex:1;min-width:0;background:#141518;border:1px solid var(--line);border-radius:9px;color:var(--text);font:inherit;font-size:12px;padding:7px 10px;outline:none}
.zbb-quick input:focus{border-color:var(--pink-line)}
.zbb-quick input::placeholder{color:#5f646d}
.zbb-btn{appearance:none;font:inherit;font-size:12px;padding:6px 11px;border-radius:8px;border:1px solid var(--line);background:var(--surface2);color:var(--text);cursor:pointer;white-space:nowrap}
.zbb-btn.pink{background:var(--pink);border-color:var(--pink);color:#2a0d15;font-weight:600}
.zbb-btn.ghost{background:transparent}
.zbb-btn.sm{padding:3px 9px;font-size:11.5px}
.zbb-hint{font-size:11px;color:var(--text3);margin:6px 2px 0}
.zbb-group{border:1px solid var(--line-soft);border-radius:11px;background:var(--surface);margin-top:8px;overflow:hidden}
.zbb-ghead{display:flex;align-items:center;gap:8px;padding:9px 11px;cursor:pointer;user-select:none}
.zbb-ghead .gname{font-size:12.5px;font-weight:600}
.zbb-ghead .count{font-size:10.5px;color:var(--text3);background:#2a2d34;border-radius:5px;padding:1px 6px;font-variant-numeric:tabular-nums}
.zbb-ghead .chev{margin-left:auto;color:var(--text3);font-size:11px}
.zbb-gbody{padding:0 11px 10px;display:flex;flex-wrap:wrap;gap:6px}
.zbb-gbody.block{display:block}
.zbb-chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;padding:3px 7px 3px 9px;border-radius:7px;background:var(--surface2);border:1px solid var(--line);color:var(--text2)}
.zbb-chip i{color:#5c616a;font-style:normal;cursor:pointer;font-size:12px;line-height:1}
.zbb-chip i:hover{color:var(--pink)}
.zbb-empty{color:#5f646d;font-size:11.5px;padding:2px 0}
.zbb-row{display:flex;align-items:center;gap:10px;padding:9px 1px;border-bottom:1px solid var(--line-soft)}
.zbb-row:last-child{border-bottom:0}
.zbb-row .label{font-size:12.5px}
.zbb-row .desc{font-size:11px;color:var(--text3);margin-top:1px}
.zbb-tgl{width:34px;height:19px;border-radius:999px;background:#3a3e46;position:relative;flex:none;cursor:pointer;border:0;padding:0}
.zbb-tgl::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#e9eaee;transition:transform .15s}
.zbb-tgl.on{background:var(--pink)}
.zbb-tgl.on::after{transform:translateX(15px);background:#fff}
.zbb-modes{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}
.zbb-mode{border:1px solid var(--line);border-radius:9px;padding:7px 5px;text-align:center;cursor:pointer;background:#1e2025;color:var(--text)}
.zbb-mode.on{border-color:var(--pink-line);background:var(--pink-dim)}
.zbb-mode b{display:block;font-size:12px}
.zbb-mode span{display:block;font-size:10.5px;color:var(--text3);margin-top:1px;font-variant-numeric:tabular-nums}
.zbb-foot{padding:8px 15px;border-top:1px solid var(--line-soft);display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text3)}
.zbb-num{font-variant-numeric:tabular-nums}
.zbb-hidden{display:none!important}
`;
  var ICONS = {
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6l7-3z"/></svg>',
    overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="11" width="7" height="10" rx="1.5"/><rect x="3" y="15" width="7" height="6" rx="1.5"/></svg>',
    log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    rules: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h11M19 7h1M4 17h5M13 17h7"/><circle cx="17" cy="7" r="2.2"/><circle cx="11" cy="17" r="2.2"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/></svg>',
    x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    cross: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };
  var TABS = [
    { id: "overview", name: "概览", icon: ICONS.overview },
    { id: "log", name: "拦截", icon: ICONS.log },
    { id: "rules", name: "规则", icon: ICONS.rules },
    { id: "settings", name: "设置", icon: ICONS.settings }
  ];
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function fmtAgo(at) {
    if (!at) return "从未同步";
    const diff = Date.now() - at;
    if (diff < 6e4) return "刚刚同步";
    if (diff < 36e5) return `${Math.floor(diff / 6e4)} 分钟前同步`;
    if (diff < 864e5) return `${Math.floor(diff / 36e5)} 小时前同步`;
    return `${Math.floor(diff / 864e5)} 天前同步`;
  }
  function bucket(rec) {
    if (rec.reason === "rule") return "rule";
    if (rec.reason === "exact" || rec.reason === "contain" || rec.reason === "dice" || rec.reason === "cover") return "zhihu";
    return "other";
  }
  function tagOf(rec) {
    if (rec.reason === "rule") return { cls: "rule", text: rec.detail ? rec.detail.split(":")[0] : "规则" };
    if (bucket(rec) === "zhihu") return { cls: "zh", text: "知乎题库" };
    return { cls: "up", text: "UP 库" };
  }
  function mountPanel(opts) {
    const doc = opts.mount.ownerDocument ?? document;
    if (!doc.getElementById(STYLE_ID2)) {
      const style = doc.createElement("style");
      style.id = STYLE_ID2;
      style.textContent = CSS;
      (doc.head ?? doc.documentElement).appendChild(style);
    }
    const root = doc.createElement("div");
    root.className = "zbb-panel";
    root.setAttribute("data-zbb-panel", "1");
    root.innerHTML = `
    <div class="zbb-head">
      <div class="zbb-logo">${ICONS.shield}</div>
      <div class="zbb-name">BiliBlocker</div>
      <div class="zbb-state"><span class="zbb-dot"></span><span class="zbb-state-t">运行中</span></div>
      <div class="zbb-spacer"></div>
      <button class="zbb-iconbtn" data-act="close" title="关闭">${ICONS.x}</button>
    </div>
    <div class="zbb-seg">
      ${TABS.map((t) => `<button data-tab="${t.id}">${t.icon}${t.name}</button>`).join("")}
    </div>
    <div class="zbb-body"><div data-pane="overview"></div><div data-pane="log" class="zbb-hidden"></div><div data-pane="rules" class="zbb-hidden"></div><div data-pane="settings" class="zbb-hidden"></div></div>
    <div class="zbb-foot"><span class="zbb-num">BiliBlocker v1.0.2</span><span class="zbb-spacer"></span><span>网络层 + DOM 兜底</span></div>
  `;
    opts.mount.appendChild(root);
    let active = "overview";
    const pane = (id) => root.querySelector(`[data-pane="${id}"]`);
    const setTab = (id) => {
      active = id;
      root.querySelectorAll(".zbb-seg button").forEach((b) => {
        b.classList.toggle("on", b.dataset.tab === id);
      });
      for (const t of TABS) pane(t.id).classList.toggle("zbb-hidden", t.id !== id);
      renderActive();
    };
    const patchRules = (patch) => {
      const st = opts.getState();
      opts.onPatch({ rules: { ...st.settings.rules, ...patch } });
    };
    const patchComments = (patch) => {
      const st = opts.getState();
      opts.onPatch({ comments: { ...st.settings.comments, ...patch } });
    };
    const renderOverview = (st) => {
      const counts = { zhihu: 0, rule: 0, other: 0 };
      for (const r of st.records) counts[bucket(r)] += 1;
      const sum = Math.max(1, counts.zhihu + counts.rule + counts.other);
      const pct = (n) => `${Math.round(n / sum * 100)}%`;
      const recent = st.records.slice(0, 3);
      const cur = st.current;
      return `
      ${cur ? `<div class="zbb-card" style="border-color:var(--pink-line)">
        <div class="zbb-eyebrow">正在看</div>
        <div style="font-size:13px;line-height:1.5;margin:5px 0 8px">${esc(cur.title)}</div>
        <div class="zbb-row" style="border:0;padding:0">
          <span class="zbb-num" style="color:var(--text2)">${esc(cur.up || "未知 UP")}</span>
          <span class="zbb-spacer"></span>
          ${cur.uid ? `<button class="zbb-btn pink sm" data-act="block-up" data-uid="${esc(cur.uid)}" data-name="${esc(cur.up)}">屏蔽此 UP</button>` : ""}
        </div>
      </div>` : ""}
      <div class="zbb-card">
        <div class="zbb-eyebrow">累计拦截</div>
        <div class="zbb-huge">${st.total}<small>条</small></div>
        <div class="zbb-bar">
          <i style="width:${pct(counts.zhihu)};background:var(--pink)"></i>
          <i style="width:${pct(counts.rule)};background:var(--blue)"></i>
          <i style="width:${pct(counts.other)};background:#e5a54b"></i>
        </div>
        <div class="zbb-legend">
          <span><i class="zbb-sw" style="background:var(--pink)"></i>知乎搬运 <b>${counts.zhihu}</b></span>
          <span><i class="zbb-sw" style="background:var(--blue)"></i>规则命中 <b>${counts.rule}</b></span>
          <span><i class="zbb-sw" style="background:#e5a54b"></i>其它 <b>${counts.other}</b></span>
        </div>
        <div class="zbb-hint">来源分布取最近 ${st.records.length} 条记录</div>
      </div>
      <div class="zbb-sect"><h4>最近拦截</h4><span class="more" data-act="tab-log">全部 →</span></div>
      <div class="zbb-card" style="padding:2px 13px">${recent.length ? recent.map(hitRow).join("") : '<div class="zbb-empty">还没有拦截记录</div>'}</div>
      <div class="zbb-sect"><h4>题库</h4></div>
      <div class="zbb-card">
        <div class="zbb-row" style="border:0;padding:0">
          <div><div style="font-weight:600" class="zbb-num">${st.poolCount} 条</div><div class="desc">${esc(fmtAgo(st.poolAt))}</div></div>
          <div class="zbb-spacer"></div>
          <button class="zbb-btn sm ghost" data-act="sync">立即同步</button>
        </div>
        ${st.poolError ? `<div class="zbb-hint">上次失败：${esc(st.poolError)}</div>` : ""}
      </div>`;
    };
    const hitRow = (rec) => {
      const tag = tagOf(rec);
      const raw = rec.reason === "rule" ? rec.detail ?? "" : "";
      const why = rec.reason === "rule" ? raw.includes(":") ? raw.replace(/^[^:]*:/, "") : "" : `${rec.score.toFixed(2)} ${rec.reason}`;
      return `
      <div class="zbb-hit">
        <div class="ico">${ICONS.cross}</div>
        <div class="txt">
          <div class="t">${esc(rec.biliTitle)}</div>
          <div class="meta"><span class="zbb-tag ${tag.cls}">${esc(tag.text)}</span><span class="zbb-num">${esc(why)}</span></div>
        </div>
        <button class="zbb-allow" data-act="open" data-key="${esc(rec.biliTitle)}" title="在 B 站搜索这条标题">打开</button>
        <button class="zbb-allow" data-act="allow" data-key="${esc(rec.biliTitle)}">放行</button>
      </div>`;
    };
    const renderLog = (st) => {
      if (!st.records.length) return '<div class="zbb-card"><div class="zbb-empty">还没有拦截记录。刷新 B 站首页试试。</div></div>';
      return `<div class="zbb-card" style="padding:2px 13px">${st.records.map(hitRow).join("")}</div>`;
    };
    const chips = (list, group2) => list.length ? list.map((v, i) => `<span class="zbb-chip">${esc(v)}<i data-act="del" data-group="${group2}" data-i="${i}">×</i></span>`).join("") : '<span class="zbb-empty">还没有</span>';
    const group = (id, name, body, count) => `
    <div class="zbb-group" data-group-box="${id}">
      <div class="zbb-ghead" data-act="toggle-group" data-group="${id}">
        <span class="gname">${name}</span>${count != null ? `<span class="count">${count}</span>` : ""}<span class="chev">⌄</span>
      </div>
      <div class="zbb-gbody" data-group-body="${id}">${body}</div>
    </div>`;
    const numRow = (label, key, value, unit) => `
    <div class="zbb-row"><span class="label">${label}</span><span class="zbb-spacer"></span>
      <input class="zbb-num" data-num="${key}" value="${value}" style="width:56px;text-align:right;background:#141518;border:1px solid var(--line);border-radius:7px;color:var(--text);padding:3px 7px;font:inherit;font-size:12px">${unit}
    </div>`;
    const renderRules = (st) => {
      const r = st.settings.rules;
      return `
      <div class="zbb-quick">
        <input id="zbb-quick-input" placeholder="粘贴标题 / BV 号 / UP 名 / 正则…">
        <button class="zbb-btn pink" data-act="quick-add">添加</button>
      </div>
      <div class="zbb-hint">自动识别：BV 号 → 单视频，纯数字 → UID，/…/ → 正则，其余按标题关键词</div>
      ${group("keywords", "标题关键词", chips(r.keywords, "keywords"), r.keywords.length)}
      ${group("upNames", "UP 主名", chips(r.upNames, "upNames"), r.upNames.length)}
      ${group("uids", "UID", chips(r.uids, "uids"), r.uids.length)}
      ${group("bvids", "BV 号", chips(r.bvids, "bvids"), r.bvids.length)}
      ${group("partitions", "分区", chips(r.partitions, "partitions"), r.partitions.length)}
      ${group("allowKeywords", "白名单", chips(r.allowKeywords, "allowKeywords"), r.allowKeywords.length)}
      ${group(
        "thresholds",
        "数值阈值",
        `<div class="zbb-gbody block" style="padding:0">
          ${numRow("播放少于", "minViews", r.block.minViews, "万")}
          ${numRow("播放多于", "maxViews", r.block.maxViews, "万")}
          ${numRow("点赞少于", "minLikes", r.block.minLikes, "个")}
          ${numRow("时长少于", "minDuration", r.block.minDuration, "秒")}
          ${numRow("时长多于", "maxDuration", r.block.maxDuration, "秒")}
          ${numRow("营销号赞率低于", "spamLikeRatio", r.block.spamLikeRatio, "%")}
         </div>`
      )}
      ${group(
        "cardTypes",
        "卡片类型",
        `<div class="zbb-gbody block" style="padding:0">
          <div class="zbb-row"><span class="label">广告 / 推广卡</span><span class="zbb-spacer"></span><button class="zbb-tgl ${r.hideAd ? "on" : ""}" data-act="toggle-rule" data-key="hideAd"></button></div>
          <div class="zbb-row"><span class="label">信息流直播卡</span><span class="zbb-spacer"></span><button class="zbb-tgl ${r.hideLive ? "on" : ""}" data-act="toggle-rule" data-key="hideLive"></button></div>
         </div>`
      )}
      ${group(
        "comments",
        "评论区过滤",
        `<div class="zbb-gbody block" style="padding:0">
          <div class="zbb-row"><span class="label">启用评论区过滤</span><span class="zbb-spacer"></span><button class="zbb-tgl ${st.settings.comments.enabled ? "on" : ""}" data-act="toggle-cmt" data-key="enabled"></button></div>
          <div class="zbb-row"><span class="label">AI 总结机器人</span><span class="zbb-spacer"></span><button class="zbb-tgl ${st.settings.comments.hideBot ? "on" : ""}" data-act="toggle-cmt" data-key="hideBot"></button></div>
          <div class="zbb-row"><span class="label">默认头像 / 非会员</span><span class="zbb-spacer"></span><button class="zbb-tgl ${st.settings.comments.hideNoFace ? "on" : ""}" data-act="toggle-cmt" data-key="hideNoFace"></button></div>
          <div class="zbb-row"><span class="label">带货导流评论</span><span class="zbb-spacer"></span><button class="zbb-tgl ${st.settings.comments.hideAd ? "on" : ""}" data-act="toggle-cmt" data-key="hideAd"></button></div>
          <div class="zbb-row"><span class="label">纯表情 / 纯 @</span><span class="zbb-spacer"></span><button class="zbb-tgl ${st.settings.comments.hideEmojiOnly ? "on" : ""}" data-act="toggle-cmt" data-key="hideEmojiOnly"></button></div>
         </div>`
      )}`;
    };
    const renderSettings = (st) => {
      const s = st.settings;
      const modes = [
        { id: "conservative", name: "保守", n: 0.86 },
        { id: "standard", name: "标准", n: 0.78 },
        { id: "aggressive", name: "激进", n: 0.66 }
      ];
      return `
      <div class="zbb-card">
        <div class="zbb-eyebrow">知乎搬运匹配强度</div>
        <div class="zbb-modes">
          ${modes.map(
        (m) => `<button class="zbb-mode ${Math.abs(s.threshold - m.n) < 5e-3 ? "on" : ""}" data-act="mode" data-n="${m.n}"><b>${m.name}</b><span>${m.n}</span></button>`
      ).join("")}
        </div>
        <div class="zbb-hint">只影响「知乎题库」这一路；关键词与 UP 规则不受影响。</div>
      </div>
      <div class="zbb-sect"><h4>通用</h4></div>
      <div class="zbb-card" style="padding:2px 13px">
        <div class="zbb-row"><div><div class="label">启用拦截</div></div><span class="zbb-spacer"></span><button class="zbb-tgl ${s.enabled ? "on" : ""}" data-act="toggle" data-key="enabled"></button></div>
        <div class="zbb-row"><div><div class="label">UP 库整号屏蔽</div></div><span class="zbb-spacer"></span><button class="zbb-tgl ${s.upBlockEnabled ? "on" : ""}" data-act="toggle" data-key="upBlockEnabled"></button></div>
        <div class="zbb-row"><div><div class="label">匿名贡献 UP 编号</div><div class="desc">只上传 mid 与昵称</div></div><span class="zbb-spacer"></span><button class="zbb-tgl ${s.contributeUps ? "on" : ""}" data-act="toggle" data-key="contributeUps"></button></div>
        <div class="zbb-row"><div><div class="label">评论区大图预加载</div><div class="desc">滚进视口就缓存原图，点开秒开；会多花一点流量</div></div><span class="zbb-spacer"></span><button class="zbb-tgl ${s.preloadCommentImages !== false ? "on" : ""}" data-act="toggle" data-key="preloadCommentImages"></button></div>
      </div>
      <div class="zbb-sect"><h4>题库同步</h4></div>
      <div class="zbb-card" style="padding:2px 13px">
        <div class="zbb-row"><div><div class="label">保留天数</div></div><span class="zbb-spacer"></span><span class="zbb-num">${s.poolDays} 天</span></div>
        <div class="zbb-row"><div><div class="label">条目上限</div></div><span class="zbb-spacer"></span><span class="zbb-num">${s.poolMax}</span></div>
        <div class="zbb-row"><div><div class="label">当前题库</div></div><span class="zbb-spacer"></span><span class="zbb-num">${st.poolCount} 条</span></div>
        <div class="zbb-row" style="padding-bottom:6px"><div><div class="label">远端题库源</div></div><span class="zbb-spacer"></span></div>
        <input id="zbb-seed-url" value="${esc(s.remoteSeedUrls[0] ?? "")}" placeholder="留空则不启用远端题库"
          style="width:100%;margin:2px 0 10px;background:#141518;border:1px solid var(--line);border-radius:8px;color:var(--text);font:inherit;font-size:11.5px;padding:6px 8px;outline:none">
        <div class="zbb-row" style="border:0;padding:0 0 10px">
          <button class="zbb-btn sm ghost" data-act="refresh">刷新热榜</button>
          <span class="zbb-spacer"></span>
          <button class="zbb-btn sm ghost" data-act="sync">同步题库</button>
        </div>
      </div>
      <div class="zbb-sect"><h4>数据</h4></div>
      <div class="zbb-card">
        <div class="zbb-row" style="border:0;padding:0 0 8px">
          <button class="zbb-btn sm ghost" data-act="import">导入规则文件</button>
          <span class="zbb-spacer"></span>
          <button class="zbb-btn sm ghost" data-act="export">导出配置</button>
        </div>
        <div class="zbb-hint" id="zbb-import-msg">支持 biliHoyoFairy 导出的 JSON，导入只覆盖规则，不动题库与统计</div>
        <input type="file" id="zbb-import-file" accept="application/json,.json" class="zbb-hidden">
      </div>`;
    };
    const renderActive = () => {
      const st = opts.getState();
      const dot = root.querySelector(".zbb-dot");
      const stateText = root.querySelector(".zbb-state-t");
      dot?.classList.toggle("off", !st.settings.enabled);
      if (stateText) stateText.textContent = st.settings.enabled ? "运行中" : "已暂停";
      const html = active === "overview" ? renderOverview(st) : active === "log" ? renderLog(st) : active === "rules" ? renderRules(st) : renderSettings(st);
      pane(active).innerHTML = html;
    };
    root.addEventListener("click", (event) => {
      const seg = event.target.closest(".zbb-seg button");
      if (seg?.dataset.tab) {
        setTab(seg.dataset.tab);
        return;
      }
      const el = event.target.closest("[data-act]");
      if (!el) return;
      const act = el.dataset.act;
      const st = opts.getState();
      if (act === "close") {
        opts.onClose?.();
        return;
      }
      if (act === "tab-log") {
        setTab("log");
        return;
      }
      if (act === "sync") {
        opts.onSyncSeed?.();
        return;
      }
      if (act === "refresh") {
        opts.onRefresh?.();
        return;
      }
      if (act === "open") {
        const key = el.dataset.key ?? "";
        if (key) {
          window.open(`https://search.bilibili.com/all?keyword=${encodeURIComponent(key)}`, "_blank", "noopener");
        }
        return;
      }
      if (act === "block-up") {
        const uid = el.dataset.uid ?? "";
        const name = el.dataset.name ?? "";
        if (uid) opts.onBlockUp?.(uid, name);
        return;
      }
      if (act === "import") {
        const input = root.querySelector("#zbb-import-file");
        input?.click();
        return;
      }
      if (act === "export") {
        const blob = new Blob([buildExport(st.settings)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `BiliBlocker-rules-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1e3);
        return;
      }
      if (act === "allow") {
        const key = el.dataset.key ?? "";
        const rec = st.records.find((r) => r.biliTitle === key);
        if (rec) opts.onAllow(rec);
        return;
      }
      if (act === "toggle") {
        const key = el.dataset.key;
        opts.onPatch({ [key]: !st.settings[key] });
        return;
      }
      if (act === "toggle-rule") {
        const key = el.dataset.key;
        patchRules({ [key]: !st.settings.rules[key] });
        return;
      }
      if (act === "toggle-cmt") {
        const key = el.dataset.key;
        patchComments({ [key]: !st.settings.comments[key] });
        return;
      }
      if (act === "mode") {
        opts.onPatch({ threshold: Number(el.dataset.n) });
        return;
      }
      if (act === "del") {
        const g = el.dataset.group;
        const i = Number(el.dataset.i);
        const list = [...st.settings.rules[g]];
        list.splice(i, 1);
        patchRules({ [g]: list });
        return;
      }
      if (act === "toggle-group") {
        const body = root.querySelector(`[data-group-body="${el.dataset.group}"]`);
        body?.classList.toggle("zbb-hidden");
        el.querySelector(".chev").textContent = body?.classList.contains("zbb-hidden") ? "›" : "⌄";
        return;
      }
      if (act === "quick-add") {
        const input = root.querySelector("#zbb-quick-input");
        const raw = (input?.value ?? "").trim();
        if (!raw) return;
        const next = {};
        if (/^BV[0-9A-Za-z]+$/.test(raw)) next.bvids = [...st.settings.rules.bvids, raw];
        else if (/^\d{2,}$/.test(raw)) next.uids = [...st.settings.rules.uids, raw];
        else next.keywords = [...st.settings.rules.keywords, raw];
        patchRules(next);
        if (input) input.value = "";
        return;
      }
    });
    root.addEventListener("change", (event) => {
      const target = event.target;
      if (target.id === "zbb-import-file") {
        const file = target.files?.[0];
        if (!file) return;
        void file.text().then((text) => {
          const res = parseImport(text);
          const msg = root.querySelector("#zbb-import-msg");
          if (!res.ok || !res.patch) {
            if (msg) msg.textContent = `导入失败：${res.error ?? "未知错误"}`;
            return;
          }
          opts.onPatch(res.patch);
          const skip = res.skipped.length ? `；跳过：${res.skipped.join("、")}` : "";
          setTimeout(() => {
            const el = root.querySelector("#zbb-import-msg");
            if (el) el.textContent = `已导入 ${res.imported} 条规则${skip}（已保存）`;
          }, 80);
        });
        return;
      }
      if (target.id === "zbb-seed-url") {
        const url = target.value.trim();
        opts.onPatch({ remoteSeedUrls: url ? [url] : [] });
        return;
      }
      const key = target.dataset?.num;
      if (!key) return;
      const value = Number(target.value) || 0;
      const st = opts.getState();
      patchRules({ block: { ...st.settings.rules.block, [key]: value } });
    });
    setTab("overview");
    return {
      refresh: renderActive,
      open: () => root.classList.remove("zbb-hidden"),
      close: () => root.classList.add("zbb-hidden"),
      isOpen: () => !root.classList.contains("zbb-hidden"),
      destroy: () => root.remove()
    };
  }

  // src/core/widget.ts
  var STYLE = `
:host { all: initial; }
.pill {
  position: fixed; right: 18px; top: 42%; z-index: 2147483640;
  display: flex; align-items: center; gap: 7px;
  padding: 7px 12px; border-radius: 999px;
  background: rgba(20, 22, 27, 0.72);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #d9dce2; font: 12px/1 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  cursor: grab; opacity: 0.62; transition: opacity .15s, border-color .15s;
  user-select: none; touch-action: none; white-space: nowrap;
}
.pill:hover { opacity: 1; border-color: rgba(255,255,255,.22); }
.pill.open { opacity: 1; }
.pill.dragging { transition: none; cursor: grabbing; opacity: 1; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: #fb7299; flex: none; }
.pill b { font-weight: 600; color: #fff; font-variant-numeric: tabular-nums; }
.sep { color: #6b7280; }

.panel {
  position: fixed; left: 0; top: 0; z-index: 2147483641;
  width: 300px; max-height: 46vh; overflow: auto;
  padding: 10px 12px; border-radius: 12px;
  background: rgba(20, 22, 27, 0.96);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
  color: #e8eaed; font: 12px/1.55 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.panel[hidden] { display: none; }
.head { display: flex; justify-content: space-between; align-items: center; color: #8b929e; margin-bottom: 8px; }
.head-right { display: flex; align-items: center; gap: 10px; }
.open-panel {
  border: 0; background: none; padding: 0; cursor: pointer;
  color: #fb7299; font: inherit; font-size: 11px;
}
.open-panel:hover { text-decoration: underline; }
.item { padding: 6px 0; border-top: 1px solid rgba(255,255,255,.07); }
.item:first-of-type { border-top: 0; padding-top: 0; }
.t { color: #e8eaed; word-break: break-all; }
.m { display: flex; align-items: center; gap: 6px; margin-top: 2px; color: #8b929e; font-size: 11px; }
.z { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s { color: #fb7299; font-variant-numeric: tabular-nums; }
.a { border: 0; background: none; color: #8b929e; font: inherit; font-size: 11px; cursor: pointer; padding: 0 2px; }
.a:hover { color: #4ade80; }
.empty { color: #8b929e; text-align: center; padding: 12px 0; }
.settings { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.07); }
.srow { display: flex; align-items: center; justify-content: space-between; color: #8b929e; }
.cb { accent-color: #fb7299; cursor: pointer; }
.modes { display: flex; gap: 6px; margin-top: 8px; }
.chip {
  flex: 1; padding: 5px 0; border-radius: 7px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.1); background: #16181d;
  color: #b9bfc9; font: inherit; font-size: 11px;
}
.chip:hover { border-color: rgba(255,255,255,.24); }
.chip.active { border-color: #fb7299; color: #fb7299; background: rgba(251,114,153,.1); }

.adv { margin-top: 8px; }
.adv > summary {
  cursor: pointer; color: #8b929e; font-size: 11px; list-style: none;
  display: flex; justify-content: space-between; align-items: center;
}
.adv > summary::-webkit-details-marker { display: none; }
.adv > summary::after { content: '展开'; }
.adv[open] > summary::after { content: '收起'; }
.adv-body { margin-top: 6px; display: flex; flex-direction: column; gap: 8px; }
.adv-row { display: flex; justify-content: space-between; color: #8b929e; font-size: 11px; }
.adv-value { color: #e8eaed; font-variant-numeric: tabular-nums; }
.adv-range { width: 100%; accent-color: #fb7299; }
.adv-info { color: #8b929e; font-size: 11px; }
.adv-toggle { accent-color: #fb7299; cursor: pointer; }
.adv-input {
  width: 100%; padding: 5px 7px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,.12); background: #14161a;
  color: #e8eaed; font: inherit; font-size: 11px;
}
.adv-input:focus { outline: none; border-color: #fb7299; }
.adv-actions { display: flex; gap: 6px; }
.adv-btn {
  flex: 1; padding: 5px 0; border-radius: 6px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.12); background: #16181d;
  color: #b9bfc9; font: inherit; font-size: 11px;
}
.adv-btn:hover { border-color: rgba(255,255,255,.26); }
.adv-btn:disabled { opacity: .55; cursor: default; }
`;
  function createWidget(opts) {
    const host = document.createElement("div");
    host.id = "zbb-widget";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLE}</style>
    <button class="pill" part="pill"><span class="dot"></span><span class="text"></span></button>
    <div class="panel" hidden></div>`;
    const pill = root.querySelector(".pill");
    const text = root.querySelector(".text");
    const panel = root.querySelector(".panel");
    const POS_KEY = "zbb:widget-pos";
    const clamp2 = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
    const applyPos = (x, y) => {
      pill.style.left = `${x}px`;
      pill.style.top = `${y}px`;
      pill.style.right = "auto";
      pill.style.transform = "none";
    };
    const placePanel = () => {
      const r = pill.getBoundingClientRect();
      const pw = panel.offsetWidth || 300;
      const ph = panel.offsetHeight || 200;
      const left = clamp2(r.right - pw, 8, window.innerWidth - pw - 8);
      let top = r.top - ph - 8;
      if (top < 8) top = clamp2(r.bottom + 8, 8, window.innerHeight - ph - 8);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    const savePos = () => {
      try {
        localStorage.setItem(
          POS_KEY,
          JSON.stringify({ x: parseFloat(pill.style.left), y: parseFloat(pill.style.top) })
        );
      } catch {
      }
    };
    const close = () => {
      panel.hidden = true;
      pill.classList.remove("open");
    };
    const overlay = document.createElement("div");
    overlay.id = "zbb-overlay";
    overlay.style.cssText = [
      "position:fixed",
      "top:0",
      "right:0",
      "bottom:0",
      "width:380px",
      "max-width:94vw",
      "z-index:2147483001",
      "display:none",
      "background:#1b1c20",
      "box-shadow:-24px 0 60px rgba(0,0,0,.45)"
    ].join(";");
    let panelHandle = null;
    function closeOverlay() {
      overlay.style.display = "none";
      pill.style.display = "";
      pill.classList.remove("open");
    }
    function openOverlay() {
      if (!opts.panel) return;
      if (!panelHandle) {
        document.documentElement.append(overlay);
        panelHandle = mountPanel({
          mount: overlay,
          variant: "overlay",
          getState: () => ({
            settings: opts.panel.getSettings(),
            records: opts.getRecords(),
            total: opts.getTotal(),
            poolCount: opts.getPool(),
            poolAt: opts.panel.getPoolAt?.() ?? 0,
            poolError: opts.panel.getPoolError?.(),
            current: opts.panel.getCurrent?.()
          }),
          onPatch: (patch) => opts.panel.onPatch(patch),
          onAllow: opts.onAllow,
          onBlockUp: opts.panel.onBlockUp,
          onSyncSeed: opts.panel.onSyncSeed,
          onRefresh: opts.panel.onRefresh,
          onClose: closeOverlay
        });
      } else {
        panelHandle.refresh();
      }
      overlay.style.display = "block";
      pill.style.display = "none";
      pill.classList.add("open");
    }
    const renderPanel = () => {
      const records = opts.getRecords().slice(0, 5);
      panel.textContent = "";
      const head = document.createElement("div");
      head.className = "head";
      const left = document.createElement("span");
      left.textContent = "最近拦截";
      const rightWrap = document.createElement("span");
      rightWrap.className = "head-right";
      const right = document.createElement("span");
      right.textContent = `题库 ${opts.getPool()} 条`;
      rightWrap.append(right);
      if (opts.onOpenSettings) {
        const open = document.createElement("button");
        open.className = "open-panel";
        open.textContent = "设置 ↗";
        open.title = "在侧边栏打开设置页";
        open.addEventListener("click", (event) => {
          event.stopPropagation();
          opts.onOpenSettings?.();
          close();
        });
        rightWrap.append(open);
      }
      head.append(left, rightWrap);
      panel.append(head);
      const current = !opts.panel && opts.getCurrent ? opts.getCurrent() : void 0;
      if (current) {
        const box = document.createElement("div");
        box.className = "cur";
        box.style.cssText = "margin:8px 0;padding:8px 10px;border:1px solid rgba(251,114,153,.35);border-radius:8px;background:rgba(251,114,153,.08)";
        const t = document.createElement("div");
        t.className = "cur-t";
        t.style.cssText = "font-size:12px;line-height:1.45;margin-bottom:6px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical";
        t.textContent = current.title;
        t.title = current.title;
        const row = document.createElement("div");
        row.className = "cur-row";
        row.style.cssText = "display:flex;align-items:center;gap:8px;font-size:11px;color:#9499a0";
        const up = document.createElement("span");
        up.className = "cur-up";
        up.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        up.textContent = current.up || "未知 UP";
        row.append(up);
        if (current.uid) {
          const block = document.createElement("button");
          block.className = "a";
          block.textContent = "屏蔽此 UP";
          block.addEventListener("click", (event) => {
            event.stopPropagation();
            opts.onBlockUp?.(current.uid, current.up);
            renderPanel();
          });
          row.append(block);
        }
        box.append(t, row);
        panel.append(box);
      }
      if (records.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "还没有拦截记录";
        panel.append(empty);
      }
      for (const record of records) {
        const item = document.createElement("div");
        item.className = "item";
        const title = document.createElement("div");
        title.className = "t";
        title.textContent = record.biliTitle;
        const meta = document.createElement("div");
        meta.className = "m";
        const zhihu = document.createElement("span");
        zhihu.className = "z";
        zhihu.textContent = record.reason === "rule" ? record.detail || "规则命中" : `← ${record.zhihuTitle}`;
        zhihu.title = record.reason === "rule" ? record.detail || "" : record.zhihuTitle;
        const score = document.createElement("span");
        score.className = "s";
        score.textContent = record.score.toFixed(2);
        const allow = document.createElement("button");
        allow.className = "a";
        allow.textContent = "放行";
        allow.addEventListener("click", () => {
          opts.onAllow(record);
          renderPanel();
        });
        meta.append(zhihu, score, allow);
        item.append(title, meta);
        panel.append(item);
      }
      appendSettings();
    };
    const appendSettings = () => {
      const cfg = opts.settings;
      if (!cfg) return;
      const box = document.createElement("div");
      box.className = "settings";
      const row = document.createElement("div");
      row.className = "srow";
      const label = document.createElement("span");
      label.textContent = "总开关";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "cb";
      toggle.checked = cfg.getEnabled();
      toggle.addEventListener("change", () => {
        cfg.onToggle(toggle.checked);
        refresh();
      });
      row.append(label, toggle);
      const modes = document.createElement("div");
      modes.className = "modes";
      const current = modeOf(cfg.getThreshold());
      for (const mode of MODES) {
        const chip = document.createElement("button");
        chip.className = `chip${current?.id === mode.id ? " active" : ""}`;
        chip.textContent = mode.name;
        chip.title = `阈值 ${mode.threshold}`;
        chip.addEventListener("click", () => {
          cfg.onThreshold(mode.threshold);
          renderPanel();
        });
        modes.append(chip);
      }
      box.append(row, modes);
      const hasAdvanced = cfg.getPoolInfo || cfg.onRefresh || cfg.onSyncSeed || cfg.getSeedUrl;
      if (hasAdvanced) box.append(buildAdvanced(cfg));
      panel.append(box);
    };
    const buildAdvanced = (cfg) => {
      const details = document.createElement("details");
      details.className = "adv";
      const summary = document.createElement("summary");
      summary.textContent = "高级设置";
      details.append(summary);
      const body = document.createElement("div");
      body.className = "adv-body";
      const head = document.createElement("div");
      head.className = "adv-row";
      const label = document.createElement("span");
      label.textContent = "精确阈值";
      const value = document.createElement("span");
      value.className = "adv-value";
      value.textContent = cfg.getThreshold().toFixed(2);
      head.append(label, value);
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0.6";
      slider.max = "0.92";
      slider.step = "0.01";
      slider.value = String(cfg.getThreshold());
      slider.className = "adv-range";
      slider.addEventListener("input", () => {
        value.textContent = Number(slider.value).toFixed(2);
      });
      slider.addEventListener("change", () => {
        cfg.onThreshold(Number(slider.value));
        renderPanel();
      });
      body.append(head, slider);
      if (cfg.getPoolInfo) {
        const info = document.createElement("div");
        info.className = "adv-info";
        info.textContent = cfg.getPoolInfo();
        body.append(info);
      }
      if (cfg.getContribute && cfg.onContribute) {
        const row = document.createElement("div");
        row.className = "adv-row";
        const label2 = document.createElement("span");
        label2.textContent = "匿名贡献 UP";
        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.className = "adv-toggle";
        toggle.checked = cfg.getContribute();
        toggle.title = "手动屏蔽 UP 时把 UP 编号提交到公共库审核，可随时关闭";
        toggle.addEventListener("change", () => {
          cfg.onContribute?.(toggle.checked);
        });
        row.append(label2, toggle);
        body.append(row);
      }
      if (cfg.getSeedUrl || cfg.onSyncSeed) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "adv-input";
        input.placeholder = "远端题库源（留空则不启用）";
        input.spellcheck = false;
        input.value = cfg.getSeedUrl?.() ?? "";
        input.addEventListener("change", () => cfg.onSeedUrl?.(input.value.trim()));
        body.append(input);
      }
      if (cfg.onRefresh || cfg.onSyncSeed) {
        const actions = document.createElement("div");
        actions.className = "adv-actions";
        for (const [text2, fn] of [
          ["刷新热榜", cfg.onRefresh],
          ["同步题库", cfg.onSyncSeed]
        ]) {
          if (!fn) continue;
          const btn = document.createElement("button");
          btn.className = "adv-btn";
          btn.textContent = text2;
          btn.addEventListener("click", () => {
            btn.disabled = true;
            btn.textContent = "请求中…";
            fn();
            window.setTimeout(() => {
              btn.disabled = false;
              btn.textContent = text2;
              renderPanel();
            }, 1500);
          });
          actions.append(btn);
        }
        body.append(actions);
      }
      details.append(body);
      return details;
    };
    const refresh = () => {
      text.textContent = "已拦截 ";
      const session = document.createElement("b");
      session.textContent = String(opts.getSession());
      text.append(session, " · 累计 ");
      const total = document.createElement("b");
      total.textContent = String(opts.getTotal());
      text.append(total);
      if (overlay.style.display === "block") panelHandle?.refresh();
      if (!panel.hidden) renderPanel();
    };
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    pill.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = pill.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      originX = rect.left;
      originY = rect.top;
      pill.classList.add("dragging");
      try {
        pill.setPointerCapture(event.pointerId);
      } catch {
      }
    });
    pill.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      moved = true;
      const w = pill.offsetWidth;
      const h = pill.offsetHeight;
      applyPos(
        clamp2(originX + dx, 4, window.innerWidth - w - 4),
        clamp2(originY + dy, 4, window.innerHeight - h - 4)
      );
      if (!panel.hidden) placePanel();
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      pill.classList.remove("dragging");
      if (moved) savePos();
    };
    pill.addEventListener("pointerup", endDrag);
    pill.addEventListener("pointercancel", endDrag);
    window.addEventListener("resize", () => {
      if (!pill.style.left) return;
      const w = pill.offsetWidth;
      const h = pill.offsetHeight;
      applyPos(
        clamp2(parseFloat(pill.style.left), 4, window.innerWidth - w - 4),
        clamp2(parseFloat(pill.style.top), 4, window.innerHeight - h - 4)
      );
      if (!panel.hidden) placePanel();
    });
    pill.addEventListener("click", (event) => {
      event.stopPropagation();
      if (moved) {
        moved = false;
        return;
      }
      if (opts.panel) {
        if (overlay.style.display === "block") closeOverlay();
        else openOverlay();
        return;
      }
      if (panel.hidden) {
        renderPanel();
        panel.hidden = false;
        pill.classList.add("open");
        placePanel();
      } else {
        close();
      }
    });
    const onDocClick = (event) => {
      if (opts.panel && overlay.style.display === "block" && !overlay.contains(event.target)) {
        closeOverlay();
      }
      if (panel.hidden) return;
      const path = event.composedPath();
      if (!path.includes(host)) close();
    };
    document.addEventListener("click", onDocClick, true);
    document.documentElement.append(host);
    const DIALOG_SEL = 'dialog[open],.bili-dialog,[class*="bili-dialog"]';
    let hiddenByDialog = false;
    let hiddenSince = 0;
    const dialogOpen = () => {
      for (const el of document.querySelectorAll(DIALOG_SEL)) {
        const rect = el.getBoundingClientRect();
        const centerX = window.innerWidth / 2;
        if (rect.height < 80) continue;
        if (rect.left > centerX + 200 || rect.right < centerX - 200) continue;
        return true;
      }
      return false;
    };
    const dialogGuard = window.setInterval(() => {
      if (document.hidden) return;
      const open = dialogOpen();
      const stuck = hiddenByDialog && open && Date.now() - hiddenSince > 8e3;
      if (open === hiddenByDialog && !stuck) return;
      hiddenByDialog = open && !stuck;
      hiddenSince = hiddenByDialog ? Date.now() : 0;
      host.style.visibility = hiddenByDialog ? "hidden" : "";
    }, 1500);
    try {
      const saved = localStorage.getItem(POS_KEY);
      if (saved) {
        const pos = JSON.parse(saved);
        if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
          applyPos(
            clamp2(pos.x, 4, Math.max(4, window.innerWidth - 160)),
            clamp2(pos.y, 4, Math.max(4, window.innerHeight - 40))
          );
        }
      }
    } catch {
    }
    refresh();
    return {
      refresh,
      open: () => {
        if (opts.panel) {
          openOverlay();
          return;
        }
        renderPanel();
        panel.hidden = false;
        pill.classList.add("open");
        placePanel();
      },
      destroy: () => {
        document.removeEventListener("click", onDocClick, true);
        window.clearInterval(dialogGuard);
        overlay.remove();
        host.remove();
      }
    };
  }
  function mountWidget(opts) {
    try {
      return createWidget(opts);
    } catch {
      return { refresh: () => void 0, open: () => void 0, destroy: () => void 0 };
    }
  }

  // src/userscript/main.ts
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  var HOT_MAX_AGE = 30 * 60 * 1e3;
  var SEED_MAX_AGE = 20 * 60 * 60 * 1e3;
  var win = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
  function readJson(key, fallback) {
    try {
      const raw = GM_getValue(key, "");
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  function writeJson(key, value) {
    try {
      GM_setValue(key, JSON.stringify(value));
    } catch {
    }
  }
  var settingsStore = createSettingsStore(
    {
      get: async (key) => readJson(key, void 0),
      set: async (key, value) => writeJson(key, value)
    },
    DEFAULT_SETTINGS
  );
  var state = {
    settings: unwrapSettings(readJson(KEYS.settings, null), DEFAULT_SETTINGS).data,
    /** 带索引的题库池：一次建好，拦截层和兜底层共用 */
    hot: [],
    /** 编译好的规则过滤 */
    rules: null,
    /** 编译好的评论规则 */
    comments: compileComments(DEFAULT_COMMENT_RULES),
    pool: readJson(KEYS.hot, null),
    records: readJson(KEYS.records, []),
    stats: readJson(KEYS.stats, { total: 0 }),
    ups: readJson(KEYS.ups, { entries: [], updatedAt: 0 })
  };
  function blockedMids() {
    if (!state.settings.upBlockEnabled) return /* @__PURE__ */ new Set();
    return new Set(state.ups.entries.map((entry) => entry.mid));
  }
  function submitUp(mid, name) {
    if (!state.settings.contributeUps) return;
    const endpoints = (state.settings.upsEndpoints ?? []).map((u) => u.trim().replace(/\/$/, "")).filter(Boolean);
    if (endpoints.length === 0) return;
    const attempt = (index) => {
      if (index >= endpoints.length) return;
      GM_xmlhttpRequest({
        method: "POST",
        url: `${endpoints[index]}/submit`,
        timeout: 8e3,
        headers: { "content-type": "application/json" },
        data: JSON.stringify({ mid, name }),
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) attempt(index + 1);
        },
        onerror: () => attempt(index + 1),
        ontimeout: () => attempt(index + 1)
      });
    };
    attempt(0);
  }
  function addUp(mid, name) {
    if (state.ups.entries.some((entry) => entry.mid === mid)) return;
    state.ups = {
      entries: [...state.ups.entries, { mid, name, source: "manual", addedAt: Date.now() }],
      updatedAt: Date.now()
    };
    writeJson(KEYS.ups, state.ups);
    submitUp(mid, name);
    widget?.refresh();
  }
  var sessionHits = 0;
  var widget = null;
  var commentFilter = null;
  function currentVideo() {
    if (!/\/(video|bangumi)\//.test(location.pathname)) return void 0;
    const titleEl = document.querySelector("h1.video-title, .video-title, h1");
    const title = (titleEl?.textContent ?? document.title.replace(/[_\-]\s*哔哩哔哩.*$/, "")).trim();
    const upA = document.querySelector(
      'a.up-name, a.up-name__text, a[href*="space.bilibili.com"]'
    );
    const uid = (upA?.getAttribute("href")?.match(/space\.bilibili\.com\/(\d+)/) ?? [])[1] ?? "";
    const up = (upA?.textContent ?? "").trim();
    return { title: title || "当前视频", up, uid };
  }
  function poolEntries() {
    const raw = state.pool;
    return Array.isArray(raw?.entries) ? raw.entries : [];
  }
  function rebuild() {
    const split = splitByFreshness(poolEntries(), Date.now(), 7);
    state.hot = preparePool(
      split.fresh.map((e) => e.title),
      split.stale.map((e) => e.title)
    );
    state.rules = compileRules(state.settings.rules ?? DEFAULT_SETTINGS.rules);
    state.comments = compileComments(state.settings.comments ?? DEFAULT_COMMENT_RULES);
    commentFilter?.rescan();
  }
  function allEntries() {
    return state.hot;
  }
  function saveSettings(patch) {
    void settingsStore.patch(patch).then((env) => {
      state.settings = env.data;
    });
  }
  function savePool() {
    writeJson(KEYS.hot, state.pool);
  }
  function addRecord(record) {
    const dup = state.records.some(
      (r) => r.biliTitle === record.biliTitle && r.zhihuTitle === record.zhihuTitle
    );
    if (!dup) {
      state.records.unshift(record);
      state.records = state.records.slice(0, RECORD_LIMIT);
      sessionHits += 1;
      state.stats = { total: state.stats.total + 1 };
      writeJson(KEYS.records, state.records);
      writeJson(KEYS.stats, state.stats);
    }
    widget?.refresh();
  }
  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        timeout: 12e3,
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "zh-CN,zh;q=0.9",
          "user-agent": UA
        },
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) resolve(res.responseText);
          else reject(new Error(`HTTP ${res.status}`));
        },
        onerror: () => reject(new Error("网络错误")),
        ontimeout: () => reject(new Error("超时"))
      });
    });
  }
  function sources() {
    const list = [
      { name: "知乎热榜", url: "https://api.zhihu.com/topstory/hot-list?limit=50&reverse_order=0" },
      {
        name: "知乎热榜(登录态)",
        url: "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50"
      }
    ];
    const rsshub = state.settings.rsshub.trim().replace(/\/+$/, "");
    if (rsshub) list.push({ name: "RSSHub", url: `${rsshub}/zhihu/hotlist`, rss: true });
    return list;
  }
  async function refreshHot(force = false) {
    if (!force && state.pool?.updatedAt && Date.now() - state.pool.updatedAt < HOT_MAX_AGE) return;
    const errors = [];
    for (const source of sources()) {
      try {
        const text = await gmFetch(source.url);
        const titles = source.rss ? parseRss(text) : pickTitles(JSON.parse(text));
        if (titles.length >= 5) {
          const now = Date.now();
          const merged = mergePool(
            poolEntries(),
            titles.map((title) => ({ title, origin: "hot" })),
            now
          );
          state.pool = {
            ...state.pool ?? { entries: [], updatedAt: 0, source: "none", error: "" },
            entries: prunePool(merged, now, {
              maxAgeDays: state.settings.poolDays,
              maxEntries: state.settings.poolMax
            }),
            updatedAt: now,
            source: source.name,
            error: ""
          };
          savePool();
          rebuild();
          widget?.refresh();
          return;
        }
        errors.push(`${source.name}: 只拿到 ${titles.length} 条`);
      } catch (err) {
        errors.push(`${source.name}: ${err.message}`);
      }
    }
    state.pool = {
      ...state.pool ?? { entries: [], updatedAt: 0, source: "none", error: "" },
      error: errors.join(" | ")
    };
    savePool();
    widget?.refresh();
  }
  async function syncSeed(force = false) {
    const urls = (state.settings.remoteSeedUrls ?? []).filter(Boolean);
    if (!urls.length) return;
    if (!force && state.pool?.remote?.at && Date.now() - state.pool.remote.at < SEED_MAX_AGE) return;
    const errors = [];
    for (const url of urls) {
      try {
        const text = await gmFetch(url);
        const titles = parseSeed(text.slice(0, REMOTE_MAX_BYTES));
        if (titles.length < 10) throw new Error(`只解析到 ${titles.length} 条`);
        const now = Date.now();
        const entries = replaceOrigin(poolEntries(), "remote", titles, now);
        state.pool = {
          ...state.pool ?? { entries: [], updatedAt: 0, source: "none", error: "" },
          entries: prunePool(entries, now, {
            maxAgeDays: state.settings.poolDays,
            maxEntries: state.settings.poolMax
          }),
          remote: { at: now, count: titles.length, error: "" }
        };
        savePool();
        rebuild();
        widget?.refresh();
        return;
      } catch (err) {
        errors.push(`${url}: ${err.message}`);
      }
    }
    state.pool = {
      ...state.pool ?? { entries: [], updatedAt: 0, source: "none", error: "" },
      remote: { at: 0, count: 0, error: errors.join(" | ") }
    };
    savePool();
    widget?.refresh();
  }
  var UPS_MAX_AGE = 20 * 60 * 60 * 1e3;
  async function syncUps(force = false) {
    const urls = (state.settings.remoteUpsUrls ?? []).filter(Boolean);
    if (!urls.length) return;
    if (!force && state.ups.updatedAt && Date.now() - state.ups.updatedAt < UPS_MAX_AGE) return;
    for (const url of urls) {
      try {
        const text = await gmFetch(url);
        const remote = parseUpsFile(text.slice(0, REMOTE_MAX_BYTES));
        if (!remote.length) throw new Error("没有解析到条目");
        state.ups = { entries: mergeUps(state.ups.entries, remote), updatedAt: Date.now() };
        writeJson(KEYS.ups, state.ups);
        rebuild();
        widget?.refresh();
        return;
      } catch {
      }
    }
  }
  installFeedHook({
    win,
    ready: Promise.resolve(),
    getState: () => ({ settings: state.settings, hot: allEntries(), rules: state.rules, blockedUps: blockedMids() }),
    onHit: (biliTitle, result) => {
      addRecord({
        biliTitle,
        zhihuTitle: result.zhihuTitle,
        score: result.score,
        reason: result.reason === "none" ? "dice" : result.reason,
        layer: "net",
        at: Date.now()
      });
    }
  });
  startScanner({
    settings: () => state.settings,
    hot: () => allEntries(),
    onCard: (card) => {
      if (state.settings.enabled && state.rules) {
        const info = extractCardInfo(card, { detectAd: state.rules.hideAd });
        const hit = matchCard(info, state.rules);
        if (hit) {
          addRecord({
            biliTitle: info.title || extractTitle(card) || "（无标题广告位）",
            zhihuTitle: "",
            score: 1,
            reason: "rule",
            detail: hit.reason,
            layer: "dom",
            at: Date.now()
          });
          hideCard(card);
          return true;
        }
      }
      const owner = cardOwner(card);
      if (!owner) return false;
      const blocked = blockedMids();
      if (blocked.size > 0 && blocked.has(owner.mid)) {
        hideCard(card);
        return true;
      }
      attachUpButton(card, owner, (o) => {
        addUp(o.mid, o.name);
        hideCard(card);
      });
      return false;
    },
    onHit: (biliTitle, result) => {
      addRecord({
        biliTitle,
        zhihuTitle: result.zhihuTitle,
        score: result.score,
        reason: result.reason === "none" ? "dice" : result.reason,
        layer: "dom",
        at: Date.now()
      });
    }
  });
  function mountUi() {
    if (widget || !document.documentElement) return;
    widget = mountWidget({
      getSession: () => sessionHits,
      getTotal: () => state.stats.total,
      getPool: () => poolEntries().length,
      getRecords: () => state.records,
      onAllow: (record) => {
        if (!state.settings.whitelist.includes(record.biliTitle)) {
          state.settings = {
            ...state.settings,
            whitelist: [...state.settings.whitelist, record.biliTitle]
          };
          saveSettings({ whitelist: [...state.settings.whitelist] });
        }
        state.records = state.records.filter((r) => r.biliTitle !== record.biliTitle);
        writeJson(KEYS.records, state.records);
        widget?.refresh();
      },
      // 油猴版：胶囊展开的是与扩展弹窗同一套完整面板
      panel: {
        getSettings: () => state.settings,
        onPatch: (patch) => {
          state.settings = { ...state.settings, ...patch };
          saveSettings(patch);
          rebuild();
          widget?.refresh();
        },
        onSyncSeed: () => void syncSeed(true),
        onRefresh: () => void refreshHot(true),
        getCurrent: currentVideo,
        onBlockUp: (uid, name) => {
          const mid = Number(uid);
          if (Number.isFinite(mid) && mid > 0) addUp(mid, name);
        },
        getPoolAt: () => state.pool?.updatedAt ?? 0,
        getPoolError: () => state.pool?.error
      }
    });
  }
  rebuild();
  commentFilter = installCommentFilter({ getRules: () => state.comments });
  installCommentImagePreload({ enabled: () => state.settings.preloadCommentImages !== false });
  if (document.documentElement) mountUi();
  else document.addEventListener("DOMContentLoaded", mountUi, { once: true });
  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("打开知乎屏蔽面板", () => {
      mountUi();
      widget?.open();
    });
  }
  void refreshHot().then(() => syncSeed()).then(() => syncUps());
})();
