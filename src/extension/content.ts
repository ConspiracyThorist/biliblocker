import { attachUpButton, cardOwner, extractTitle, hideCard, startScanner, unhideAll } from '../core/dom';
import { compileComments, DEFAULT_COMMENT_RULES, installCommentFilter, type CommentFilterHandle, type CompiledComments } from '../core/comments';
import { unwrapSettings } from '../core/store';
import { installCommentImagePreload } from '../core/preload';
import { preparePool, type HotEntry } from '../core/engine';
import { splitByFreshness, type PoolEntry } from '../core/pool';
import { extractCardInfo } from '../core/rules/domCard';
import { compileRulesCached, matchCard, type CompiledRules } from '../core/rules/rules';
import { type UpEntry } from '../core/ups';
import { mountWidget } from '../core/widget';
import {
  DEFAULT_SETTINGS,
  KEYS,
  RECORD_LIMIT,
  type HitRecord,
  type HotPool,
  type Settings,
  type Stats,
} from '../core/types';

/**
 * 隔离世界（默认 world）：负责 storage 读写、DOM 兜底层、右下角浮窗、以及与 MAIN world 的桥。
 * MAIN world 拿不到 chrome.storage，所以这里是唯一的数据源。
 */
let settings: Settings = { ...DEFAULT_SETTINGS };
/** 题库原文按新鲜度分两段：MAIN world 要自己重建 bigram 表，这里只负责传标题 */
let freshTitles: string[] = [];
let staleTitles: string[] = [];
/** 带索引的池子：DOM 兜底层用，和 MAIN world 的判定结论保持一致 */
let pool: HotEntry[] = [];
/** 编译好的规则；配置变更时重编 */
let rules: CompiledRules | null = null;
/** 编译好的评论规则 + 已装上的评论区过滤器 */
let commentRules: CompiledComments = compileComments(DEFAULT_COMMENT_RULES);
let commentFilter: CommentFilterHandle | null = null;
/** 扫描器；storage 监听可能先于它注册完成，所以允许暂时为空 */
let scanner: ReturnType<typeof startScanner> | null = null;
let records: HitRecord[] = [];
let statsTotal = 0;
let sessionHits = 0;
let flushTimer = 0;
let loaded = false;
let widget: ReturnType<typeof mountWidget> | null = null;
let ups: UpEntry[] = [];

function addUp(mid: number, name: string): void {
  if (ups.some((u) => u.mid === mid)) return;
  ups = [...ups, { mid, name, source: 'manual', addedAt: Date.now() }];
  void chrome.storage.local.set({
    [KEYS.ups]: { entries: ups, updatedAt: Date.now(), error: '' },
  });
  // 匿名贡献：只发 mid 和名字，不带任何用户标识
  try {
    chrome.runtime.sendMessage({ type: 'SUBMIT_UP', mid, name });
  } catch {
    /* 扩展上下文失效时忽略，本地屏蔽已经生效 */
  }
  showContributeNotice();
  postState();
  widget?.refresh();
}

/** 首次贡献时提示一次，之后不再打扰 */
function showContributeNotice(): void {
  const KEY = 'zbb:contribute-notice';
  try {
    if (localStorage.getItem(KEY)) return;
    localStorage.setItem(KEY, '1');
  } catch {
    return;
  }
  if (!settings.contributeUps) return;

  const tip = document.createElement('div');
  tip.textContent = '已匿名提交到公共 UP 库（仅上传 UP 编号，可在扩展设置里关闭）';
  tip.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:64px', 'transform:translateX(-50%)',
    'z-index:2147483641', 'padding:8px 14px', 'border-radius:999px',
    'background:rgba(20,22,27,.92)', 'color:#e8eaed', 'font:12px/1.5',
    '-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
    'border:1px solid rgba(255,255,255,.16)', 'pointer-events:none',
  ].join(';');
  document.body?.appendChild(tip);
  window.setTimeout(() => tip.remove(), 5200);
}

/** 池子按新鲜度切两段：老条目在匹配时要更高的分数 */
function rebuild(entries: PoolEntry[]): void {
  const split = splitByFreshness(entries, Date.now(), 7);
  freshTitles = split.fresh.map((e) => e.title);
  staleTitles = split.stale.map((e) => e.title);
  pool = preparePool(freshTitles, staleTitles);
  rules = compileRulesCached(settings.rules ?? DEFAULT_SETTINGS.rules);
  commentRules = compileComments(settings.comments ?? DEFAULT_COMMENT_RULES);
}

