/**
 * 规则引擎：把用户配置编译成匹配器，再对一张卡片做判定。
 *
 * 白名单优先级最高；其余维度按固定顺序短路，命中即返回原因串（用于记录与面板展示）。
 * 纯函数、无 DOM / 无存储依赖，方便单测。
 */
import type { CardInfo } from './card';
import { compileLines, compileScopedKeywords, configureFuzzy, kwHit, kwWhich, lc, type KwScope, type Matcher, type ScopedKw, textHit, whichHit } from './text';

/** 数值阈值（播放/点赞用「万」为单位，时长用秒；0 = 不启用） */
export interface Thresholds {
  minViews: number;
  maxViews: number;
  minLikes: number;
  maxLikes: number;
  /** 点赞率低于 x%（且播放量 ≥ spamMinViews 万）判为营销号 */
  spamLikeRatio: number;
  spamMinViews: number;
  minDuration: number;
  maxDuration: number;
}

export interface RuleSet {
  /** 标题/UP/分区关键词，支持 title: / up: / part: 前缀与 /正则/ */
  keywords: string[];
  /** 白名单关键词，优先级最高 */
  allowKeywords: string[];
  upNames: string[];
  uids: string[];
  bvids: string[];
  partitions: string[];
  allowUids: string[];
  block: Thresholds;
  hideAd: boolean;
  hideLive: boolean;
  /** 反绕过：忽略空格/标点等分隔符后再匹配 */
  fuzzyMatch: boolean;
}

export const DEFAULT_RULES: RuleSet = {
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
    maxDuration: 0,
  },
  hideAd: true,
  hideLive: false,
  fuzzyMatch: true,
};

export interface CompiledRules {
  kw: ScopedKw;
  allowKw: ScopedKw;
  partitions: Matcher;
  upNames: Map<string, string>;
  uids: Set<string>;
  bvids: Set<string>;
  allowUids: Set<string>;
  block: Thresholds;
  hideAd: boolean;
  hideLive: boolean;
}

/** 编译一份规则；每张卡判定前只做一次 */
export function compileRules(set: RuleSet): CompiledRules {
  // 模糊匹配开关是全局的文本归一策略，编译时注入一次即可
  configureFuzzy(() => set.fuzzyMatch !== false);
  const upNames = new Map<string, string>();
  for (const name of set.upNames ?? []) {
    const key = lc(name);
    if (key) upNames.set(key, String(name).trim());
  }
  const uids = new Set<string>();
  for (const uid of set.uids ?? []) {
    const v = String(uid).trim();
    if (/^\d+$/.test(v)) uids.add(v);
  }
  const bvids = new Set<string>();
  for (const bv of set.bvids ?? []) {
    const v = String(bv).trim();
    if (v) bvids.add(v);
  }
  const allowUids = new Set<string>();
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
    hideLive: !!set.hideLive,
  };
}

export interface RuleHit {
  /** 展示用原因，形如「关键词:送十连」「播放<1000」 */
  reason: string;
}

/** 白名单：标题/UP/分区关键词 + UID，任一命中就放行 */
export function isWhitelisted(info: CardInfo, rules: CompiledRules): boolean {
  if (kwHit(rules.allowKw, 'title', info.title)) return true;
  if (info.up && kwHit(rules.allowKw, 'up', info.up)) return true;
  if (info.partition && kwHit(rules.allowKw, 'part', info.partition)) return true;
  if (info.uid && rules.allowUids.has(info.uid)) return true;
  return false;
}

/**
 * 判定一张卡片。返回 null 表示放行。
 * 顺序与 biliHoyoFairy 一致：卡片类型 → 数值 → 关键词 → 分区 → UP → UID → BV → 时长。
 */
export function matchCard(info: CardInfo, rules: CompiledRules): RuleHit | null {
  if (isWhitelisted(info, rules)) return null;
  const b = rules.block;

  if (rules.hideAd && info.isAd) return { reason: '广告卡' };
  if (rules.hideLive && info.isLive) return { reason: '直播卡' };

  if (info.views != null) {
    if (b.minViews > 0 && info.views < b.minViews * 1e4) return { reason: `播放<${b.minViews}万` };
    if (b.maxViews > 0 && info.views > b.maxViews * 1e4) return { reason: `播放>${b.maxViews}万` };
  }

  if (info.likes != null) {
    if (b.minLikes > 0 && info.likes < b.minLikes) return { reason: `点赞<${b.minLikes}` };
    if (b.maxLikes > 0 && info.likes > b.maxLikes) return { reason: `点赞>${b.maxLikes}` };
  }

  // 营销号：高播放却极低赞。只有拿得到点赞数时才判（多数版式拿不到）
  if (b.spamLikeRatio > 0 && info.likes != null && info.views) {
    if (info.views >= b.spamMinViews * 1e4 && (info.likes / info.views) * 100 < b.spamLikeRatio) {
      return { reason: `营销号(赞率<${b.spamLikeRatio}%)` };
    }
  }

  const field: KwScope | null = kwHit(rules.kw, 'title', info.title)
    ? 'title'
    : info.up && kwHit(rules.kw, 'up', info.up)
      ? 'up'
      : info.partition && kwHit(rules.kw, 'part', info.partition)
        ? 'part'
        : null;
  if (field) {
    const text = field === 'title' ? info.title : field === 'up' ? info.up : info.partition;
    const rule = kwWhich(rules.kw, field, text);
    return { reason: rule ? `关键词:${rule}` : '关键词' };
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

/**
 * 带缓存的编译。
 *
 * 每次改设置都会重编译全部规则：关键词多的时候就是几千个 RegExp 重建，
 * 而绝大多数变更只动一个字段。按「规则内容的 JSON」做键缓存，命中就复用上一次结果。
 * 用内容而不是对象引用做键，是因为设置经常被整体替换（引用变了，内容没变）。
 */
let cacheKey = '';
let cacheValue: CompiledRules | null = null;

export function compileRulesCached(set: RuleSet): CompiledRules {
  const key = JSON.stringify(set);
  if (cacheValue && key === cacheKey) return cacheValue;
  cacheKey = key;
  cacheValue = compileRules(set);
  return cacheValue;
}
