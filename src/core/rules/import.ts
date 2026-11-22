/**
 * 导入 biliHoyoFairy 导出的规则文件。
 *
 * 两个插件的规则字段几乎同名，但语义有差别：
 *  - 它的 block.tags / dualTags / upBio 依赖联网取数据，本产品不做 → 记为「跳过」
 *  - 它的 allow.upNames 在白名单里按 UP 名匹配，本产品用「up: 前缀关键词」表达 → 转写
 *  - hideHotSearch 同理，不在范围里 → 跳过
 * 只填它给了的字段，没给的保持当前值，避免导入把已有配置清空。
 */
import type { Settings } from '../types';
import type { RuleSet } from './rules';
import type { CommentRules } from '../comments';

interface HoyoConfig {
  fuzzyMatch?: boolean;
  hideAd?: boolean;
  hideLiveCard?: boolean;
  block?: Partial<{
    keywords: string[];
    partitions: string[];
    upNames: string[];
    uids: string[];
    bvids: string[];
    minDuration: number;
    maxDuration: number;
    minViews: number;
    maxViews: number;
    minLikes: number;
    maxLikes: number;
    spamLikeRatio: number;
    spamMinViews: number;
    tags: string[];
    dualTags: string[];
    upBio: string[];
  }>;
  allow?: Partial<{ keywords: string[]; upNames: string[]; uids: string[] }>;
  comment?: Partial<{
    enabled: boolean;
    keywords: string[];
    userNames: string[];
    userNameKeywords: string[];
    minLevel: number;
    hideNoFace: boolean;
    hideEmojiOnly: boolean;
    hideCallOnly: boolean;
    hideAd: boolean;
    hideCallBot: boolean;
    hideBot: boolean;
    allowUp: boolean;
    allowPin: boolean;
    allowMe: boolean;
  }>;
}

export interface ImportResult {
  ok: boolean;
  /** 错误信息（ok=false 时） */
  error?: string;
  patch?: Partial<Settings>;
  /** 成功导入的条目数（关键词/UP/UID/BV/分区） */
  imported: number;
  /** 无法导入的字段说明 */
  skipped: string[];
  source?: string;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

export function parseImport(raw: string): ImportResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件', imported: 0, skipped: [] };
  }
  const root = json as { app?: string; version?: string; config?: HoyoConfig };
  if (!root || typeof root !== 'object' || !root.config) {
    return { ok: false, error: '文件里没有 config 字段，可能不是规则导出文件', imported: 0, skipped: [] };
  }
  if (root.app && root.app !== 'biliHoyoFairy') {
    return { ok: false, error: `不认识的来源：${root.app}`, imported: 0, skipped: [] };
  }

  const cfg = root.config;
  const block = cfg.block ?? {};
  const allow = cfg.allow ?? {};
  const cmt = cfg.comment ?? {};
  const skipped: string[] = [];

  const keywords = strList(block.keywords);
  const partitions = strList(block.partitions);
  const upNames = strList(block.upNames);
  const uids = strList(block.uids);
  const bvids = strList(block.bvids);

  // 白名单 UP 名转成 up: 前缀关键词（本产品的白名单支持作用域前缀）
  const allowUpAsKw = strList(allow.upNames).map((n) => `up:${n}`);
  const allowKeywords = [...strList(allow.keywords), ...allowUpAsKw];
  const allowUids = strList(allow.uids);

  const rules: Partial<RuleSet> = {
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
      maxDuration: Number(block.maxDuration ?? 0) || 0,
    },
    hideAd: cfg.hideAd ?? false,
    hideLive: cfg.hideLiveCard ?? false,
    fuzzyMatch: cfg.fuzzyMatch !== false,
  };

  const comments: Partial<CommentRules> = {
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
    allowMe: cmt.allowMe !== false,
  };

  if (strList(block.tags).length) skipped.push('视频标签（需要联网取数据，本产品未实现）');
  if (strList(block.dualTags).length) skipped.push('组合标签（同上）');
  if (strList(block.upBio).length) skipped.push('UP 简介关键词（同上）');

  const imported =
    keywords.length + partitions.length + upNames.length + uids.length + bvids.length +
    allowKeywords.length + allowUids.length +
    comments.keywords!.length + comments.users!.length + comments.userKeywords!.length;

  return { ok: true, patch: { rules, comments } as Partial<Settings>, imported, skipped, source: root.app };
}

/** 导出成我们自己的格式：给用户备份/换设备用 */
export function buildExport(settings: Settings): string {
  return JSON.stringify(
    { app: 'BiliBlocker', version: 1, exportedAt: new Date().toISOString(), config: { rules: settings.rules, comments: settings.comments } },
    null,
    2,
  );
}
