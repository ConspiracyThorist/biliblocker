import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './tools/lib/zip.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const extDir = join(dist, 'extension');

const VERSION = '1.0.1';

const banner = `// ==UserScript==
// @name         BiliBlocker — B站推荐流屏蔽器
// @name:en      BiliBlocker — Bilibili Feed Blocker
// @namespace    biliblocker
// @version      ${VERSION}
// @description  拦截搬运知乎热榜的 B 站视频（渲染前删除，无留白），并按关键词/UP/分区/数值规则过滤推荐流与评论区
// @description:en Block Bilibili feed videos that copy Zhihu hot-list questions, plus rule-based filtering of feeds and comments
// @author       ConspiracyThorist
// @homepageURL  https://github.com/ConspiracyThorist/biliblocker
// @supportURL   https://github.com/ConspiracyThorist/biliblocker/issues
// @icon         https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker@main/assets/icons/icon128.png
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.zhihu.com
// @connect      www.zhihu.com
// @connect      gh-proxy.com
// @connect      fcapp.run
// @connect      fastly.jsdelivr.net
// @connect      raw.githubusercontent.com
// @license      MIT
// @noframes
// ==/UserScript==
`;

/**
 * 直接用 esbuild 的 CLI 二进制，而不是 require('esbuild')。
 * JS API 走子进程管道，在限制 spawn/pipe 的沙箱或 CI 容器里会 EPERM；
 * CLI 走继承 stdio，哪儿都能跑。
 */
function esbuildBinary() {
  const candidates = [
    join(root, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    join(root, 'node_modules', '@esbuild', 'win32-arm64', 'esbuild.exe'),
    join(root, 'node_modules', '@esbuild', 'darwin-arm64', 'bin', 'esbuild'),
    join(root, 'node_modules', '@esbuild', 'linux-x64', 'bin', 'esbuild'),
  ];
  const bin = candidates.find((p) => existsSync(p));
  if (!bin) throw new Error('找不到 esbuild 二进制，请先 npm install');
  return bin;
}

function bundle(entry, outfile, extra = [], minify = true) {
  execFileSync(
    esbuildBinary(),
    [
      entry,
      '--bundle',
      '--format=iife',
      '--target=chrome111',
      '--legal-comments=none',
      '--charset=utf8',
      // 压缩：document_start 注入的脚本越小，解析与执行越早结束（体积约减一半）。
      // 但脚本市场（Greasy Fork）要求源码可读，所以额外打一份不压缩的给发布用。
      ...(minify ? ['--minify'] : []),
      '--log-level=warning',
      `--outfile=${outfile}`,
      ...extra,
    ],
    { stdio: 'inherit' },
  );
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(extDir, { recursive: true });

  bundle(join(root, 'src/extension/background.ts'), join(extDir, 'background.js'));
  bundle(join(root, 'src/extension/content.ts'), join(extDir, 'content.js'));
  bundle(join(root, 'src/extension/page.ts'), join(extDir, 'page.js'));
  bundle(join(root, 'src/extension/popup.ts'), join(extDir, 'popup.js'));
  bundle(join(root, 'src/userscript/main.ts'), join(dist, 'BiliBlocker.user.js'), [
    `--banner:js=${banner}`,
  ]);
  // 给脚本市场（Greasy Fork）的版本：不压缩，源码可读
  bundle(
    join(root, 'src/userscript/main.ts'),
    join(dist, 'BiliBlocker.greasyfork.user.js'),
    [`--banner:js=${banner}`],
    false,
  );

  await cp(join(root, 'manifest.json'), join(extDir, 'manifest.json'));
  await cp(join(root, 'src/extension/popup.html'), join(extDir, 'popup.html'));
  await cp(join(root, 'src/extension/popup.css'), join(extDir, 'popup.css'));
  await cp(join(root, 'assets/icons'), join(extDir, 'icons'), { recursive: true });

  // 油猴脚本不做 Release 附件，直接作为仓库里的文件供人取用，
  // 所以额外在仓库根目录留一份（dist/ 是构建产物，不入库）
  await cp(join(dist, 'BiliBlocker.user.js'), join(root, 'BiliBlocker.user.js'));

  const zip = await createZip(extDir, join(dist, 'BiliBlocker.zip'));
  const userJs = await stat(join(dist, 'BiliBlocker.user.js'));
  const gfJs = await stat(join(dist, 'BiliBlocker.greasyfork.user.js'));

  console.log('构建完成');
  console.log(`  扩展目录    dist/extension  (${zip.fileCount} 个文件)`);
  console.log(`  扩展压缩包  dist/BiliBlocker.zip  ${kb(zip.size)}`);
  console.log(`  油猴脚本    dist/BiliBlocker.user.js  ${kb(userJs.size)}（压缩，直接安装）`);
  console.log(`  脚本市场版  dist/BiliBlocker.greasyfork.user.js  ${kb(gfJs.size)}（未压缩，源码可读）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
