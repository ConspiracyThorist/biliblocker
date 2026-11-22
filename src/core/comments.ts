/**
 * 评论区过滤：读 B 站评论 Web Component 宿主上的 `__data`，命中就折叠成一条灰条。
 *
 * 移植自 biliHoyoFairy 的 comments.ts（作者 gendu-amd，MIT），保留其判定语义与折叠交互，
 * 去掉审查模式/统计埋点等本产品暂不需要的部分。
 *
 * 为什么读 `__data` 而不是解析 DOM：B 站新版评论是 Web Component
 *（BILI-COMMENT-THREAD-RENDERER / -REPLY-RENDERER），正确字段（等级、是否 UP 置顶、
 * 头像是否默认）只在组件数据里，DOM 上抠不全。
 *
 * 判定部分是纯函数，能单独测；DOM 部分只负责「把命中的收起来」。
 */
import { compileLines, lc, ruleLines, textHit, type Matcher } from './rules/text';

export interface CommentRules {
  enabled: boolean;
  /** 评论正文关键词（支持 /正则/） */
  keywords: string[];
  /** 昵称关键词 */
  userKeywords: string[];
  /** 精确昵称黑名单 */
  users: string[];
  /** 低于该等级折叠；0 = 不启用 */
  minLevel: number;
  /** 默认头像 + 非会员 */
  hideNoFace: boolean;
  /** 已知 AI 总结机器人 */
  hideBot: boolean;
  /** 评论里 @ 了 AI 机器人（召唤 AI 总结） */
  hideCallBot: boolean;
  /** 带货/导流链接 */
  hideAd: boolean;
  /** 只 @ 别人、没有正文 */
  hideCallOnly: boolean;
  /** 纯表情 */
  hideEmojiOnly: boolean;
  /** 白名单：UP 主自己的评论 */
  allowUp: boolean;
  /** 白名单：UP 置顶评论 */
  allowPin: boolean;
  /** 白名单：我自己 */
  allowMe: boolean;
}

export const DEFAULT_COMMENT_RULES: CommentRules = {
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
  allowMe: true,
};

/** 已知的 AI 评论机器人（B 站各评论区高频出现的总结号） */
export const COMMENT_BOTS = new Set<string>([
  '机器工具人', '有趣的程序员', 'AI视频小助理', 'AI视频小助理总结一下', 'AI笔记侠', 'AI视频助手',
  '哔哩哔理点赞姬', '课代表猫', 'AI课代表呀', '木几萌Moe', '星崽丨StarZai', 'AI沈阳美食家', 'AI头脑风暴',
  'GPT_5', 'Juice_AI', 'AI全文总结', 'AI视频总结', 'AI总结视频', 'AI工具集', 'Ai的评论', 'AI识片酱',
  'AI知识总结', 'AI小精灵呀', 'AI课程教学', 'Ai好记', 'MilkyAi', '视频AI问答助手',
]);

/** 带货/导流链接特征 */
export const COMMENT_AD_RE = /(bili2233\.cn|b23\.tv)\/(mall-|cm-)|领券|gaoneng\.bilibili\.com/i;

export interface CommentHost extends HTMLElement {
  __data?: {
    mid?: string | number;
    member?: {
      uname?: string;
      avatar?: string;
      level_info?: { current_level?: number };
      vip?: { vipStatus?: number };
    };
    content?: { message?: string; members?: { uname?: string }[] };
    reply_control?: { is_up_top?: boolean };
  };
  __upMid?: string | number;
  __user?: { uname?: string };
  __cmtPh?: HTMLElement | null;
  __cmtHit?: string | null;
  __cmtExpanded?: boolean;
}

export const COMMENT_TAGS: Record<string, boolean> = {
  // true = 楼中楼（二级评论）
  'BILI-COMMENT-THREAD-RENDERER': false,
  'BILI-COMMENT-REPLY-RENDERER': true,
};

export function isCommentTag(tagName: string): boolean {
  return COMMENT_TAGS[tagName] !== undefined;
}

export interface CmtInfo {
  uname: string;
  mid: string | number | undefined;
  level: number | null;
  noface: boolean;
  message: string;
  members: { uname?: string }[];
  isUpTop: boolean;
  upMid: string | number | undefined;
  me: string | undefined;
}

