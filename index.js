/**
 * dsh-longtask-guard
 *
 * 长任务上下文护栏：
 * 1) 上下文外化：会话消息总量超阈值时，在 agent/pre-step 把早期超长消息正文
 *    收缩成一行索引，原文归档到项目 `.dsh-task/archive/`。
 * 2) 退化兜底：监听 session/event，assistant 消息里「正文为空、分析全在
 *    reasoning」的回合会把 reasoning 落盘，并在 turn 结束时补发一条可见的
 *    摘要消息，避免「打断后内容看不见 / 以为丢了」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'longtask-guard';
export const inject = ['tools'];

const DEFAULTS = {
  enabled: true,
  externalizeAtChars: 1200000,
  keepRecentMessages: 40,
  archiveDir: '.dsh-task/archive',
  minMessageChars: 1200,
  cooldownMessages: 60,
  captureReasoning: true,
  minReasoningChars: 400,
  minTextChars: 20,
  reasoningDir: '.dsh-task/reasoning',
  appendSummary: true,
  summaryExcerptChars: 2400,
};

const MARK = '[ctx-externalized]';

function dshHome() {
  return process.env.DSH_HOME || process.env.DSH_PROFILE_DIR || path.join(process.cwd(), '.dsh');
}

function stateFile() {
  return path.join(dshHome(), 'data', 'longtask-guard.json');
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function loadState(config = {}) {
  const state = {
    ...DEFAULTS,
    stats: { runs: 0, shrunkMessages: 0, savedChars: 0, last: null, rescued: 0, lastRescue: null },
    lastArchiveAt: 0,
  };
  for (const key of Object.keys(DEFAULTS)) {
    if (config[key] !== undefined) state[key] = config[key];
  }
  const saved = readJsonSafe(stateFile());
  if (saved && typeof saved === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (saved[key] !== undefined) state[key] = saved[key];
    }
    if (saved.stats) state.stats = { ...state.stats, ...saved.stats };
    if (typeof saved.lastArchiveAt === 'number') state.lastArchiveAt = saved.lastArchiveAt;
  }
  return state;
}

function saveState(state) {
  const file = stateFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { stats, lastArchiveAt, ...rest } = state;
    fs.writeFileSync(file, JSON.stringify({ ...rest, stats, lastArchiveAt }, null, 2), 'utf8');
  } catch {
    /* 持久化失败不影响主流程 */
  }
}

function textOf(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (typeof block.text === 'string') out += block.text;
      else if (block.type === 'text' && typeof block.value === 'string') out += block.value;
    }
    return out;
  }
  if (typeof message.text === 'string') return message.text;
  return '';
}

/** 把一条 assistant 消息拆成正文与 reasoning。 */
function splitAssistant(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  let text = '';
  let reasoning = '';
  let toolCalls = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'reasoning') reasoning += String(block.text || '');
    else if (block.type === 'text') text += String(block.text || '');
    else if (block.type === 'tool-call') toolCalls += 1;
  }
  return { text, reasoning, toolCalls };
}

function roleOf(message) {
  if (!message) return '';
  if (typeof message.role === 'string') return message.role;
  const kind = message.source && message.source.kind;
  return typeof kind === 'string' ? kind : '';
}

function shrinkMessage(message, summaryLine) {
  const content = message.content;
  if (typeof content === 'string' || !Array.isArray(content)) {
    return { ...message, content: summaryLine };
  }
  let replaced = false;
  const next = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const isText = typeof block.text === 'string' || block.type === 'text';
    if (isText && !replaced) {
      next.push({ ...block, text: summaryLine });
      replaced = true;
    } else if (!isText) {
      next.push(block);
    }
  }
  if (!replaced) next.unshift({ type: 'text', text: summaryLine });
  return { ...message, content: next };
}

function firstLine(text, max = 140) {
  return (
    String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max) || '(空)'
  );
}

function countChars(messages) {
  let total = 0;
  for (const m of messages) total += textOf(m).length;
  return total;
}

function sessionTag(payload) {
  const agent = (payload && payload.agent) || {};
  const id =
    (agent.session && agent.session.id) ||
    agent.sessionId ||
    agent.id ||
    (payload && payload.sessionId) ||
    'session';
  return String(id).slice(0, 24);
}

