/**
 * 评论区大图预加载。
 *
 * 背景（来自 bili-comment-preload 的实测）：评论区网格里是带 CDN 转码参数的缩略图
 * （~15 KB），点开后换成 i0 主机的原图（1~4 MB）——体积差 100 倍，所以点开必然转圈。
 * 这里不改界面、不拦请求：图片滚进视口时用 new Image() 把原图拉一遍，
 * 浏览器把响应放进 HTTP 缓存，点击时同一 URL 直接命中。
 *
 * 只在评论区图片附近工作：IntersectionObserver 观察缩略图，命中才发请求，
 * 并发上限 3，避免和视频抢带宽。
 */
const PRELOADED = new Set<string>();
const MAX_REMEMBER = 400;

/** 缩略图 URL → 原图 URL：剥掉 @ 参数，主机换成 i0（大图查看器走 i0，换成同主机才能命中同一条缓存） */
export function originalUrl(src: string): string | null {
  if (!src || !/hdslb\.com/.test(src)) return null;
  const base = src.split('@')[0];
  if (!base) return null;
  return base.replace(/\/\/i\d\.hdslb\.com\//, '//i0.hdslb.com/');
}

export interface PreloadOptions {
  doc?: Document;
  /** 总开关（关掉时不装观察器） */
  enabled: () => boolean;
  maxConcurrent?: number;
}

/** 装预加载；返回卸载函数。任何异常都静默——它只是优化，不能影响页面。 */
export function installCommentImagePreload(opts: PreloadOptions): () => void {
  const doc = opts.doc ?? document;
  const limit = opts.maxConcurrent ?? 2;
  let active = 0;
  const queue: string[] = [];

  const pump = (): void => {
    while (active < limit && queue.length) {
      const url = queue.shift()!;
      active += 1;
      const img = new Image();
      const done = (): void => {
        active -= 1;
        pump();
      };
      img.onload = done;
      img.onerror = done;
      img.src = url;
    }
  };

  const preload = (url: string): void => {
    if (!opts.enabled()) return;
    if (PRELOADED.has(url)) return;
    if (PRELOADED.size >= MAX_REMEMBER) PRELOADED.clear();
    PRELOADED.add(url);
    queue.push(url);
    pump();
  };

  const io =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const img = entry.target as HTMLImageElement;
              const url = originalUrl(img.currentSrc || img.src);
              if (url) preload(url);
              io!.unobserve(img);
            }
          },
          { rootMargin: '200px' },
        )
      : null;

  const observe = (root: ParentNode): void => {
    if (!io) return;
    root.querySelectorAll('img').forEach((img) => {
      const src = img.currentSrc || img.src;
      if (src && /hdslb\.com/.test(src) && /new_dyn|bfs\//.test(src)) io.observe(img);
    });
  };

  // 评论区是 Web Component，图片在影子树里：已有的先扫一遍，之后靠 MutationObserver 增量
  const roots = new Set<ShadowRoot>();
  const watch = (root: ShadowRoot): void => {
    if (roots.has(root)) return;
    roots.add(root);
    observe(root);
    try {
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1) observe(n as Element);
          }
        }
      });
      mo.observe(root, { childList: true, subtree: true });
    } catch {
      /* 观察失败只是少预加载一部分 */
    }
  };

  const proto = (doc.defaultView?.Element as typeof Element | undefined)?.prototype as
    | (Element & { attachShadow?: (init: ShadowRootInit) => ShadowRoot })
    | undefined;
  const orig = proto?.attachShadow;
  if (proto && typeof orig === 'function' && !(orig as { __zbbPreload?: boolean }).__zbbPreload) {
    const patched = function (this: Element, init: ShadowRootInit): ShadowRoot {
      const root = orig.call(this, init);
      try {
        if (/COMMENT/i.test(this.tagName)) watch(root);
      } catch {
        /* 忽略 */
      }
      return root;
    } as typeof orig & { __zbbPreload?: boolean };
    patched.__zbbPreload = true;
    proto.attachShadow = patched as typeof proto.attachShadow;
  }

  doc.querySelectorAll('bili-comment-thread-renderer, bili-comment-reply-renderer, bili-comments').forEach((el) => {
    if (el.shadowRoot) watch(el.shadowRoot);
  });

  return () => {
    io?.disconnect();
    roots.clear();
    queue.length = 0;
  };
}
