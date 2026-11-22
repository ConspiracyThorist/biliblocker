/**
 * 统一面板：油猴浮层与扩展弹窗共用同一套 DOM/CSS。
 *
 * 设计目标（来自真实用户反馈）：
 *  - 分段导航只有 4 项，窄面板里不折行
 *  - 说明文字不铺在正文里，长解释收进「?」title
 *  - 拦截记录可就地放行、可看到命中原因、标题 hover 展开
 *  - 所有写操作走 onPatch（只发改动字段），不整份覆盖配置
 */
import type { HitRecord, Settings } from './types';
import type { RuleSet } from './rules/rules';
import type { CommentRules } from './comments';
import { buildExport, parseImport } from './rules/import';

export interface PanelState {
  settings: Settings;
  records: HitRecord[];
  total: number;
  /** 题库条目数 */
  poolCount: number;
  /** 上次同步时间戳，0 = 从未 */
  poolAt: number;
  /** 上次同步失败原因 */
  poolError?: string;
  /** 播放页当前视频（用于「屏蔽此 UP」）；非播放页为空 */
  current?: { title: string; up: string; uid: string };
}

export interface PanelOptions {
  /** 挂载点 */
  mount: HTMLElement;
  getState: () => PanelState;
  /** 只发改动字段；由宿主落到 store.patch */
  onPatch: (patch: Partial<Settings>) => void;
  onAllow: (record: HitRecord) => void;
  /** 屏蔽「正在看的这个 UP」（播放页） */
  onBlockUp?: (uid: string, name: string) => void;
  onSyncSeed?: () => void;
  /** 刷新热榜（与同步题库分开：一个拉热榜，一个拉远端题库） */
  onRefresh?: () => void;
  onClose?: () => void;
  /** overlay：页内浮层（满高）；popup：扩展弹窗（自适应） */
  variant?: 'overlay' | 'popup';
}

export interface PanelHandle {
  refresh: () => void;
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  destroy: () => void;
}

const STYLE_ID = 'zbb-panel-style';