function workingDir(payload) {
  const agent = (payload && payload.agent) || {};
  const candidates = [
    agent.cwd,
    agent.workdir,
    agent.workspace && agent.workspace.path,
    agent.workspace && agent.workspace.root,
    agent.session && agent.session.cwd,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return process.cwd();
}

function shrinkMessages(state, messages, payload) {
  const keepFrom = Math.max(0, messages.length - state.keepRecentMessages);
  const tag = sessionTag(payload);
  const root = workingDir(payload);
  const dir = path.isAbsolute(state.archiveDir) ? state.archiveDir : path.join(root, state.archiveDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveFile = path.join(dir, `ctx-${tag}-${stamp}.md`);

  const out = [];
  const archived = [];
  let shrunkCount = 0;
  let savedChars = 0;

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (i >= keepFrom) {
      out.push(message);
      continue;
    }
    const role = roleOf(message);
    const text = textOf(message);
    if (role === 'user' || text.length < state.minMessageChars) {
      out.push(message);
      continue;
    }
    const summary = `${MARK} #${i + 1} ${firstLine(text)}｜全文 ${text.length} 字符：${archiveFile}`;
    if (summary.length >= text.length) {
      out.push(message);
      continue;
    }
    archived.push({ index: i + 1, role: role || 'unknown', text });
    out.push(shrinkMessage(message, summary));
    shrunkCount += 1;
    savedChars += text.length - summary.length;
  }

  if (shrunkCount === 0) {
    return { messages, changed: false, shrunkCount: 0, savedChars: 0, archiveFile: null };
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    const header = [
      `# 上下文外化归档`,
      ``,
      `- 会话：${tag}`,
      `- 时间：${new Date().toISOString()}`,
      `- 归档消息：${shrunkCount} 条`,
      `- 说明：这些消息在原会话里已被收缩为一行索引，需要细节时读取本文件。`,
      ``,
    ].join('\n');
    const body = archived.map((item) => `## #${item.index} ${item.role}\n\n${item.text}\n`).join('\n---\n\n');
    fs.writeFileSync(archiveFile, header + body, 'utf8');
  } catch {
    return { messages, changed: false, shrunkCount: 0, savedChars: 0, archiveFile: null };
  }

  return { messages: out, changed: true, shrunkCount, savedChars, archiveFile };
}

function sessionIdOf(session) {
  if (!session) return 'session';
  if (typeof session === 'string') return session;
  if (typeof session.id === 'string' && session.id) return session.id;
  return 'session';
}

function sessionCwd(session) {
  const candidates = [session && session.cwd, session && session.workspace && session.workspace.path, process.cwd()];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return process.cwd();
}

function escapeSummary(text) {
  // 只做必要的截断，不改内容语义。
  return String(text || '').trim();
}

/** 构造一条可见的 assistant 消息 + 宿主持久化需要的 compact stream。 */
function buildAppendPayload(text) {
  const now = Date.now();
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: 'stop' },
  ].map((chunk, i) => ({ type: 'chunk', time: now + i, chunk }));
  const message = {
    id: randomUUID(),
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'longtask-guard', model: 'longtask-guard' },
  };
  return { message, stream: chunks };
}

