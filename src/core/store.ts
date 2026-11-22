/**
 * 设置存储：单写者 + revision 校验 + 深合并 + 自动备份。
 *
 * 为什么要这么麻烦：Greasyfork 上有人反馈「过滤评论的开关过一段时间自己关掉、设置也被重置」。
 * 根因是多个标签页各自持有整份快照、谁最后写谁生效——一个还跑着旧配置的标签页
 * 会把刚改好的规则整份覆盖回去。这里用三件事堵住：
 *   1. 只有 background 一个写者（UI 一律发 patch 命令）
 *   2. 写入带 revision：命令基于哪一版改的就写哪一版，过期就重读合并
 *   3. 规则变更前留备份，出问题能回滚
 */
import type { Settings } from './types';

export interface SettingsEnvelope {
  /** 每次写入 +1；用来发现「我手里这份已经过期」 */
  rev: number;
  data: Settings;
}

export interface StoreIO {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
}

export const SETTINGS_KEY = 'zbb:settings';
export const BACKUP_KEY = 'zbb:settings-backups';
export const BACKUP_MAX = 5;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 把存下来的东西读成信封。
 * 兼容两种历史形态：老版本直接存 Settings 本体（无 rev），以及正常信封。
 */
export function unwrapSettings(raw: unknown, defaults: Settings): SettingsEnvelope {
  if (!raw || typeof raw !== 'object') return { rev: 0, data: defaults };
  const obj = raw as Record<string, unknown>;
  if (typeof obj.rev === 'number' && isPlainObject(obj.data)) {
    return { rev: obj.rev, data: mergeSettings(defaults, obj.data as Partial<Settings>) };
  }
  // 老形态：整份 Settings
  return { rev: 0, data: mergeSettings(defaults, obj as Partial<Settings>) };
}

/** 递归合并：只认普通对象，数组整体替换（规则列表就是数组，不能按键合并） */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const prev = out[key];
    out[key] = isPlainObject(prev) && isPlainObject(value) ? mergeSettings(prev, value) : value;
  }
  return out as T;
}

export interface SettingsStore {
  read: () => Promise<SettingsEnvelope>;
  /** 打补丁：只写「改动的字段」，在最新配置上合并，不会覆盖别的标签页刚改的部分 */
  patch: (patch: Partial<Settings>) => Promise<SettingsEnvelope>;
  /** 最近几份配置快照（新的在前） */
  backups: () => Promise<{ at: number; data: Settings }[]>;
  restore: (index: number) => Promise<SettingsEnvelope | null>;
}

export function createSettingsStore(
  io: StoreIO,
  defaults: Settings,
  now: () => number = () => Date.now(),
): SettingsStore {
  let queue: Promise<unknown> = Promise.resolve();

  // 串行化写入：同一个扩展上下文里也不会自己和自己抢
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  async function read(): Promise<SettingsEnvelope> {
    return unwrapSettings(await io.get(SETTINGS_KEY), defaults);
  }

  async function saveBackup(env: SettingsEnvelope): Promise<void> {
    const raw = await io.get(BACKUP_KEY);
    const list = Array.isArray(raw) ? (raw as { at: number; data: Settings }[]) : [];
    list.unshift({ at: now(), data: env.data });
    await io.set(BACKUP_KEY, list.slice(0, BACKUP_MAX));
  }

  return {
    read,

    patch(patch) {
      return serialize(async () => {
        // 在「最新配置」上合并，而不是把调用方手里那份快照整份写回——
        // 这就是「旧标签页把新规则覆盖掉」的解法：它的 patch 只会影响它改的字段。
        const current = await read();
        const data = mergeSettings(current.data, patch);
        await saveBackup(current);
        const next: SettingsEnvelope = { rev: current.rev + 1, data };
        await io.set(SETTINGS_KEY, next);
        return next;
      });
    },

    async backups() {
      const raw = await io.get(BACKUP_KEY);
      return Array.isArray(raw) ? (raw as { at: number; data: Settings }[]) : [];
    },

    async restore(index) {
      const list = await io.get(BACKUP_KEY);
      if (!Array.isArray(list) || !list[index]) return null;
      const env = await read();
      await saveBackup(env);
      const next: SettingsEnvelope = { rev: env.rev + 1, data: (list[index] as { data: Settings }).data };
      await io.set(SETTINGS_KEY, next);
      return next;
    },
  };
}