/** 读宿主上的组件数据；缺字段一律当「没有」，绝不抛错 */
export function readCmt(host: CommentHost | null | undefined): CmtInfo {
  const d = (host && host.__data) || {};
  const member = d.member || {};
  const content = d.content || {};
  const lv = member.level_info && member.level_info.current_level;
  const vipStatus = member.vip && member.vip.vipStatus;
  return {
    uname: ((member.uname || '') + '').trim(),
    mid: d.mid,
    level: typeof lv === 'number' ? lv : null,
    noface: (member.avatar || '').endsWith('noface.jpg') && (vipStatus === 0 || vipStatus == null),
    message: (content.message || '') + '',
    members: Array.isArray(content.members) ? content.members : [],
    isUpTop: !!(d.reply_control && d.reply_control.is_up_top),
    upMid: host ? host.__upMid : undefined,
    me: host && host.__user ? host.__user.uname : undefined,
  };
}

const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u200d\u{20E3}]/gu;

/** 归一正文：去掉「回复 @x:」、@ 提及、[表情] 占位 */
export function cleanComment(message: unknown, isSub: boolean): string {
  let s = (message || '').toString();
  if (isSub) s = s.replace(/^回复\s?@[^@\s:：]+\s?[:：]/, '');
  return s.replace(/@[^@\s]+/g, ' ').replace(/(\[[^[\]]+\])+/g, ' ').trim();
}

export interface CompiledComments {
  kw: Matcher;
  userKw: Matcher;
  users: Set<string>;
  rules: CommentRules;
}

export function compileComments(rules: CommentRules): CompiledComments {
  const users = new Set<string>();
  for (const name of ruleLines(rules.users)) {
    const key = lc(name);
    if (key) users.add(key);
  }
  return { kw: compileLines(rules.keywords), userKw: compileLines(rules.userKeywords), users, rules };
}

/** 返回命中原因或 null；白名单优先（UP 主 / UP 置顶 / 我自己） */
export function matchComment(c: CmtInfo, isSub: boolean, cc: CompiledComments): string | null {
  const r = cc.rules;
  if (!r.enabled) return null;

  if (r.allowUp && c.upMid != null && c.mid != null && String(c.mid) === String(c.upMid)) return null;
  if (r.allowPin && !isSub && c.isUpTop) return null;
  if (r.allowMe && c.me && (c.uname === c.me || c.message.includes(`@${c.me}`))) return null;

  if (c.uname && cc.users.has(lc(c.uname))) return `评论用户:${c.uname}`;
  if (c.uname && textHit(c.uname, cc.userKw)) return '评论昵称词';

  const clean = cleanComment(c.message, isSub);
  if (textHit(clean, cc.kw)) return '评论关键词';
  if (r.minLevel > 0 && c.level != null && c.level < r.minLevel) return `评论等级<${r.minLevel}`;
  if (r.hideNoFace && c.noface) return '默认头像非会员';
  if (r.hideBot && c.uname && COMMENT_BOTS.has(c.uname)) return 'AI机器人';
  if (r.hideCallBot && c.members.some((m) => !!(m && m.uname && COMMENT_BOTS.has(m.uname)))) return '召唤AI';
  if (r.hideAd && COMMENT_AD_RE.test(c.message)) return '带货评论';
  if (r.hideCallOnly && c.message.replace(/@[^@\s]+/g, ' ').trim() === '') return '纯@评论';
  if (r.hideEmojiOnly && clean.replace(EMOJI_RE, '').trim() === '') return '纯表情评论';
  return null;
}

// ---------------------------------------------------------------------------
// DOM 部分
// ---------------------------------------------------------------------------

const PH_CLASS = 'zbb-cmt-ph';

function renderPlaceholder(ph: HTMLElement, host: CommentHost, reason: string): void {
  const expanded = !!host.__cmtExpanded;
  const txt = ph.querySelector('.zbb-ph-txt');
  const act = ph.querySelector('.zbb-ph-act');
  if (txt) txt.textContent = `${expanded ? '已展开' : '已折叠'} · 命中：${reason}`;
  if (act) act.textContent = expanded ? '点击收起 ▴' : '点击展开 ▾';
  host.style.display = expanded ? '' : 'none';
}

/**
 * 折叠：命中评论收成一行灰条，可来回展开。
 * 灰条插在宿主前面而不是替换宿主——B 站的组件会重渲染，替换会把它整个摘掉。
 */