function postState(): void {
  try {
    window.postMessage(
      {
        __zbb: 'ext',
        type: 'state',
        payload: {
          enabled: settings.enabled,
          threshold: settings.threshold,
          minLen: settings.minLen,
          whitelist: settings.whitelist,
          titles: freshTitles,
          staleTitles,
          // 规则要送进 MAIN world 由那边编译（编译产物含正则，不能直接跨世界传）
          rules: settings.rules,          blockedUps: settings.upBlockEnabled ? ups.map((entry) => entry.mid) : [],
          loaded: true,
        },
      },
      '*',
    );
  } catch {
    /* 页面导航中可能抛错，忽略 */
  }
}

function pushRecord(record: HitRecord): void {
  const dup = records.some(
    (r) => r.biliTitle === record.biliTitle && r.zhihuTitle === record.zhihuTitle,
  );
  if (!dup) {
    records.unshift(record);
    if (records.length > RECORD_LIMIT) records = records.slice(0, RECORD_LIMIT);
    sessionHits += 1;
    statsTotal += 1;
  }
  widget?.refresh();
  if (flushTimer) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    void chrome.storage.local.set({
      [KEYS.records]: records,
      [KEYS.stats]: { total: statsTotal },
    });
  }, 300);
}

function applySettings(next: Partial<Settings>): void {
  settings = { ...DEFAULT_SETTINGS, ...next };
  // 任何配置变更都要重编规则并把已隐藏的卡片放出来重新判定：
  // 删掉一条规则、把 UP 移出黑名单、换强度档位——已隐藏的卡片必须当场恢复，
  // 否则用户看到的就是「删了还在」（Greasyfork 反馈里被点名的问题）。
  rules = compileRulesCached(settings.rules ?? DEFAULT_SETTINGS.rules);
  commentRules = compileComments(settings.comments ?? DEFAULT_COMMENT_RULES);
  unhideAll();
  scanner?.rescan();
  commentFilter?.rescan();
  postState();
}

/** 题库只有一种存储结构：entries + 元信息 */
function entriesOf(value: unknown): PoolEntry[] {
  const pool = value as HotPool | null;
  return Array.isArray(pool?.entries) ? pool.entries : [];
}

async function load(): Promise<void> {
  const data = await chrome.storage.local.get({
    [KEYS.settings]: DEFAULT_SETTINGS,
    [KEYS.hot]: null,
    [KEYS.records]: [],
    [KEYS.stats]: { total: 0 },
    [KEYS.ups]: null,
  });

  settings = unwrapSettings(data[KEYS.settings], DEFAULT_SETTINGS).data;
  rebuild(entriesOf(data[KEYS.hot]));
  records = (data[KEYS.records] as HitRecord[]) ?? [];
  statsTotal = (data[KEYS.stats] as Stats | undefined)?.total ?? 0;
  ups = (data[KEYS.ups] as { entries?: UpEntry[] } | null)?.entries ?? [];
  loaded = true;
  postState();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[KEYS.settings]) {
    applySettings(unwrapSettings(changes[KEYS.settings].newValue, DEFAULT_SETTINGS).data);
  }
  if (changes[KEYS.hot]) {
    rebuild(entriesOf(changes[KEYS.hot].newValue));
    postState();
  }
  if (changes[KEYS.records]) {
    records = (changes[KEYS.records].newValue as HitRecord[]) ?? records;
  }
  if (changes[KEYS.ups]) {
    ups = (changes[KEYS.ups].newValue as { entries?: UpEntry[] } | null)?.entries ?? [];
    postState();
  }
});

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as { __zbb?: string; type?: string; payload?: HitRecord } | null;
  if (!data || data.__zbb !== 'page') return;
  if (data.type === 'ready') {
    // 还没读完 storage 就先别回空列表，等 load 完成后它会主动 postState
    if (loaded) postState();
  } else if (data.type === 'hit' && data.payload) {
    pushRecord(data.payload);
  }
});

