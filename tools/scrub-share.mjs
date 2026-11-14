#!/usr/bin/env node
/**
 * scrub-share.mjs —— 把分享页快照 conversation-data.json 里的个人标识替换成中性值，
 * 输出可直接托管的一份副本。
 *
 * 用法：
 *   node tools/scrub-share.mjs <输入.json> <输出.json> [--rules <规则文件>]
 *
 * 规则文件是 JSON：{ "rules": [[原文, 替换], ...], "leftover": ["残留词", ...] }，
 * 顺序敏感（先长串后短串）。默认读取 tools/scrub-rules.json —— 那是**本机私有**规则，
 * 已被 .gitignore 排除；仓库里只放 tools/scrub-rules.example.json 作形状示例。
 *
 * 说明：只做纯文本替换，不改变 JSON 结构；每次运行都会打印每条规则的命中次数与残留检查。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RULES = path.join(HERE, 'scrub-rules.json');

const argv = process.argv.slice(2);
const rulesIndex = argv.indexOf('--rules');
const rulesFile = rulesIndex > -1 ? argv.splice(rulesIndex, 2)[1] : DEFAULT_RULES;
const [src, dst] = argv;

if (!src || !dst) {
  console.error('用法：node tools/scrub-share.mjs <输入.json> <输出.json> [--rules <规则文件>]');
  process.exit(1);
}

function loadRules(file) {
  if (!fs.existsSync(file)) {
    console.error('找不到规则文件：' + file);
    console.error('把 tools/scrub-rules.example.json 复制成 tools/scrub-rules.json，改成你自己的替换规则再运行；');
    console.error('这份私有规则文件不会进仓库（见 .gitignore）。');
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('规则文件不是合法 JSON：' + e.message);
    process.exit(1);
  }
  const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
  if (!rules.length) {
    console.error('规则文件里没有 rules：应当形如 [["原文", "替换"], ...]');
    process.exit(1);
  }
  for (const rule of rules) {
    if (!Array.isArray(rule) || rule.length !== 2 || typeof rule[0] !== 'string' || rule[0] === '' || typeof rule[1] !== 'string') {
      console.error('rules 里每条都必须是非空的 [原文, 替换]：' + JSON.stringify(rule));
      process.exit(1);
    }
  }
  return { rules, leftover: Array.isArray(parsed.leftover) ? parsed.leftover.filter((t) => typeof t === 'string' && t) : [] };
}

const { rules, leftover } = loadRules(path.resolve(rulesFile));

const raw = fs.readFileSync(src, 'utf8');
let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error('输入不是合法 JSON：' + e.message);
  process.exit(1);
}

let text = JSON.stringify(data);
const report = [];
for (const [from, to] of rules) {
  const n = text.split(from).length - 1;
  if (n) text = text.split(from).join(to);
  report.push({ rule: `${from} → ${to}`, hits: n });
}

fs.mkdirSync(path.dirname(path.resolve(dst)), { recursive: true });
fs.writeFileSync(dst, text, 'utf8');

const wide = report.reduce((m, r) => Math.max(m, r.rule.length), 0);
console.log('替换明细（规则：' + path.resolve(rulesFile) + '）');
for (const r of report) {
  console.log('  ' + r.rule.padEnd(wide) + '  ' + String(r.hits).padStart(5));
}
console.log('\n残留检查');
let dirty = 0;
for (const t of leftover) {
  const n = text.split(t).length - 1;
  if (n) { dirty++; console.log('  ! ' + t + ' 仍出现 ' + n + ' 次'); }
}
if (!dirty) console.log('  ✓ 无残留');

const msgs = Array.isArray(data.messages) ? data.messages.length : 0;
console.log('\n输入 ' + (raw.length / 1048576).toFixed(2) + ' MB → 输出 ' +
  (text.length / 1048576).toFixed(2) + ' MB，消息 ' + msgs + ' 条');
process.exit(dirty ? 2 : 0);