function collapseComment(host: CommentHost, reason: string): void {
  host.__cmtHit = reason;
  if (host.__cmtPh && host.__cmtPh.isConnected) {
    renderPlaceholder(host.__cmtPh, host, reason);
    return;
  }
  const parent = host.parentNode;
  if (!parent) {
    host.style.display = 'none';
    return;
  }
  const ph = document.createElement('div');
  ph.className = PH_CLASS;
  ph.style.cssText = [
    'display:flex', 'align-items:center', 'gap:8px', 'margin:4px 0', 'padding:6px 10px',
    'border-radius:8px', 'background:rgba(251,114,153,.08)', 'border:1px dashed rgba(251,114,153,.45)',
    'font-size:12px', 'color:#9499a0', 'cursor:pointer', 'user-select:none', 'line-height:1.5',
  ].join(';');
  ph.innerHTML =
    '<span class="zbb-ph-txt" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>' +
    '<span class="zbb-ph-act" style="color:#fb7299;flex:none"></span>';
  ph.addEventListener('click', () => {
    host.__cmtExpanded = !host.__cmtExpanded;
    renderPlaceholder(ph, host, reason);
  });
  parent.insertBefore(ph, host);
  host.__cmtPh = ph;
  renderPlaceholder(ph, host, reason);
}

export interface CommentFilterOptions {
  /** 用哪个文档装监听（扩展里就是当前页面） */
  doc?: Document;
  getRules: () => CompiledComments;
  /** 命中回调：用于记一条挡记录 */
  onHit?: (uname: string, reason: string) => void;
}

export interface CommentFilterHandle {
  /** 重新判定所有已收进来的评论（配置变更后调用） */
  rescan: () => void;
  stop: () => void;
}

/**
 * 装上评论过滤：hook attachShadow 收集评论组件的影子树，逐条判定。
 * 必须在 document-start 装——评论组件在页面脚本里 attachShadow，晚了就收不到。
 */
export function installCommentFilter(opts: CommentFilterOptions): CommentFilterHandle {
  const doc = opts.doc ?? document;
  const roots = new Set<ShadowRoot>();
  let stopped = false;

  const scanRoot = (root: ParentNode): void => {
    if (stopped) return;
    const cc = opts.getRules();
    if (!cc.rules.enabled) return;
    const tags = Object.keys(COMMENT_TAGS).join(',');
    root.querySelectorAll(tags).forEach((el) => evaluateHost(el as CommentHost));
  };

  /** 判一条评论宿主；命中折叠，规则改了不再命中就放回来 */
  const evaluateHost = (host: CommentHost): void => {
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
        host.style.display = '';
        host.__cmtPh?.remove();
        host.__cmtPh = null;
      }
      return;
    }
    if (host.__cmtHit === reason) return; // 已经是这个原因折叠着，不重复处理
    collapseComment(host, reason);
    opts.onHit?.(info.uname, reason);
  };

  const scanAll = (): void => {
    for (const root of roots) scanRoot(root);
  };

  // 评论组件是 Web Component：影子树里的变化不冒泡到 document，必须逐个观察
  const observer = new MutationObserver(() => scanAll());

  const watchRoot = (root: ShadowRoot): void => {
    if (roots.has(root)) return;
    roots.add(root);
    try {
      observer.observe(root, { childList: true, subtree: true });
    } catch {
      /* 个别 root 观察失败不影响其它 */
    }
    scanRoot(root);
  };

  // attachShadow 钩子：先于页面脚本，才能收到评论区组件。
  // 这里不能直接写 `Element`：极端环境（比如沙箱里的最小 document 桩）没有这个全局。
  const win = doc.defaultView;
  const ElementCtor = (win && win.Element) || (typeof Element !== 'undefined' ? Element : undefined);
  const proto = ElementCtor?.prototype as (Element & {
    attachShadow?: (init: ShadowRootInit) => ShadowRoot;
  }) | undefined;
  const orig = proto?.attachShadow;
  if (proto && typeof orig === 'function' && !(orig as { __zbb?: boolean }).__zbb) {
    const patched = function (this: Element, init: ShadowRootInit): ShadowRoot {
      const root = orig.call(this, init);
      try {
        if (isCommentTag(this.tagName)) watchRoot(root);
      } catch {
        /* 收集失败不影响页面 */
      }
      return root;
    } as typeof orig & { __zbb?: boolean };
    patched.__zbb = true;
    proto.attachShadow = patched as typeof proto.attachShadow;
  }

  // 已经存在的影子树（脚本注入前就创建好的）：既观察影子树里的子评论，
  // 也要把宿主自己判一遍——只 querySelectorAll 影子树会漏掉顶层那一条
  doc.querySelectorAll(Object.keys(COMMENT_TAGS).join(',')).forEach((el) => {
    const host = el as CommentHost;
    evaluateHost(host);
    if (el.shadowRoot) watchRoot(el.shadowRoot);
  });

  return {
    rescan: scanAll,
    stop: () => {
      stopped = true;
      observer.disconnect();
      roots.clear();
    },
  };
}
