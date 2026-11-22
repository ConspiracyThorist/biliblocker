/**
 * 卡片信息抽取：把各推荐接口的列表项归一成同形状的 CardInfo，供规则判定。
 *
 * 移植自 biliHoyoFairy 的 cardinfo.ts（作者 gendu-amd，MIT）。
 * 这里只保留 JSON 这一路；DOM 这一路在 dom 层按需抽取（同一形状）。
 */

export interface CardInfo {
  title: string;
  up: string;
  uid: string;
  partition: string;
  bvid: string;
  link?: string;
  /** 秒 */
  duration: number | null;
  views: number | null;
  likes: number | null;
  isLive: boolean;
  isAd: boolean;
}

/** "mm:ss" / "hh:mm:ss" → 秒；解析不了返回 null */
export function parseDuration(s: string | null | undefined): number | null {
  if (!s) return null;
  const parts = s.trim().split(':').map((x) => parseInt(x, 10));
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** "12.3万" / "1,024" → 数值；解析不了返回 null */
export function parseCount(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.trim().replace(/[,\s]/g, '');
  const m = t.match(/^([\d.]+)\s*(万|亿)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  if (m[2] === '万') n *= 1e4;
  else if (m[2] === '亿') n *= 1e8;
  return Math.round(n);
}

/**
 * 推荐/排行/热门/相关/搜索 各接口的列表项 → CardInfo。
 * 字段形态各异，统一按宽松类型读取；取不到就留空，让规则自己跳过。
 */
export function normFeedItem(it: unknown): CardInfo | null {
  if (!it || typeof it !== 'object') return null;
  const node = it as Record<string, any>;
  const goto = node.goto || node.card_goto || '';
  const owner = node.owner || {};
  const stat = node.stat || {};
  // 广告项的标题/落地页常埋在 ad_info / cm 里，挖出来才能在记录里认出是什么
  const ad = node.ad_info || node.cm_info || node.cm || null;
  const adC = (ad && (ad.creative_content || ad.creative)) || {};
  // 搜索结果的 title 内含 <em> 高亮标签，去标签后再匹配（其它接口无标签，无副作用）
  const rawTitle = node.title || adC.title || adC.description || ad?.title || '';

  return {
    title: String(rawTitle || '').replace(/<[^>]*>/g, ''),
    up: owner.name || node.author || node.name || (ad && ad.source_content && ad.source_content.name) || '',
    uid: owner.mid != null ? String(owner.mid) : node.mid != null ? String(node.mid) : '',
    // 只认真正的分区字段：rcmd_reason.content 是「已关注/高播放」这类推荐理由，语义不同
    partition: node.tname || node.typename || '',
    bvid: node.bvid || '',
    link: node.uri || node.jump_url || adC.url || adC.jump_url || '',
    duration: typeof node.duration === 'number' ? node.duration : node.duration ? parseDuration(node.duration) : null,
    views: stat.view != null ? stat.view : stat.play != null ? stat.play : node.play != null ? node.play : null,
    likes: stat.like != null ? stat.like : null,
    isLive: goto === 'live' || !!node.live_info,
    isAd: goto === 'ad' || goto === 'cm' || !!node.ad_info || !!node.is_ad,
  };
}