const CSS = `
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

const ICONS = {
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6l7-3z"/></svg>',
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="11" width="7" height="10" rx="1.5"/><rect x="3" y="15" width="7" height="6" rx="1.5"/></svg>',
  log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  rules: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h11M19 7h1M4 17h5M13 17h7"/><circle cx="17" cy="7" r="2.2"/><circle cx="11" cy="17" r="2.2"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  cross: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

const TABS = [
  { id: 'overview', name: '概览', icon: ICONS.overview },
  { id: 'log', name: '拦截', icon: ICONS.log },
  { id: 'rules', name: '规则', icon: ICONS.rules },
  { id: 'settings', name: '设置', icon: ICONS.settings },
] as const;

type TabId = (typeof TABS)[number]['id'];

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function fmtAgo(at: number): string {
  if (!at) return '从未同步';
  const diff = Date.now() - at;
  if (diff < 60_000) return '刚刚同步';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前同步`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前同步`;
  return `${Math.floor(diff / 86_400_000)} 天前同步`;
}

/** 命中记录按来源归类，用于概览的分布条 */
function bucket(rec: HitRecord): 'zhihu' | 'rule' | 'other' {
  if (rec.reason === 'rule') return 'rule';
  if (rec.reason === 'exact' || rec.reason === 'contain' || rec.reason === 'dice' || rec.reason === 'cover') return 'zhihu';
  return 'other';
}

function tagOf(rec: HitRecord): { cls: string; text: string } {
  if (rec.reason === 'rule') return { cls: 'rule', text: rec.detail ? rec.detail.split(':')[0] : '规则' };
  if (bucket(rec) === 'zhihu') return { cls: 'zh', text: '知乎题库' };
  return { cls: 'up', text: 'UP 库' };
}

export function mountPanel(opts: PanelOptions): PanelHandle {
  const doc = opts.mount.ownerDocument ?? document;
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (doc.head ?? doc.documentElement).appendChild(style);
  }

  const root = doc.createElement('div');
  root.className = 'zbb-panel';
  root.setAttribute('data-zbb-panel', '1');
  root.innerHTML = `
    <div class="zbb-head">
      <div class="zbb-logo">${ICONS.shield}</div>
      <div class="zbb-name">BiliBlocker</div>
      <div class="zbb-state"><span class="zbb-dot"></span><span class="zbb-state-t">运行中</span></div>
      <div class="zbb-spacer"></div>
      <button class="zbb-iconbtn" data-act="close" title="关闭">${ICONS.x}</button>
    </div>
    <div class="zbb-seg">
      ${TABS.map((t) => `<button data-tab="${t.id}">${t.icon}${t.name}</button>`).join('')}
    </div>
    <div class="zbb-body"><div data-pane="overview"></div><div data-pane="log" class="zbb-hidden"></div><div data-pane="rules" class="zbb-hidden"></div><div data-pane="settings" class="zbb-hidden"></div></div>
    <div class="zbb-foot"><span class="zbb-num">BiliBlocker v1.0.0</span><span class="zbb-spacer"></span><span>网络层 + DOM 兜底</span></div>
  `;
  opts.mount.appendChild(root);

  let active: TabId = 'overview';
  const pane = (id: TabId) => root.querySelector(`[data-pane="${id}"]`) as HTMLElement;

  const setTab = (id: TabId): void => {
    active = id;
    root.querySelectorAll<HTMLButtonElement>('.zbb-seg button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === id);
    });
    for (const t of TABS) pane(t.id).classList.toggle('zbb-hidden', t.id !== id);
    renderActive();
  };

  const patchRules = (patch: Partial<RuleSet>): void => {
    const st = opts.getState();
    opts.onPatch({ rules: { ...st.settings.rules, ...patch } });
  };
  const patchComments = (patch: Partial<CommentRules>): void => {
    const st = opts.getState();
    opts.onPatch({ comments: { ...st.settings.comments, ...patch } });
  };

  const renderOverview = (st: PanelState): string => {
    const counts = { zhihu: 0, rule: 0, other: 0 };
    for (const r of st.records) counts[bucket(r)] += 1;
    const sum = Math.max(1, counts.zhihu + counts.rule + counts.other);
    const pct = (n: number) => `${Math.round((n / sum) * 100)}%`;
    const recent = st.records.slice(0, 3);
    const cur = st.current;
    return `
      ${cur ? `<div class="zbb-card" style="border-color:var(--pink-line)">
        <div class="zbb-eyebrow">正在看</div>
        <div style="font-size:13px;line-height:1.5;margin:5px 0 8px">${esc(cur.title)}</div>
        <div class="zbb-row" style="border:0;padding:0">
          <span class="zbb-num" style="color:var(--text2)">${esc(cur.up || '未知 UP')}</span>
          <span class="zbb-spacer"></span>
          ${cur.uid ? `<button class="zbb-btn pink sm" data-act="block-up" data-uid="${esc(cur.uid)}" data-name="${esc(cur.up)}">屏蔽此 UP</button>` : ''}
        </div>
      </div>` : ''}
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
      <div class="zbb-card" style="padding:2px 13px">${recent.length ? recent.map(hitRow).join('') : '<div class="zbb-empty">还没有拦截记录</div>'}</div>
      <div class="zbb-sect"><h4>题库</h4></div>
      <div class="zbb-card">
        <div class="zbb-row" style="border:0;padding:0">
          <div><div style="font-weight:600" class="zbb-num">${st.poolCount} 条</div><div class="desc">${esc(fmtAgo(st.poolAt))}</div></div>
          <div class="zbb-spacer"></div>
          <button class="zbb-btn sm ghost" data-act="sync">立即同步</button>
        </div>
        ${st.poolError ? `<div class="zbb-hint">上次失败：${esc(st.poolError)}</div>` : ''}
      </div>`;
  };

  const hitRow = (rec: HitRecord): string => {
    const tag = tagOf(rec);
    // 规则命中：detail 形如「关键词:送十连」，前缀已经有徽章了，正文只留具体规则；
    // 没有冒号（例如「广告卡」）说明整串就是维度名，正文留空免得重复
    const raw = rec.reason === 'rule' ? (rec.detail ?? '') : '';
    const why = rec.reason === 'rule' ? (raw.includes(':') ? raw.replace(/^[^:]*:/, '') : '') : `${rec.score.toFixed(2)} ${rec.reason}`;
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

  const renderLog = (st: PanelState): string => {
    if (!st.records.length) return '<div class="zbb-card"><div class="zbb-empty">还没有拦截记录。刷新 B 站首页试试。</div></div>';
    return `<div class="zbb-card" style="padding:2px 13px">${st.records.map(hitRow).join('')}</div>`;
  };

  const chips = (list: string[], group: string): string =>
    list.length
      ? list.map((v, i) => `<span class="zbb-chip">${esc(v)}<i data-act="del" data-group="${group}" data-i="${i}">×</i></span>`).join('')
      : '<span class="zbb-empty">还没有</span>';

  const group = (id: string, name: string, body: string, count?: number): string => `
    <div class="zbb-group" data-group-box="${id}">
      <div class="zbb-ghead" data-act="toggle-group" data-group="${id}">
        <span class="gname">${name}</span>${count != null ? `<span class="count">${count}</span>` : ''}<span class="chev">⌄</span>
      </div>
      <div class="zbb-gbody" data-group-body="${id}">${body}</div>
    </div>`;

  const numRow = (label: string, key: keyof RuleSet['block'], value: number, unit: string): string => `
    <div class="zbb-row"><span class="label">${label}</span><span class="zbb-spacer"></span>
      <input class="zbb-num" data-num="${key}" value="${value}" style="width:56px;text-align:right;background:#141518;border:1px solid var(--line);border-radius:7px;color:var(--text);padding:3px 7px;font:inherit;font-size:12px">${unit}
    </div>`;

  const renderRules = (st: PanelState): string => {
    const r = st.settings.rules;
    return `
      <div class="zbb-quick">
        <input id="zbb-quick-input" placeholder="粘贴标题 / BV 号 / UP 名 / 正则…">
        <button class="zbb-btn pink" data-act="quick-add">添加</button>
      </div>
      <div class="zbb-hint">自动识别：BV 号 → 单视频，纯数字 → UID，/…/ → 正则，其余按标题关键词</div>
      ${group('keywords', '标题关键词', chips(r.keywords, 'keywords'), r.keywords.length)}
      ${group('upNames', 'UP 主名', chips(r.upNames, 'upNames'), r.upNames.length)}
      ${group('uids', 'UID', chips(r.uids, 'uids'), r.uids.length)}
      ${group('bvids', 'BV 号', chips(r.bvids, 'bvids'), r.bvids.length)}
      ${group('partitions', '分区', chips(r.partitions, 'partitions'), r.partitions.length)}
      ${group('allowKeywords', '白名单', chips(r.allowKeywords, 'allowKeywords'), r.allowKeywords.length)}
      ${group(
        'thresholds',
        '数值阈值',
        `<div class="zbb-gbody block" style="padding:0">
          ${numRow('播放少于', 'minViews', r.block.minViews, '万')}
          ${numRow('播放多于', 'maxViews', r.block.maxViews, '万')}
          ${numRow('点赞少于', 'minLikes', r.block.minLikes, '个')}
          ${numRow('时长少于', 'minDuration', r.block.minDuration, '秒')}
          ${numRow('时长多于', 'maxDuration', r.block.maxDuration, '秒')}
          ${numRow('营销号赞率低于', 'spamLikeRatio', r.block.spamLikeRatio, '%')}
         </div>`,
      )}
      ${group(
        'cardTypes',
        '卡片类型',
        `<div class="zbb-gbody block" style="padding:0">
          <div class="zbb-row"><span class="label">广告 / 推广卡</span><span class="zbb-spacer"></span><button class="zbb-tgl ${r.hideAd ? 'on' : ''}" data-act="toggle-rule" data-key="hideAd"></button></div>
          <div class="zbb-row"><span class="label">信息流直播卡</span><span class="zbb-spacer"></span><button class="zbb-tgl ${r.hideLive ? 'on' : ''}" data-act="toggle-rule" data-key="hideLive"></button></div>
         </div>`,
      )}
      ${group(
        'comments',
        '评论区过滤',
        `<div class="zbb-gbody block" style="padding:0">
          <div class="zbb-row"><span class="label">启用评论区过滤</span><span class="zbb-spacer"></span><button class="zbb-tgl ${st.settings.comments.enabled ? 'on' : ''}" data-act="toggle-cmt" data-key="enabled"></button></div>
          <div class="zbb-row"><span class="label">AI 总结机器人</span><span class="zbb-spacer"></span><button class="zbb-tgl ${st.settings.comments.hideBot ? 'on' : ''}" data-act="toggle-cmt" data-key="hideBot"></button></div>
          <div class="zbb-row"><span class="label">默认头像 / 非会员</span><span class="zbb-spacer"></span><button class="zbb-tgl ${st.settings.comments.hideNoFace ? 'on' : ''}" data-act="toggle-cmt" data-key="hideNoFace"></button></div>
          <div class="zbb-row"><span class="label">带货导流评论</span><span class="zbb-spacer"></span><button class="zbb-tgl ${st.settings.comments.hideAd ? 'on' : ''}" data-act="toggle-cmt" data-key="hideAd"></button></div>
          <div class="zbb-row"><span class="label">纯表情 / 纯 @</span><span class="zbb-spacer"></span><button class="zbb-tgl ${st.settings.comments.hideEmojiOnly ? 'on' : ''}" data-act="toggle-cmt" data-key="hideEmojiOnly"></button></div>
         </div>`,
      )}`;
  };

  const renderSettings = (st: PanelState): string => {
    const s = st.settings;
    const modes: { id: string; name: string; n: number }[] = [
      { id: 'conservative', name: '保守', n: 0.86 },
      { id: 'standard', name: '标准', n: 0.78 },
      { id: 'aggressive', name: '激进', n: 0.66 },
    ];
    return `
      <div class="zbb-card">
        <div class="zbb-eyebrow">知乎搬运匹配强度</div>
        <div class="zbb-modes">
          ${modes
            .map(
              (m) =>
                `<button class="zbb-mode ${Math.abs(s.threshold - m.n) < 0.005 ? 'on' : ''}" data-act="mode" data-n="${m.n}"><b>${m.name}</b><span>${m.n}</span></button>`,
            )
            .join('')}
        </div>
        <div class="zbb-hint">只影响「知乎题库」这一路；关键词与 UP 规则不受影响。</div>
      </div>
      <div class="zbb-sect"><h4>通用</h4></div>
      <div class="zbb-card" style="padding:2px 13px">
        <div class="zbb-row"><div><div class="label">启用拦截</div></div><span class="zbb-spacer"></span><button class="zbb-tgl ${s.enabled ? 'on' : ''}" data-act="toggle" data-key="enabled"></button></div>
        <div class="zbb-row"><div><div class="label">UP 库整号屏蔽</div></div><span class="zbb-spacer"></span><button class="zbb-tgl ${s.upBlockEnabled ? 'on' : ''}" data-act="toggle" data-key="upBlockEnabled"></button></div>
        <div class="zbb-row"><div><div class="label">匿名贡献 UP 编号</div><div class="desc">只上传 mid 与昵称</div></div><span class="zbb-spacer"></span><button class="zbb-tgl ${s.contributeUps ? 'on' : ''}" data-act="toggle" data-key="contributeUps"></button></div>
        <div class="zbb-row"><div><div class="label">评论区大图预加载</div><div class="desc">滚进视口就缓存原图，点开秒开；会多花一点流量</div></div><span class="zbb-spacer"></span><button class="zbb-tgl ${s.preloadCommentImages !== false ? 'on' : ''}" data-act="toggle" data-key="preloadCommentImages"></button></div>
      </div>
      <div class="zbb-sect"><h4>题库同步</h4></div>
      <div class="zbb-card" style="padding:2px 13px">
        <div class="zbb-row"><div><div class="label">保留天数</div></div><span class="zbb-spacer"></span><span class="zbb-num">${s.poolDays} 天</span></div>
        <div class="zbb-row"><div><div class="label">条目上限</div></div><span class="zbb-spacer"></span><span class="zbb-num">${s.poolMax}</span></div>
        <div class="zbb-row"><div><div class="label">当前题库</div></div><span class="zbb-spacer"></span><span class="zbb-num">${st.poolCount} 条</span></div>
        <div class="zbb-row" style="padding-bottom:6px"><div><div class="label">远端题库源</div></div><span class="zbb-spacer"></span></div>
        <input id="zbb-seed-url" value="${esc(s.remoteSeedUrls[0] ?? '')}" placeholder="留空则不启用远端题库"
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

  const renderActive = (): void => {
    const st = opts.getState();
    const dot = root.querySelector('.zbb-dot');
    const stateText = root.querySelector('.zbb-state-t');
    dot?.classList.toggle('off', !st.settings.enabled);
    if (stateText) stateText.textContent = st.settings.enabled ? '运行中' : '已暂停';
    const html = active === 'overview' ? renderOverview(st) : active === 'log' ? renderLog(st) : active === 'rules' ? renderRules(st) : renderSettings(st);
    pane(active).innerHTML = html;
  };

  root.addEventListener('click', (event) => {
    const seg = (event.target as HTMLElement).closest('.zbb-seg button') as HTMLElement | null;
    if (seg?.dataset.tab) {
      setTab(seg.dataset.tab as TabId);
      return;
    }
    const el = (event.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!el) return;
    const act = el.dataset.act;
    const st = opts.getState();

    if (act === 'close') {
      opts.onClose?.();
      return;
    }
    if (act === 'tab-log') {
      setTab('log');
      return;
    }
    if (act === 'sync') {
      opts.onSyncSeed?.();
      return;
    }
    if (act === 'refresh') {
      opts.onRefresh?.();
      return;
    }
    if (act === 'open') {
      const key = el.dataset.key ?? '';
      if (key) {
        window.open(`https://search.bilibili.com/all?keyword=${encodeURIComponent(key)}`, '_blank', 'noopener');
      }
      return;
    }
    if (act === 'block-up') {
      const uid = el.dataset.uid ?? '';
      const name = el.dataset.name ?? '';
      if (uid) opts.onBlockUp?.(uid, name);
      return;
    }
    if (act === 'import') {
      const input = root.querySelector('#zbb-import-file') as HTMLInputElement | null;
      input?.click();
      return;
    }
    if (act === 'export') {
      const blob = new Blob([buildExport(st.settings)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `BiliBlocker-rules-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    if (act === 'allow') {
      const key = el.dataset.key ?? '';
      const rec = st.records.find((r) => r.biliTitle === key);
      if (rec) opts.onAllow(rec);
      return;
    }
    if (act === 'toggle') {
      const key = el.dataset.key as keyof Settings;
      opts.onPatch({ [key]: !st.settings[key] } as Partial<Settings>);
      return;
    }
    if (act === 'toggle-rule') {
      const key = el.dataset.key as 'hideAd' | 'hideLive';
      patchRules({ [key]: !st.settings.rules[key] } as Partial<RuleSet>);
      return;
    }
    if (act === 'toggle-cmt') {
      const key = el.dataset.key as keyof CommentRules;
      patchComments({ [key]: !st.settings.comments[key] } as Partial<CommentRules>);
      return;
    }
    if (act === 'mode') {
      opts.onPatch({ threshold: Number(el.dataset.n) });
      return;
    }
    if (act === 'del') {
      const g = el.dataset.group as keyof RuleSet;
      const i = Number(el.dataset.i);
      const list = [...(st.settings.rules[g] as string[])];
      list.splice(i, 1);
      patchRules({ [g]: list } as Partial<RuleSet>);
      return;
    }
    if (act === 'toggle-group') {
      const body = root.querySelector(`[data-group-body="${el.dataset.group}"]`);
      body?.classList.toggle('zbb-hidden');
      el.querySelector('.chev')!.textContent = body?.classList.contains('zbb-hidden') ? '›' : '⌄';
      return;
    }
    if (act === 'quick-add') {
      const input = root.querySelector('#zbb-quick-input') as HTMLInputElement | null;
      const raw = (input?.value ?? '').trim();
      if (!raw) return;
      const next: Partial<RuleSet> = {};
      if (/^BV[0-9A-Za-z]+$/.test(raw)) next.bvids = [...st.settings.rules.bvids, raw];
      else if (/^\d{2,}$/.test(raw)) next.uids = [...st.settings.rules.uids, raw];
      else next.keywords = [...st.settings.rules.keywords, raw];
      patchRules(next);
      if (input) input.value = '';
      return;
    }
  });

  root.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement;
    if (target.id === 'zbb-import-file') {
      const file = target.files?.[0];
      if (!file) return;
      void file.text().then((text) => {
        const res = parseImport(text);
        const msg = root.querySelector('#zbb-import-msg');
        if (!res.ok || !res.patch) {
          if (msg) msg.textContent = `导入失败：${res.error ?? '未知错误'}`;
          return;
        }
        opts.onPatch(res.patch);
        const skip = res.skipped.length ? `；跳过：${res.skipped.join('、')}` : '';
        // 面板会因配置变更重渲染，等它刷完再写提示
        setTimeout(() => {
          const el = root.querySelector('#zbb-import-msg');
          if (el) el.textContent = `已导入 ${res.imported} 条规则${skip}（已保存）`;
        }, 80);
      });
      return;
    }
    if (target.id === 'zbb-seed-url') {
      const url = target.value.trim();
      opts.onPatch({ remoteSeedUrls: url ? [url] : [] });
      return;
    }
    const key = target.dataset?.num as keyof RuleSet['block'] | undefined;
    if (!key) return;
    const value = Number(target.value) || 0;
    const st = opts.getState();
    patchRules({ block: { ...st.settings.rules.block, [key]: value } });
  });

  setTab('overview');

  return {
    refresh: renderActive,
    open: () => root.classList.remove('zbb-hidden'),
    close: () => root.classList.add('zbb-hidden'),
    isOpen: () => !root.classList.contains('zbb-hidden'),
    destroy: () => root.remove(),
  };
}
