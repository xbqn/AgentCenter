// 调度执行器：按 data/config.json 的 scan 规则定时扫描 + 生成日报
// 常驻进程；也可用 CLI `daemon` 启动。只读扫描，写索引与日报，不碰 Agent 源目录。
import fs from 'node:fs';
import path from 'node:path';
import { scan, readConfig, DEFAULT_DATA_DIR } from './scan.mjs';
import { writeReport } from './report.mjs';
import { isoLocal, dayKey } from './util.mjs';

const TICK_MS = 60 * 1000;   // 每分钟检查一次是否到点

/** 解析 HH:mm，返回今天该时刻的毫秒时间戳 */
function atToday(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime();
}

/** 是否应该在本轮触发 */
function dueNow(state, cfg, now) {
  const scanCfg = (cfg && cfg.scan) || {};
  const out = { interval: false, daily: false, weekly: false, report: false };

  // 固定间隔
  const intervalMin = Number(scanCfg.intervalMin);
  if (scanCfg.intervalEnabled !== false && intervalMin > 0) {
    const last = state.lastIntervalAt || 0;
    if (now - last >= intervalMin * 60 * 1000) out.interval = true;
  }

  // 每日定点
  // 每日定点：只有在显式开启自动日报时才顺带出报（缺省不写，避免覆盖 AI 总结）
  const dailyAt = atToday(scanCfg.dailyAt);
  if (scanCfg.dailyEnabled !== false && dailyAt && now >= dailyAt && (state.lastDailyKey !== dayKey(now))) {
    out.daily = true;
    out.report = scanCfg.reportAuto === true;
  }

  // 每周（周一 09:00 默认）
  const weeklyAt = atToday(scanCfg.weeklyAt);
  const wd = new Date(now).getDay();   // 0=周日
  const weekKey = dayKey(now);
  if (scanCfg.weeklyEnabled !== false && weeklyAt && wd === 1 && now >= weeklyAt && state.lastWeeklyKey !== weekKey) {
    out.weekly = true;
  }
  return out;
}

/**
 * 启动调度循环。
 * @param {{dataDir?:string, onScan?:(r:object)=>void, quiet?:boolean, once?:boolean}} opts
 */
export async function startScheduler(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const quiet = !!opts.quiet;
  const state = { lastIntervalAt: 0, lastDailyKey: '', lastWeeklyKey: '', running: false };
  let timer = null;
  let stopped = false;

  const log = (msg) => { if (!quiet) process.stdout.write('[' + isoLocal(Date.now()) + '] ' + msg + '\n'); };

  const tick = async () => {
    if (stopped || state.running) return;
    const now = Date.now();
    const cfg = readConfig(dataDir);
    const due = dueNow(state, cfg, now);
    if (!due.interval && !due.daily && !due.weekly) return;

    state.running = true;
    try {
      log('开始扫描（' + [due.interval ? '间隔' : '', due.daily ? '每日' : '', due.weekly ? '每周' : ''].filter(Boolean).join('/') + '）');
      const r = await scan({ dataDir, full: false });
      if (due.interval) state.lastIntervalAt = now;
      if (due.daily) state.lastDailyKey = dayKey(now);
      if (due.weekly) state.lastWeeklyKey = dayKey(now);

      // 日报：每日定点或开启自动日报时生成当天
      if (due.report || (cfg.scan && cfg.scan.reportAuto)) {
        const date = dayKey(now);
        const w = writeReport(r, dataDir, date);
        log('日报已生成：' + w.file);
      }
      log('扫描完成：任务 ' + r.summary.tasks + ' · 会话 ' + r.stats.sessions + ' · 错误 ' + r.errors.length);
      if (opts.onScan) opts.onScan(r);
    } catch (e) {
      // 失败可观测：写日志并继续下一轮（FR-SCH-05）
      log('扫描失败：' + (e && e.message ? e.message : e));
    } finally {
      state.running = false;
    }
  };

  if (opts.once) { await tick(); return { stop() {} }; }

  // 启动即检查一次（便于验证规则是否到点）
  await tick();
  timer = setInterval(tick, TICK_MS);
  log('调度已启动：间隔 ' + ((cfg0interval(dataDir) || 0)) + ' 分钟 · 每日 ' + (readConfig(dataDir).scan.dailyAt || '未设'));

  return {
    stop() { stopped = true; if (timer) clearInterval(timer); }
  };
}

function cfg0interval(dataDir) {
  const c = readConfig(dataDir);
  return Number((c.scan || {}).intervalMin) || 0;
}

export { dueNow, TICK_MS };
