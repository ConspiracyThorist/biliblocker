/**
 * 从 DOM 卡片抽取 CardInfo，供规则层判定。
 *
 * 选择器移植自 biliHoyoFairy 的 selectors.ts / cardinfo.ts（作者 gendu-amd，MIT），
 * 并保留其中针对 BewlyCat 的类名——Greasyfork 反馈里明确有人用 BewlyCat，
 * 多一行选择器就能让那批用户也用上规则过滤。
 */
import type { CardInfo } from './card';
import { parseCount, parseDuration } from './card';

export const CARD_TITLE_SELECTORS = [
  '.bili-video-card__info--tit',
  '.video-name',
  'h3[title]',
  '.title',
];

export const CARD_UP_SELECTORS = [
  '.bili-video-card__info--author',
  '.up-name__text',
  '.up-name',
  '.bili-video-card__info--owner span',
];

export const CARD_PARTITION_SELECTORS = ['.bili-video-card__info--tag', '.rcmd-tag'];

export const CARD_DURATION_SELECTORS = [
  '.bili-video-card__stats__duration',
  '.duration',
  '.bili-dyn-card-video__duration',
  '.video-card-cover-stats__item--duration', // BewlyCat
];

export const CARD_VIEWS_SELECTORS = [
  '.bili-video-card__stats--item',
  '.play-text',
  '.cover-stat-view .video-card-cover-stats__value', // BewlyCat
];

export const CARD_LIKES_SELECTORS = ['.cover-stat-like .video-card-cover-stats__value'];

export const CARD_MID_ATTR_SELECTOR = '[data-mid],[data-up-mid],[data-user-id]';
export const CARD_MID_ATTRS = ['data-mid', 'data-up-mid', 'data-user-id'];

export const LIVE_CARD_SELECTOR = '.bili-live-card, [class*="live-card"]';

export const AD_CARD_SELECTOR = [
  '.bili-video-card__info--ad',
  'a[href*="cm.bilibili.com"]',
  'a[href*="//mall.bilibili.com"]',
  'a[href*="specialRecommendByOp"]',
].join(',');

function pickText(card: Element, selectors: string[]): string {
  for (const sel of selectors) {
    const el = card.querySelector(sel);
    if (!el) continue;
    const v = el.getAttribute('title') || el.textContent;
    if (v && v.trim()) return v.trim();
  }
  return '';
}

/**
 * 抽一张卡片的信息。
 * deepUid 控制是否在拿不到 UID 时序列化 innerHTML 兜底——那是最贵的一步，
 * 只在需要精确 UID（例如批量拉黑）时才打开。
 * detectAd 控制是否做广告判定：它要遍历全卡 span/div 找「广告」角标，
 * 是本函数最贵的一段，只有开了「屏蔽广告卡」才值得付这个成本。
 */
export function extractCardInfo(
  card: Element,
  opts: { deepUid?: boolean; detectAd?: boolean } = {},
): CardInfo {
  const deepUid = opts.deepUid ?? false;
  const detectAd = opts.detectAd ?? true;
  const info: CardInfo = {
    title: '',
    up: '',
    uid: '',
    partition: '',
    bvid: '',
    duration: null,
    views: null,
    likes: null,
    isLive: false,
    isAd: false,
  };

  info.title = pickText(card, CARD_TITLE_SELECTORS);
  info.up = pickText(card, CARD_UP_SELECTORS);

  const upA = card.querySelector('a[href*="space.bilibili.com"]');
  if (upA) {
    info.uid = ((upA.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/) || [])[1] || '';
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
    const m = (aVideo.getAttribute('href') || '').match(/(BV[0-9A-Za-z]+)/);
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

  const text = card.textContent || '';
  info.isLive = !!(
    card.querySelector('a[href*="live.bilibili.com"]') ||
    card.querySelector(LIVE_CARD_SELECTOR) ||
    /直播中|正在直播/.test(text)
  );

  if (!info.uid && deepUid && text.trim()) {
    const html = card.innerHTML;
    info.uid =
      (html.match(/space\.bilibili\.com\/(\d+)/) || [])[1] ||
      (html.match(/"(?:mid|owner_?id|up_?mid)"\s*:\s*"?(\d{2,})"?/) || [])[1] ||
      '';
  }

  // 广告判定要遍历全卡节点，最贵，放在最后；未开启「屏蔽广告卡」时整段跳过
  if (detectAd && !info.isLive) {
    info.isAd = !!card.querySelector(AD_CARD_SELECTOR);
    if (!info.isAd) {
      info.isAd = Array.from(card.querySelectorAll('span,div')).some((el) => {
        const tx = (el.textContent || '').trim();
        return tx === '广告' || tx === '赞助' || tx === '推广';
      });
    }
  }

  return info;
}
