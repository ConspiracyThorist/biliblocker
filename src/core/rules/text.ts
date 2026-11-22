/**
 * 规则文本匹配：归一、编译、作用域关键词。
 *
 * 移植自 biliHoyoFairy 的 match/normalize.ts（作者 gendu-amd，MIT），
 * 去掉了简繁归一（2.8k 字表，本产品默认不用）与订阅/导入相关的分支，其余语义保持一致：
 * 普通词合并成一条正则（热路径只跑一次 test），/正则/ 各自编译并保留 flags。
 */

/** 小写 + trim；非字符串一律按空串处理 */
export const lc = (s: unknown): string => (s || '').toString().trim().toLowerCase();

/** 全角 → 半角（含全角空格），防止用全角字符绕过关键词 */
export function toHalfWidth(s: unknown): string {
  return (s || '')
    .toString()
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 隐形字符（零宽空格 / 方向控制符）：纯绕过手段、零误伤，始终剔除 */
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
export const stripInvisible = (s: unknown): string => (s || '').toString().replace(INVISIBLE_RE, '');

/**
 * 分隔符：fuzzy 开启时从文本与普通词两侧一并剔除，
 * 让「原 神 / 原.神 / 原·神」也能命中；但只跨分隔符、不跨文字，
 * 所以「原创神作」不会命中「原神」。
 */
const SEP_RE = /[\s_.·・･﹒。,，、;；:：!！?？~～^*"'`|｜/\\()（）【】<>《》[\]—-]+/g;

/** 模糊匹配开关（默认开），由上层按设置注入 */
let getFuzzy: () => boolean = () => true;
export function configureFuzzy(fn: () => boolean): void {
  getFuzzy = fn;
}

// 匹配前对文本的归一：全角→半角 + 小写 + 去隐形（+ fuzzy 时去分隔符）。
// 单格 memo：一张卡要归一 6~8 次，而同一段文本会被反复问。
let memoSrc: unknown;
let memoFuzzy: boolean | undefined;
let memoOut = '';
export function normMatch(s: unknown): string {
  const fuzzy = getFuzzy();
  if (s === memoSrc && fuzzy === memoFuzzy) return memoOut;
  let t = stripInvisible(toHalfWidth(s)).toLowerCase();
  if (fuzzy) t = t.replace(SEP_RE, '');
  memoSrc = s;
  memoFuzzy = fuzzy;
  memoOut = t;
  return t;
}

export interface Matcher {
  /** 所有普通词合并成的一条正则 */
  plain: RegExp | null;
  /** 逐条编译的 /正则/ */
  regexes: RegExp[];
  empty: boolean;
  /** 以下三项只给「是哪条规则命中的」冷路径用 */
  plainSrc: string[];
  plainNorm: string[];
  regexSrc: string[];
}

/** 单条 /正则/ 模式体的长度上限（针对导入的不可信正则） */
const MAX_REGEX_LEN = 1000;

/**
 * 灾难性回溯启发式（非完备，仅挡最常见形态）：量词作用于「本身含无界量词」的分组，
 * 如 (a+)+ / (a*)* / (a+){2,}——这类对中等长度文本就能指数级回溯卡死页面。
 */
function looksCatastrophic(src: string): boolean {
  return /\((?:[^()]*[*+]|[^()]*\{\d+,\}?)[^()]*\)\s*(?:[*+]|\{\d+,\}?)/.test(src);
}

/** 这条 /正则/ 会被引擎拒收吗；null = 正常编译。正则测试器与引擎共用同一个判据 */
export function regexRejectReason(body: string): string | null {
  if (body.length > MAX_REGEX_LEN) return `模式体超过 ${MAX_REGEX_LEN} 字符`;
  if (looksCatastrophic(body)) return '疑似灾难性回溯（量词套在含无界量词的分组上，如 (a+)+），可能卡死页面';
  return null;
}

/**
 * 规则数组的唯一入口：存档/导入可能把字段写成字符串或对象，
 * `for..of "原神"` 会按字符遍历编译出「原」「神」两条单字规则，足以屏蔽整个首页。
 */
export function ruleLines(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  return lines.filter((x): x is string => typeof x === 'string');
}

/** 把一组规则行编译成匹配器 */
export function compileLines(lines: readonly string[] | null | undefined): Matcher {
  const plainParts: string[] = [];
  const plainSrc: string[] = [];
  const plainNorm: string[] = [];
  const regexes: RegExp[] = [];
  const regexSrc: string[] = [];

  for (const raw of ruleLines(lines)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\/(.*)\/([a-z]*)$/);
    if (m) {
      if (regexRejectReason(m[1])) continue;
      try {
        // 剥掉 g/y：编译出的 RegExp 跨多张卡复用，lastIndex 粘连会间歇漏判
        const flags = (m[2] || 'i').replace(/[gy]/g, '');
        regexes.push(new RegExp(m[1], flags.includes('i') ? flags : `${flags}i`));
        regexSrc.push(line);
      } catch {
        /* 非法正则：忽略该行 */
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

  let plain: RegExp | null = null;
  if (plainParts.length) {
    try {
      plain = new RegExp(plainParts.join('|'), 'i');
    } catch {
      /* 各部分已转义，理论上不会到这里 */
    }
  }
  return { plain, regexes, empty: !plain && !regexes.length, plainSrc, plainNorm, regexSrc };
}

export function textHit(text: unknown, matcher: Matcher | null | undefined): boolean {
  if (!text || !matcher) return false;
  if (matcher.plain && matcher.plain.test(normMatch(text))) return true;
  if (matcher.regexes.length) {
    // 正则按用户写法原样匹配，只去隐形字符防零宽绕过
    const t = stripInvisible(text);
    for (const r of matcher.regexes) if (r.test(t)) return true;
  }
  return false;
}

/** 是哪条规则命中的：冷路径回查，判定顺序与 textHit 一致 */
export function whichHit(text: unknown, matcher: Matcher | null | undefined): string | null {
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

/** 关键词作用域：title: / up: / part: 前缀限定字段，不写 = 全字段 */
export type KwScope = 'title' | 'up' | 'part';

export interface ScopedKw {
  all: Matcher;
  title: Matcher;
  up: Matcher;
  part: Matcher;
}

export function compileScopedKeywords(lines: readonly string[] | null | undefined): ScopedKw {
  const buckets: Record<'all' | KwScope, string[]> = { all: [], title: [], up: [], part: [] };
  for (const raw of ruleLines(lines)) {
    const line = raw.trim();
    if (!line) continue;
    const m = !line.startsWith('/') && line.match(/^(title|up|part)\s*:\s*(.+)$/i);
    if (m) buckets[m[1].toLowerCase() as KwScope].push(m[2].trim());
    else buckets.all.push(line);
  }
  return {
    all: compileLines(buckets.all),
    title: compileLines(buckets.title),
    up: compileLines(buckets.up),
    part: compileLines(buckets.part),
  };
}

/** 针对某字段判定：无前缀的词对所有字段生效，带前缀的只对对应字段生效 */
export function kwHit(scoped: ScopedKw | null | undefined, field: KwScope, text: unknown): boolean {
  if (!scoped || !text) return false;
  return textHit(text, scoped.all) || textHit(text, scoped[field]);
}

/** kwHit 的解释版（冷路径） */
export function kwWhich(scoped: ScopedKw | null | undefined, field: KwScope, text: unknown): string | null {
  if (!scoped || !text) return null;
  return whichHit(text, scoped.all) || whichHit(text, scoped[field]);
}

/**
 * 把用户输入拆成规则数组（正则感知）：换行总是分隔；
 * 以 / 开头的行视为整条正则、不按逗号拆，避免拆断 /震惊{2,3}/ 这类含逗号的正则。
 */
export function splitRuleInput(raw: unknown): string[] {
  const out: string[] = [];
  for (const ln of String(raw || '').split('\n')) {
    const s = ln.trim();
    if (!s) continue;
    if (s[0] === '/') {
      out.push(s);
      continue;
    }
    for (const x of s.split(/[,，;；]/)) {
      const v = x.trim();
      if (v) out.push(v);
    }
  }
  return out;
}
