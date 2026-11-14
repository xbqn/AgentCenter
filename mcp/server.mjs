// AgentCenter MCP Server（stdio，JSON-RPC 2.0）
// 只读：不监听端口、不对外暴露，仅响应本机 stdio 调用（FR-MCP-01/04）
import { scan, DEFAULT_DATA_DIR, SUMMARY_FILE } from '../core/scan.mjs';
import { readJson } from '../core/util.mjs';
import path from 'node:path';

const PROTOCOL = '2024-11-05';

const TOOLS = [
  {
    name: 'agentcenter_summary',
    description: '获取今日（或指定时间范围）的任务中心汇总：任务数、活跃时长、占用空间、各 Agent 分布。',
    inputSchema: {
      type: 'object',
      properties: { range: { type: 'string', enum: ['today', 'w7', 'd14'], description: '时间范围，默认 today' } }
    }
  },
  {
    name: 'agentcenter_list_sessions',
    description: '按 Agent 列出会话/任务清单，可按状态与关键字过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent 显示名，如 WorkBuddy；留空为全部' },
        status: { type: 'string', enum: ['completed', 'running', 'interrupted', 'waiting', 'pending', 'all'] },
        limit: { type: 'number', description: '最多返回条数，默认 20' }
      }
    }
  },
  {
    name: 'agentcenter_get_session',
    description: '按 taskId 读取单个任务的完整记录（含状态依据、路径、产出文件、待办）。',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] }
  },
  {
    name: 'agentcenter_list_todos',
    description: '列出跨 Agent 汇总的待办事项。',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'done', 'all'] } } }
  },
  {
    name: 'agentcenter_storage_report',
    description: '存储占用与可回收中间文件清单（只统计，不删除）。',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' } } }
  },
  {
    name: 'agentcenter_get_conversation',
    description: '回放单个任务的完整对话：按时间顺序返回用户消息、助手回复、工具调用与结果（只读原始会话文件）。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 id（可从 list_sessions 获取）' },
        limit: { type: 'number', description: '最多返回节点数，默认 300' }
      },
      required: ['taskId']
    }
  },
  {
    name: 'agentcenter_trigger_scan',
    description: '触发一轮只读扫描，返回本轮统计。扫描不会写入 Agent 源目录。',
    inputSchema: { type: 'object', properties: { full: { type: 'boolean', description: 'true 为全量扫描' } } }
  }
];

function summaryOf(dataDir) {
  const j = readJson(SUMMARY_FILE(dataDir), null);
  if (!j) return null;
  return j.data ? j.data : j;
}

async function ensure(dataDir) {
  let s = summaryOf(dataDir);
  if (!s) s = await scan({ dataDir });
  return s;
}

function ok(id, result) { return { jsonrpc: '2.0', id, result }; }
function err(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function callTool(name, args, dataDir) {
  const s = await ensure(dataDir);
  if (name === 'agentcenter_summary') {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        generatedAt: s.generatedAt, range: args.range || 'today',
        summary: s.summary, agents: s.agents, trend: s.trend, errors: s.errors
      }, null, 2) }]
    };
  }
  if (name === 'agentcenter_list_sessions') {
    let list = s.tasks || [];
    if (args.agent) list = list.filter((t) => t.agent.toLowerCase() === String(args.agent).toLowerCase());
    if (args.status && args.status !== 'all') list = list.filter((t) => t.status === args.status);
    list = list.slice(0, Number(args.limit) || 20);
    return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
  }
  if (name === 'agentcenter_get_session') {
    const t = (s.tasks || []).find((x) => x.id === args.taskId);
    if (!t) return { content: [{ type: 'text', text: '未找到该任务：' + args.taskId }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(t, null, 2) }] };
  }
  if (name === 'agentcenter_list_todos') {
    const st = args.status || 'pending';
    let list = s.todos || [];
    if (st !== 'all') list = list.filter((t) => (st === 'done' ? t.done : !t.done));
    return { content: [{ type: 'text', text: JSON.stringify({ count: list.length, todos: list }, null, 2) }] };
  }
  if (name === 'agentcenter_storage_report') {
    let list = s.intermediates || [];
    if (args.agent) list = list.filter((i) => i.agent.toLowerCase() === String(args.agent).toLowerCase());
    return { content: [{ type: 'text', text: JSON.stringify({
      totalBytes: list.reduce((a, i) => a + i.bytes, 0), intermediates: list,
      note: '仅统计，不自动删除；回收需在桌面端逐项确认。'
    }, null, 2) }] };
  }
  if (name === 'agentcenter_get_conversation') {
    const { readConversation } = await import('../core/conversation.mjs');
    const idx = readJson(path.join(dataDir, 'index.json'), { tasks: [] });
    const task = (idx.tasks || []).find((t) => t.taskId === args.taskId || t.id === args.taskId);
    if (!task) return { content: [{ type: 'text', text: '索引中找不到该任务：' + args.taskId }], isError: true };
    const conv = await readConversation(task, { limit: Number(args.limit) || 300 });
    return { content: [{ type: 'text', text: JSON.stringify(conv, null, 2) }], isError: !conv.ok };
  }
  if (name === 'agentcenter_trigger_scan') {
    const r = await scan({ dataDir, full: !!args.full });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, stats: r.stats, summary: r.summary, errors: r.errors }, null, 2) }] };
  }
  return { content: [{ type: 'text', text: '未知工具：' + name }], isError: true };
}

export async function serveMcp(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  let buf = '';
  let queue = Promise.resolve();

  // 返回一个在 stdin 结束且队列排空后才 resolve 的 Promise，
  // 否则调用方（cli 的 main）会立刻 exit，响应还来不及写出。
  return new Promise((resolve) => {
    const handle = async (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      const id = msg.id;
      try {
        if (msg.method === 'initialize') {
          send(ok(id, {
            protocolVersion: PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: 'agentcenter', version: '0.1.0' }
          }));
        } else if (msg.method === 'notifications/initialized') {
          // 无需响应
        } else if (msg.method === 'tools/list') {
          send(ok(id, { tools: TOOLS }));
        } else if (msg.method === 'tools/call') {
          const name = msg.params && msg.params.name;
          const args = (msg.params && msg.params.arguments) || {};
          const result = await callTool(name, args, dataDir);
          send(ok(id, result));
        } else if (msg.method === 'ping') {
          send(ok(id, {}));
        } else if (id !== undefined) {
          send(err(id, -32601, '未知方法：' + msg.method));
        }
      } catch (e) {
        if (id !== undefined) send(err(id, -32603, e.message));
      }
    };

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const text = line.trim();
        if (text) queue = queue.then(() => handle(text));
      }
    });
    process.stdin.on('end', () => {
      queue.then(() => resolve());
    });
    process.stdin.on('error', () => resolve());
  });
}
