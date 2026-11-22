/**
 * 规则模块出口。
 * 词法匹配（text）、卡片归一（card）、规则判定（rules）三块互不依赖宿主，扩展与油猴共用。
 */
export * from './text';
export * from './card';
export * from './rules';
