/**
 * 扩展弹窗：只负责取数据 + 装配统一面板。
 * 面板本身在 core/panel.ts，与油猴浮层共用同一套 DOM/CSS。
 */
import { mountPanel } from '../core/panel';
import { unwrapSettings } from '../core/store';
import { DEFAULT_SETTINGS, KEYS, type HitRecord, type HotPool, type Settings, type Stats } from '../core/types';

let settings: Settings = { ...DEFAULT_SETTINGS };
let records: HitRecord[] = [];
let pool: HotPool | null = null;
let total = 0;

const root = document.getElementById('root');
if (!root) throw new Error('popup 缺少挂载点');

const panel = mountPanel({
  mount: root,
  variant: 'popup',
  getState: () => ({
    settings,
    records,
    total,
    poolCount: pool?.entries.length ?? 0,
    poolAt: pool?.updatedAt ?? 0,
    poolError: pool?.error,
  }),
  onPatch: (patch) => {
    void (async () => {
      const res = (await chrome.runtime.sendMessage({ type: 'PATCH_SETTINGS', patch })) as
        | { ok?: boolean; settings?: Settings }
        | undefined;
      if (res?.settings) settings = res.settings;
      panel.refresh();
    })();
  },
  onAllow: (record) => {
    void (async () => {
      const whitelist = settings.whitelist.includes(record.biliTitle)
        ? settings.whitelist
        : [...settings.whitelist, record.biliTitle];
      const res = (await chrome.runtime.sendMessage({ type: 'PATCH_SETTINGS', patch: { whitelist } })) as
        | { ok?: boolean; settings?: Settings }
        | undefined;
      if (res?.settings) settings = res.settings;
      records = records.filter((r) => r.biliTitle !== record.biliTitle);
      await chrome.storage.local.set({ [KEYS.records]: records });
      panel.refresh();
    })();
  },
  onSyncSeed: () => {
    void (async () => {
      await chrome.runtime.sendMessage({ type: 'SYNC_SEED' });
      await readState();
    })();
  },
  onClose: () => window.close(),
});

async function readState(): Promise<void> {
  const data = await chrome.storage.local.get({
    [KEYS.settings]: null,
    [KEYS.hot]: null,
    [KEYS.records]: [],
    [KEYS.stats]: { total: 0 },
  });
  settings = unwrapSettings(data[KEYS.settings], DEFAULT_SETTINGS).data;
  pool = (data[KEYS.hot] as HotPool | null) ?? null;
  records = (data[KEYS.records] as HitRecord[]) ?? [];
  total = (data[KEYS.stats] as Stats | undefined)?.total ?? 0;
  panel.refresh();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[KEYS.records]) records = (changes[KEYS.records].newValue as HitRecord[]) ?? records;
  if (changes[KEYS.hot]) pool = (changes[KEYS.hot].newValue as HotPool | null) ?? pool;
  if (changes[KEYS.stats]) total = (changes[KEYS.stats].newValue as Stats | undefined)?.total ?? total;
  if (changes[KEYS.settings]) settings = unwrapSettings(changes[KEYS.settings].newValue, DEFAULT_SETTINGS).data;
  panel.refresh();
});

void readState();
