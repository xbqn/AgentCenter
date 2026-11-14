#!/usr/bin/env node
/**
 * 发布 dsh-agentcenter 到 npm。
 *
 * 为什么需要这个脚本（而不是直接 npm publish）：
 *   1. **IPv4 强制**——npm 的 granular token 若配了 CIDR 白名单（例如只允许某个 IPv4 网段），
 *      Node 默认优先走 IPv6，出口 IPv6 不在白名单里，会被拒绝：
 *        "You may not perform that action from your current IP."
 *      这里给子进程注入 NODE_OPTIONS=--dns-result-order=ipv4first，让请求走 IPv4。
 *   2. **token 不落盘**——从环境变量 NPM_TOKEN 或指定文件读取，写进临时 .npmrc，
 *      发布结束（无论成败）立即删除。
 *   3. **发布后校验**——npm 现在是 staged publishing：PUT 返回 202 后要等几十秒才生效，
 *      脚本会轮询 registry，直到 dist-tags.latest 指向本次版本才算成功。
 *
 * 用法：
 *   node scripts/publish.mjs                    # 用环境变量 NPM_TOKEN
 *   node scripts/publish.mjs --token-file ../.npm-token
 *   node scripts/publish.mjs --dry-run          # 只打包，不发布
 *   node scripts/publish.mjs --tag next         # 发布到指定 dist-tag
 *   node scripts/publish.mjs --no-ipv4          # 关掉 IPv4 强制（排查问题时用）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(HERE, '..');
const REGISTRY = 'https://registry.npmjs.org/';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const dryRun = flag('--dry-run');
const useIpv4 = !flag('--no-ipv4');
const tag = value('--tag', 'latest');
const tokenFile = value('--token-file', '');

function die(message) {
  console.error('\n✗ ' + message);
  process.exit(1);
}

function readToken() {
  if (tokenFile !== '') {
    try {
      const raw = fs.readFileSync(path.resolve(PKG_DIR, tokenFile), 'utf8').trim();
      if (raw !== '') return raw;
    } catch {
      die('读不到 token 文件：' + tokenFile);
    }
  }
  const fromEnv = (process.env.NPM_TOKEN || '').trim();
  if (fromEnv !== '') return fromEnv;
  die(
    '缺少 npm token。两种方式：\n' +
      '  1) set NPM_TOKEN=npm_xxx  （当前会话）\n' +
      '  2) node scripts/publish.mjs --token-file <路径>',
  );
}

function readPkg() {
  const file = path.join(PKG_DIR, 'package.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    die('package.json 读不出来：' + error.message);
  }
}

/** 跑一个命令，继承 stdio，返回退出码。 */
function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: PKG_DIR,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ...env },
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** 轮询 registry，直到 latest 指向目标版本。 */
async function waitForLive(name, version, token, timeoutMs = 180000) {
  const url = 'https://registry.npmjs.org/' + name;
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const res = await fetch(url + '?t=' + Date.now(), {
        headers: { Authorization: 'Bearer ' + token, 'Cache-Control': 'no-cache' },
      });
      if (!res.ok) continue;
      const meta = await res.json();
      const latest = meta['dist-tags'] && meta['dist-tags'].latest;
      const versions = Object.keys(meta.versions || {});
      if (versions.includes(version)) {
        // 版本已在列表里；再看 latest 是否已经指向它
        if (latest === version) return true;
        console.log(`  · ${version} 已入库，latest 仍指向 ${latest}，继续等待…`);
      }
    } catch {
      /* 网络抖动，继续等 */
    }
  }
}

const pkg = readPkg();
const name = pkg.name;
const version = pkg.version;
if (!name || !version) die('package.json 缺少 name 或 version');

console.log(`\n发布 ${name}@${version} → ${REGISTRY}${dryRun ? '（dry-run，不会真的发布）' : ''}`);
if (useIpv4) console.log('  · 已强制 IPv4（--dns-result-order=ipv4first），避免 CIDR 白名单拒绝');
if (tag !== 'latest') console.log(`  · dist-tag: ${tag}`);

// dry-run 不需要 token
let token = '';
let npmrcPath = '';
if (!dryRun) {
  token = readToken();
  // 临时 .npmrc：用完就删，不碰用户自己的 ~/.npmrc
  npmrcPath = path.join(os.tmpdir(), `npmrc-publish-${process.pid}`);
  fs.writeFileSync(
    npmrcPath,
    `registry=${REGISTRY}\n//registry.npmjs.org/:_authToken=${token}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

const cleanup = () => {
  if (npmrcPath !== '') {
    try { fs.unlinkSync(npmrcPath); } catch { /* 已删 */ }
  }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const env = {
  NPM_CONFIG_USERCONFIG: npmrcPath || path.join(os.tmpdir(), 'npmrc-none'),
  NODE_OPTIONS: [process.env.NODE_OPTIONS, useIpv4 ? '--dns-result-order=ipv4first' : '']
    .filter(Boolean)
    .join(' '),
};

const args = ['publish', '--registry=' + REGISTRY, '--tag', tag];
if (dryRun) args.push('--dry-run');

console.log('');
const code = await run('npm', args, env);
if (code !== 0) {
  console.error('\n✗ 发布失败（退出码 ' + code + '）');
  console.error('  常见原因：');
  console.error('    · token 没有发布权限 → 用 Classic Token 的 Automation 类型');
  console.error('    · token 配了 CIDR 白名单，但出口 IP 不在里面 → 检查 --no-ipv4 是否误开');
  console.error('    · 版本号已存在 → 先 npm version patch');
  process.exit(code);
}

if (dryRun) {
  console.log('\n✓ dry-run 通过（打包内容正常）');
  process.exit(0);
}

console.log('\n  · 等待 registry 生效（staged publishing 有延迟）…');
const live = await waitForLive(name, version, token);
cleanup();

if (live) {
  console.log(`\n✓ ${name}@${version} 已发布并生效`);
  console.log(`  https://www.npmjs.com/package/${name}`);
  console.log(`  安装：npm install ${name}`);
  process.exit(0);
}

console.log(`\n⚠ ${name}@${version} 已提交，但 registry 还没返回生效状态。`);
console.log('  这不是失败——staged publishing 有时要几分钟。稍后用下面命令确认：');
console.log(`    npm view ${name} dist-tags`);
process.exit(0);