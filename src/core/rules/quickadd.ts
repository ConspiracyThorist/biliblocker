/**
 * 规则页「快速添加」的解析逻辑。
 *
 * 之前只有一个输入框 + 正则猜测：`2024` 会被当成 UID、想加 UP 名得知道 `up:` 前缀、
 * 点错了也没法改。这里把「识别」和「添加」拆开：
 *  - 显式指定类型（标题 / UP / UID / BV / 正则 / 分区 / 白名单）时，一律按指定类型走
 *  - 自动模式只做保守猜测，并把猜到的结果明说，用户能一键改成别的类型
 *  - 支持一次粘贴多行
 *
 * 注意：`title:` / `up:` / `part:` 这些**作用域前缀**会被原样保留进关键词列表，
 * 由 `compileScopedKeywords` 解释（字段包含匹配），不要拆成前缀 + 值。
 */

export type QuickKind = 'auto' | 'keyword' | 'up' | 'uid' | 'bv' | 'regex' | 'partition' | 'allow';

export type QuickTarget = 'keyword' | 'up' | 'uid' | 'bv' | 'partition' | 'allow';

export interface QuickHit {
  /** 落到哪一类规则；keyword 里可能带 title: / up: / part: 作用域 */
  target: QuickTarget;
  /** 存进规则列表的值 */
  value: string;
  /** 给用户看的一句说明 */
  note: string;
}

export interface QuickParseResult {
  hits: QuickHit[];
  skipped: string[];
}

const KIND_LABEL: Record<QuickTarget | 'regex', string> = {
  keyword: '标题关键词',
  up: 'UP 主名',
  uid: 'UID',
  bv: 'BV 号',
  regex: '正则',
  partition: '分区',
  allow: '白名单',
};

export function kindLabel(kind: QuickTarget | 'regex'): string {
  return KIND_LABEL[kind];
}

/** 列出当前选中的类型会给一句提示，供面板显示 */
export function kindHint(kind: QuickKind): string {
  if (kind === 'auto') return '自动识别：/…/ 正则、BV 号、长数字 UID，其余按标题关键词；写 up: / title: / part: 可按字段包含匹配';
  return `当前指定为「${KIND_LABEL[kind === 'keyword' ? 'keyword' : kind]}」，不再自动猜测`;
}

/** `/pattern/flags`，允许 pattern 内出现转义斜杠 */
export function isRegexLiteral(text: string): boolean {
  if (text.length < 3 || text[0] !== '/') return false;
  for (let i = text.length - 1; i > 0; i -= 1) {
    if (text[i] !== '/') continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j -= 1) slashes += 1;
    if (slashes % 2 === 1) continue;
    if (!/^[dgimsuvy]*$/.test(text.slice(i + 1))) continue;
    return i > 1;
  }
  return false;
}

export function regexBody(text: string): string {
  const end = text.lastIndexOf('/');
  if (end <= 0) return text;
  return text.slice(1, end);
}

/** 把 `/pattern/flags` 还原成带斜杠的形式（存进关键词列表时要保留） */
export function asRegexLiteral(body: string): string {
  return body.startsWith('/') && isRegexLiteral(body) ? body : `/${body.replace(/\//g, '\\/')}/`;
}

function looksLikeBv(text: string): boolean {
  return /^BV[0-9A-Za-z]{6,}$/i.test(text);
}

const SCOPED = /^(title|up|part(?:ition)?)\s*[:：]\s*(\S[\s\S]*)$/i;

/**
 * 单行解析。`kind` 为 'auto' 时做保守猜测。
 */
export function parseQuickLine(raw: string, kind: QuickKind = 'auto'): QuickHit | null {
  const text = raw.trim();
  if (!text) return null;

  // 1) 作用域前缀：原样保留进关键词，由编译期解释
  const scoped = text.match(SCOPED);
  if (scoped) {
    const field = scoped[1].toLowerCase();
    const label = field.startsWith('part') ? '分区' : field === 'up' ? 'UP 名' : '标题';
    return { target: 'keyword', value: text, note: `按 ${label} 字段包含匹配` };
  }

  // 2) 其它显式前缀：uid: / bv: / allow: / re:
  const prefixed = text.match(/^(uid|bv|allow|re(?:gex)?)\s*[:：]\s*(.+)$/i);
  if (prefixed) {
    const token = prefixed[1].toLowerCase();
    const value = prefixed[2].trim();
    if (token === 'uid') return { target: 'uid', value, note: '按 UID 添加' };
    if (token === 'bv') return { target: 'bv', value, note: '按 BV 号添加' };
    if (token === 'allow') return { target: 'allow', value, note: '按白名单添加' };
    return { target: 'keyword', value: asRegexLiteral(value), note: '按正则添加' };
  }

  // 3) 用户显式指定了类型
  if (kind !== 'auto') {
    if (kind === 'regex') {
      return { target: 'keyword', value: isRegexLiteral(text) ? text : asRegexLiteral(text), note: '按正则添加' };
    }
    return { target: kind, value: text, note: `按${KIND_LABEL[kind]}添加` };
  }

  // 4) 自动：保守判断
  if (isRegexLiteral(text)) return { target: 'keyword', value: text, note: '识别为正则（关键词列表，按 /…/ 解释）' };
  if (looksLikeBv(text)) return { target: 'bv', value: text, note: '识别为 BV 号' };

  if (/^\d+$/.test(text)) {
    if (text.length >= 5) return { target: 'uid', value: text, note: '识别为 UID' };
    return { target: 'keyword', value: text, note: '短数字按标题关键词添加（要当 UID 请点上方 UID）' };
  }

  return { target: 'keyword', value: text, note: '按标题关键词添加' };
}

/** 多行粘贴：逐行解析，空行忽略 */
export function parseQuickInput(text: string, kind: QuickKind = 'auto'): QuickParseResult {
  const hits: QuickHit[] = [];
  const skipped: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const hit = parseQuickLine(line, kind);
    if (hit) hits.push(hit);
    else skipped.push(line.trim());
  }
  return { hits, skipped };
}