export function apply(ctx, config = {}) {
  const state = loadState(config);
  let lastArchiveMessageCount = 0;

  // ---- 1. 上下文外化 ----
  try {
    ctx.effect(() => {
      const off = ctx.on(
        'agent/pre-step',
        async (payload, next) => {
          let decision;
          try {
            decision = typeof next === 'function' ? await next() : payload;
          } catch {
            return undefined;
          }
          try {
            if (!decision || decision.kind === 'reject') return decision;
            if (!state.enabled) return decision;
            const messages = Array.isArray(decision.messages) ? decision.messages : payload && payload.messages;
            if (!Array.isArray(messages) || messages.length <= state.keepRecentMessages) return decision;

            const total = countChars(messages);
            if (total <= state.externalizeAtChars) return decision;
            if (lastArchiveMessageCount > 0 && messages.length - lastArchiveMessageCount < state.cooldownMessages) {
              return decision;
            }

            const result = shrinkMessages(state, messages, payload);
            if (!result.changed) return decision;

            lastArchiveMessageCount = messages.length;
            state.lastArchiveAt = Date.now();
            state.stats.runs += 1;
            state.stats.shrunkMessages += result.shrunkCount;
            state.stats.savedChars += result.savedChars;
            state.stats.last = {
              at: new Date().toISOString(),
              archive: result.archiveFile,
              shrunk: result.shrunkCount,
              savedChars: result.savedChars,
              totalBefore: total,
            };
            saveState(state);
            return { ...decision, messages: result.messages };
          } catch {
            return decision;
          }
        },
        { global: true, prepend: true },
      );
      return off;
    });
  } catch {
    /* 无 effect 时忽略 */
  }

  // ---- 2. 退化兜底：reasoning 落盘 + 空正文补发 ----
  const pendingBySession = new Map();

  function pendingFor(session) {
    const key = sessionIdOf(session);
    let bucket = pendingBySession.get(key);
    if (!bucket) {
      bucket = [];
      pendingBySession.set(key, bucket);
    }
    return bucket;
  }

  function onSessionEvent(session, event) {
    if (!state.enabled || !state.captureReasoning) return;
    const type = event && event.type;
    const data = (event && event.data) || {};
    if (type === 'assistant/message') {
      const { text, reasoning, toolCalls } = splitAssistant(data.message);
      if (reasoning.length >= state.minReasoningChars && text.trim().length < state.minTextChars) {
        pendingFor(session).push({
          turn: Number(data.turn),
          step: Number(data.step),
          reasoning,
          text,
          toolCalls,
        });
      }
      return;
    }
    if (type !== 'turn/end') return;
    const items = pendingFor(session).splice(0, pendingBySession.get(sessionIdOf(session)).length);
    if (items.length === 0) return;
    void rescue(session, items);
  }

  async function rescue(session, items) {
    const id = sessionIdOf(session);
    const root = sessionCwd(session);
    const dir = path.isAbsolute(state.reasoningDir)
      ? state.reasoningDir
      : path.join(root, state.reasoningDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const firstTurn = Number.isFinite(items[0].turn) ? items[0].turn : 0;
    const file = path.join(dir, `turn-${firstTurn}-${stamp}.md`);
    const totalChars = items.reduce((a, it) => a + it.reasoning.length, 0);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const header = [
        `# 退化回合救援归档`,
        ``,
        `- 会话：${id}`,
        `- 时间：${new Date().toISOString()}`,
        `- 回合：${items.map((it) => `t${it.turn}/s${it.step}`).join(', ')}`,
        `- 说明：本轮正文为空，以下内容原本只写在 reasoning 里。`,
        ``,
      ].join('\n');
      const body = items
        .map((it) => `## t${it.turn} / s${it.step}（${it.reasoning.length} 字符）\n\n${it.reasoning}\n`)
        .join('\n---\n\n');
      fs.writeFileSync(file, header + body, 'utf8');
    } catch {
      return;
    }

    state.stats.rescued += 1;
    state.stats.lastRescue = { at: new Date().toISOString(), file, turns: items.length, chars: totalChars };
    saveState(state);

    if (!state.appendSummary) return;
    const excerpt = items
      .map((it) => escapeSummary(it.reasoning))
      .join('\n\n')
      .slice(0, state.summaryExcerptChars);
    const note = [
      `⚠️ 上一轮正文为空，分析只写在了 reasoning 里（共 ${totalChars} 字符），已归档到：`,
      file,
      ``,
      `—— 以下是这段分析的原文摘录（截取前 ${Math.min(state.summaryExcerptChars, totalChars)} 字符）——`,
      ``,
      excerpt,
      ``,
      `（完整内容读上面那个文件；如果你要的是正文结论，直接回复「继续」即可从这份分析接着往下走。）`,
    ].join('\n');
    try {
      if (session && typeof session.append === 'function') {
        const payload = buildAppendPayload(note);
        const turn = Number.isFinite(items[0].turn) ? items[0].turn : 0;
        const step = Number.isFinite(items[0].step) ? items[0].step : 1;
        await session.append('assistant/message', { turn, step, ...payload }, { surfaceOp: 'append' });
      }
    } catch {
      /* 补发失败不影响归档 */
    }
  }

  try {
    ctx.effect(() =>
      ctx.on('session/event', (session, event) => {
        try {
          onSessionEvent(session, event);
        } catch {
          /* 事件处理失败不影响会话 */
        }
      }),
    );
  } catch {
    /* 无 session/event 时只保留上下文外化 */
  }

  const ok = (text) => String(text);

  ctx.tools.register({
    name: 'longtask_status',
    description:
      '查看长任务护栏状态：阈值、保留窗口、归档目录，以及本次运行以来的收缩与救援统计（收缩次数、被收缩消息数、节省字符、空正文救援次数）。长任务中怀疑上下文过大或担心丢内容时先调它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const lines = [
        `enabled=${state.enabled}`,
        `外部化阈值 externalizeAtChars=${state.externalizeAtChars} 字符（约 ${Math.round(state.externalizeAtChars / 4)} token）`,
        `保留最近消息 keepRecentMessages=${state.keepRecentMessages} 条`,
        `归档目录=${state.archiveDir}；reasoning 目录=${state.reasoningDir}`,
        `本次运行：收缩 ${state.stats.runs} 次，共 ${state.stats.shrunkMessages} 条消息，节省 ${state.stats.savedChars} 字符`,
        `退化救援：${state.stats.rescued} 次`,
      ];
      if (state.stats.last) {
        lines.push(
          `最近一次收缩：${state.stats.last.at} 收缩 ${state.stats.last.shrunk} 条，节省 ${state.stats.last.savedChars} 字符，收缩前总量 ${state.stats.last.totalBefore} 字符`,
          `归档文件：${state.stats.last.archive}`,
        );
      }
      if (state.stats.lastRescue) {
        lines.push(`最近一次救援：${state.stats.lastRescue.at} 回合 ${state.stats.lastRescue.turns} 个，${state.stats.lastRescue.chars} 字符`, `救援文件：${state.stats.lastRescue.file}`);
      }
      return ok(lines.join('\n'));
    },
  });

  ctx.tools.register({
    name: 'longtask_externalize',
    description:
      '手动触发一次上下文外化：下一轮请求前把保留窗口之外的超长 assistant / 工具消息收缩成一行索引，原文写入项目 .dsh-task/archive/。可选参数 force=true 绕过冷却。长任务开始出现响应变慢或回合变长时可主动调一次。',
    parameters: {
      type: 'object',
      properties: { force: { type: 'boolean', description: '绕过冷却，立即在下一轮执行' } },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      if (args && args.force) lastArchiveMessageCount = 0;
      return ok('已登记：下一轮 pre-step 若消息总量超过阈值就会执行收缩。想知道结果，下一轮结束后调用 longtask_status。');
    },
  });

  ctx.tools.register({
    name: 'longtask_handoff',
    description:
      '把当前任务的进度写成交接文件（项目 .dsh-task/handoff-<时间>.md），用于长任务被中断、需要换会话继续时。传入 summary 必填（当前目标、已完成、下一步、关键文件路径），其余可选。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '交接内容：目标 / 已完成 / 下一步 / 关键文件' },
        title: { type: 'string', description: '可选标题' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const root = (exec && exec.cwd) || process.cwd();
      const dir = path.join(root, '.dsh-task');
      const file = path.join(dir, `handoff-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
      try {
        fs.mkdirSync(dir, { recursive: true });
        const text = [`# ${(args && args.title) || '任务交接'}`, ``, `- 时间：${new Date().toISOString()}`, ``, String((args && args.summary) || ''), ``].join('\n');
        fs.writeFileSync(file, text, 'utf8');
        return ok(`已写入交接文件：${file}`);
      } catch (error) {
        return ok(`写交接文件失败：${String(error && error.message ? error.message : error)}`);
      }
    },
  });

  ctx.tools.register({
    name: 'longtask_reasoning',
    description:
      '列出或读取本插件归档的「退化回合 reasoning」文件（项目 .dsh-task/reasoning/）。当某个回合被中断、正文为空，而你想知道模型当时分析出了什么时用它。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read'], description: 'list 列出文件；read 读取指定文件' },
        file: { type: 'string', description: 'read 时的文件名或绝对路径（list 结果里能看到）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const root = (exec && exec.cwd) || process.cwd();
      const dir = path.isAbsolute(state.reasoningDir) ? state.reasoningDir : path.join(root, state.reasoningDir);
      try {
        if (args && args.action === 'read' && args.file) {
          const file = path.isAbsolute(args.file) ? args.file : path.join(dir, args.file);
          const text = fs.readFileSync(file, 'utf8');
          return ok(text.slice(0, 20000));
        }
        if (!fs.existsSync(dir)) return ok(`还没有归档：${dir} 不存在。`);
        const files = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }))
          .sort((a, b) => b.name.localeCompare(a.name));
        if (files.length === 0) return ok(`目录是空的：${dir}`);
        return ok(files.map((f) => `${f.name}  ${f.size} 字节`).join('\n'));
      } catch (error) {
        return ok(`读取失败：${String(error && error.message ? error.message : error)}`);
      }
    },
  });

  return () => saveState(state);
}