scanner = startScanner({
  settings: () => settings,
  hot: () => pool,
  onCard: (card) => {
    // 已经挂过按钮的卡片直接跳过，避免每轮扫描重复做 DOM 查询
    if (card.querySelector('[data-zbb-up]')) return false;

    // 规则层（关键词/UP/UID/BV/分区/数值/卡片类型）：按 DOM 抽到的信息判，
    // 与 MAIN world 的网络层用同一套 matchCard，两层结论一致。
    if (settings.enabled && rules) {
      // 广告角标要遍历全卡节点，只有开了「屏蔽广告卡」才付这份成本
      const info = extractCardInfo(card, { detectAd: rules.hideAd });
      const hit = matchCard(info, rules);
      if (hit) {
        pushRecord({
          biliTitle: info.title || extractTitle(card) || '（无标题广告位）',
          zhihuTitle: '',
          score: 1,
          reason: 'rule',
          detail: hit.reason,
          layer: 'dom',
          at: Date.now(),
        });
        hideCard(card);
        return true;
      }
    }

    const owner = cardOwner(card);
    if (!owner) return false;
    // UP 库命中：整张卡片藏掉，不再走标题匹配
    if (settings.upBlockEnabled && ups.some((entry) => entry.mid === owner.mid)) {
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
    pushRecord({
      biliTitle,
      zhihuTitle: result.zhihuTitle,
      score: result.score,
      reason: result.reason === 'none' ? 'dice' : result.reason,
      detail: result.detail,
      layer: 'dom',
      at: Date.now(),
    });
  },
});

void load().then(() => {
  // 列表到达时可能已经有卡片渲染出来了，补扫一遍，别等到下一个定时周期
  scanner?.scan();
  widget?.refresh();
});

// 评论区过滤：必须在 document-start 装（评论组件是 Web Component，
// attachShadow 钩子晚了就收不到影子树）
// 评论区大图预加载：滚进视口才拉原图，命中后点开秒开
installCommentImagePreload({ enabled: () => settings.preloadCommentImages !== false });

commentFilter = installCommentFilter({
  getRules: () => commentRules,
  // 评论命中不计入视频拦截记录，避免把两件事混在一个计数里
  onHit: () => {},
});

/** 右下角浮窗：只显示「已拦截 / 累计」，点开才看最近 5 条 */
/** 播放页的当前视频：迷你面板里「屏蔽此 UP」用；非播放页返回 undefined */
function currentVideo(): { title: string; up: string; uid: string } | undefined {
  if (!/\/(video|bangumi)\//.test(location.pathname)) return undefined;
  const titleEl = document.querySelector('h1.video-title, .video-title, h1') as HTMLElement | null;
  const title = (titleEl?.textContent ?? document.title.replace(/[_\-]\s*哔哩哔哩.*$/, '')).trim();
  const upA = document.querySelector(
    'a.up-name, a.up-name__text, a[href*="space.bilibili.com"]',
  ) as HTMLAnchorElement | null;
  const uid = (upA?.getAttribute('href')?.match(/space\.bilibili\.com\/(\d+)/) ?? [])[1] ?? '';
  return { title: title || '当前视频', up: (upA?.textContent ?? '').trim(), uid };
}

function mountUi(): void {
  if (widget || !document.documentElement) return;
  widget = mountWidget({
    getSession: () => sessionHits,
    getTotal: () => statsTotal,
    getPool: () => pool.length,
    getRecords: () => records,
    getCurrent: currentVideo,
    onBlockUp: (uid, name) => {
      const mid = Number(uid);
      if (!Number.isFinite(mid) || mid <= 0) return;
      addUp(mid, name);
      unhideAll();
      scanner?.rescan();
    },
    onAllow: (record) => {
      const whitelist = [...settings.whitelist, record.biliTitle];
      settings = { ...settings, whitelist };
      records = records.filter((r) => r.biliTitle !== record.biliTitle);
      // 只发改动字段，由 background 单写者落盘（rev 校验 + 合并）
      try {
        chrome.runtime.sendMessage({ type: 'PATCH_SETTINGS', patch: { whitelist } });
      } catch {
        /* 扩展上下文失效时不影响已生效的本地状态 */
      }
      void chrome.storage.local.set({ [KEYS.records]: records });
      postState();
      widget?.refresh();
    },
    onOpenSettings: () => {
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_PANEL' });
      } catch {
        /* 扩展上下文失效（比如被重载）时忽略 */
      }
    },
  });
}

if (document.documentElement) mountUi();
else document.addEventListener('DOMContentLoaded', mountUi, { once: true });
