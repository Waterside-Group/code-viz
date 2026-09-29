#!/usr/bin/env node
'use strict';
// Code Viz server.
//  - Receives Claude Code hook events (Pre/PostToolUse for every tool) and snapshots each
//    file before and after Write and Edit change it.
//  - Follows session transcripts for Claude's thinking, replies and prompts, and merges them
//    with the tool calls into an activity feed (see activity.js).
//  - Optionally proxies Anthropic API traffic (when ANTHROPIC_BASE_URL points here) and taps
//    the response stream, so edits, thinking and tool input can be shown while generated.
//  - Serves the viewer and pushes everything to it over Server-Sent Events.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { PartialJSON } = require('./partial-json');
const { diffStats } = require('./viewer/diff');
const runDemo = require('./demo');
const { Blamer } = require('./blame');
const { Activity, classify } = require('./activity');
const { Transcripts } = require('./transcripts');
const { Usage } = require('./usage');
const { Screens } = require('./screens');
const settings = require('./config');

// Code Viz's release number (plugin.json has none, so Claude Code versions the plugin by commit).
const VERSION = require('../version.json').version;
const PORT = settings.load().port;
const HOME = settings.HOME;
const VIEWER = path.join(__dirname, 'viewer');
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY = 150;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const LIVE_TOOLS = new Set(['Write', 'Edit']);
const STREAM_FIELDS = new Set(['content', 'old_string', 'new_string']);
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));

fs.mkdirSync(HOME, { recursive: true });
const LOG = path.join(HOME, 'server.log');
try { if (fs.statSync(LOG).size > 2e6) fs.truncateSync(LOG, 0); } catch {}
function log(...parts) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${parts.join(' ')}\n`); } catch {}
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

const config = readJSON(path.join(HOME, 'config.json'), {});
const blamer = new Blamer({ home: HOME, log, github: () => settings.load().github });
const UPSTREAM = new URL(process.env.CODE_VIZ_UPSTREAM || config.upstream || 'https://api.anthropic.com');
const UPSTREAM_IS_SELF = HOSTS.has(UPSTREAM.host.toLowerCase());
const upstreamLib = UPSTREAM.protocol === 'https:' ? https : http;
const upstreamAgent = new upstreamLib.Agent({ keepAlive: true, maxSockets: 256 });
const upstreamPrefix = UPSTREAM.pathname.replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// Viewer connections

const clients = new Set();
function send(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(type, data) {
  for (const res of clients) {
    try { send(res, type, data); } catch {}
  }
}
setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch {}
  }
}, 15000).unref();

const activity = new Activity({ broadcast, log });
const screens = new Screens({ broadcast, settings, log });
const usage = new Usage({ log, settings, onChange: () => { if (usage.started) broadcast('usage', usage.snapshot()); } });
const transcripts = new Transcripts({ onEntry: (entry, ctx) => activity.fromTranscript(entry, ctx), onFile: (file) => usage.touch(file), log });

// ---------------------------------------------------------------------------
// Files, projects, history

function readText(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { exists: false, text: null };
    if (st.size > MAX_FILE_BYTES) return { exists: true, text: null, reason: 'too-big' };
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) return { exists: true, text: null, reason: 'binary' };
    return { exists: true, text: buf.toString('utf8') };
  } catch {
    return { exists: false, text: null };
  }
}

const projects = new Set();
function where(file) {
  let root = '';
  for (const p of projects) {
    if ((file === p || file.startsWith(p + path.sep)) && p.length > root.length) root = p;
  }
  if (root) return { rel: path.relative(root, file) || path.basename(file), project: path.basename(root) };
  const home = os.homedir();
  return { rel: file.startsWith(home + path.sep) ? '~' + file.slice(home.length) : file, project: '' };
}

// Latest known contents of every file seen, so the viewer can resync and Post events have a
// "before" even when the Pre snapshot was missed.
const known = new Map();
function remember(file, text) {
  known.delete(file);
  known.set(file, text);
  if (known.size > 300) known.delete(known.keys().next().value);
}

const history = [];
let seq = 0;
function meta(edit) {
  const { before, after, ...rest } = edit;
  return rest;
}
function recordEdit({ toolUseId, tool, file, session, before, after, created, demo }) {
  const stats = diffStats(before || '', after || '');
  const edit = {
    id: ++seq,
    toolUseId: toolUseId || null,
    tool,
    file,
    ...where(file),
    session: session || null,
    ts: Date.now(),
    created: !!created,
    demo: !!demo,
    adds: stats.adds,
    dels: stats.dels,
    before: before || '',
    after: after || '',
  };
  history.push(edit);
  if (history.length > MAX_HISTORY) history.shift();
  try { blamer.noteClaudeEdit(file, before || '', after || ''); } catch (e) { log('blame note failed', e.message); }
  broadcast('post', edit);
  if (!demo) activity.editDone(toolUseId, edit);
  return edit;
}

// ---------------------------------------------------------------------------
// Hook events

const snapshots = new Map();
setInterval(() => {
  const cutoff = Date.now() - 15 * 60e3;
  for (const [k, s] of snapshots) if (s.t < cutoff) snapshots.delete(k);
}, 60e3).unref();

function handleHook(p, entry) {
  const event = p.hook_event_name;
  if (p.cwd) projects.add(p.cwd);
  // Read whatever the transcript has flushed so far first, so a thinking block written
  // before this tool call is in the feed ahead of it.
  if (typeof p.transcript_path === 'string') {
    transcripts.follow(p.transcript_path);
    usage.touch(p.transcript_path);
  }
  try { activity.fromHook(p, entry); } catch (e) { log('activity hook error', e.stack); }
  try { screens.fromHook(p); } catch (e) { log('screen hook error', e.stack); }
  if (event === 'SessionStart') {
    broadcast('session', { session: p.session_id, cwd: p.cwd, source: p.source });
    return;
  }
  if (!EDIT_TOOLS.has(p.tool_name)) return;
  const input = p.tool_input || {};
  if (typeof input.file_path !== 'string' || !input.file_path) return;
  const file = path.resolve(p.cwd || '/', input.file_path);
  const key = p.tool_use_id || `${p.session_id}:${file}`;
  const base = { toolUseId: p.tool_use_id || null, tool: p.tool_name, file, ...where(file), session: p.session_id, ts: Date.now() };

  if (event === 'PreToolUse') {
    const r = readText(file);
    snapshots.set(key, { text: r.text, exists: r.exists, t: Date.now() });
    if (r.text != null) remember(file, r.text);
    broadcast('pre', { ...base, before: r.text, exists: r.exists });
    log('pre', p.tool_name, path.basename(file));
  } else if (event === 'PostToolUse') {
    const snap = snapshots.get(key);
    snapshots.delete(key);
    const r = readText(file);
    if (r.text == null) {
      broadcast('fail', { ...base, text: null, reason: r.reason || 'unreadable' });
      return;
    }
    const before = snap ? snap.text : known.has(file) ? known.get(file) : null;
    remember(file, r.text);
    recordEdit({
      toolUseId: p.tool_use_id,
      tool: p.tool_name,
      file,
      session: p.session_id,
      before,
      after: r.text,
      created: snap ? !snap.exists : before == null,
    });
    log('post', p.tool_name, path.basename(file));
  } else if (event === 'PostToolUseFailure' || event === 'PermissionDenied') {
    snapshots.delete(key);
    const r = readText(file);
    broadcast('fail', { ...base, text: r.text, reason: event === 'PermissionDenied' ? 'denied' : 'failed' });
    log('fail', p.tool_name, path.basename(file), event);
  }
}

// ---------------------------------------------------------------------------
// Live tool-input streams (from the API proxy, or the demo)

const stats = { requests: 0, lastAt: 0, streams: 0 };

class LiveStream {
  constructor(id, tool, readBase) {
    this.id = id;
    this.tool = tool;
    this.readBase = readBase || null;
    this.parser = new PartialJSON();
    this.filePath = '';
    this.pending = null;
    this.timer = null;
    this.closed = false;
    stats.streams++;
    broadcast('live-start', { id, tool, ts: Date.now() });
  }

  feed(chunk) {
    for (const ev of this.parser.push(chunk)) {
      if (ev.key === 'file_path') {
        if (ev.text) this.filePath += ev.text;
        if (ev.done) this.sendFile();
      } else if (STREAM_FIELDS.has(ev.key)) {
        if (!this.pending) this.pending = {};
        this.pending[ev.key] = (this.pending[ev.key] || '') + (ev.text || '');
      } else if (ev.key === 'replace_all' && ev.done) {
        this.flush();
        broadcast('live-delta', { id: this.id, replaceAll: ev.value === true });
      }
    }
    if (this.pending && !this.timer) this.timer = setTimeout(() => this.flush(), 24);
  }

  sendFile() {
    this.flush();
    const file = path.resolve(this.filePath);
    const r = this.readBase ? this.readBase(file) : readText(file);
    if (r.text != null) remember(file, r.text);
    broadcast('live-file', { id: this.id, file, ...where(file), base: r.text, exists: r.exists, unreadable: r.exists && r.text == null });
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending) return;
    broadcast('live-delta', { id: this.id, d: this.pending });
    this.pending = null;
  }

  end(aborted) {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    broadcast(aborted ? 'live-abort' : 'live-end', { id: this.id });
  }
}

// Incremental parser for an Anthropic Messages SSE response. Write/Edit tool_use blocks drive
// the live edit animation; thinking, text and every tool_use block also stream into the
// activity feed, keyed like the transcript (`<message id>:<block index>`, or the tool_use id)
// so the transcript's final copy lands on the same card.
class SSETap {
  constructor() {
    this.decoder = new StringDecoder('utf8');
    this.buf = '';
    this.blocks = new Map();
    this.acts = new Map();
    this.msgId = '';
  }

  actStart(index, b) {
    const ts = Date.now();
    if ((b.type === 'thinking' || b.type === 'text') && this.msgId) {
      const id = `${this.msgId}:${index}`;
      const kind = b.type === 'thinking' ? 'think' : 'text';
      activity.upsert({ id, kind, ts, text: '', partial: true, live: true });
      const field = b.type === 'thinking' ? 'thinking' : 'text';
      this.acts.set(index, {
        delta: (d) => {
          if (d.type === `${field}_delta`) activity.delta(id, 'text', d[field] || '');
        },
        end: () => activity.upsert({ id, live: false }),
      });
    } else if (b.type === 'tool_use' && b.id) {
      const id = b.id;
      const parser = new PartialJSON();
      activity.upsert({ id, kind: 'tool', ts, name: b.name, input: {}, meta: classify(b.name, {}), status: 'running', partial: true, live: true });
      this.acts.set(index, {
        delta: (d) => {
          if (d.type !== 'input_json_delta') return;
          for (const ev of parser.push(d.partial_json || '')) if (ev.text && ev.key) activity.delta(id, ev.key, ev.text);
        },
        end: () => activity.upsert({ id, live: false }),
      });
    }
  }

  push(chunk) {
    this.buf += this.decoder.write(chunk);
    if (this.buf.indexOf('\r') !== -1) this.buf = this.buf.replace(/\r\n?/g, '\n');
    let i;
    while ((i = this.buf.indexOf('\n\n')) !== -1) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      this.event(raw);
    }
  }

  event(raw) {
    let type = '';
    let data = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
    }
    if (!data) return;
    // Deltas are the bulk of the stream; skip parsing them unless a tracked block is open.
    if (type === 'content_block_delta' && this.blocks.size === 0 && this.acts.size === 0) return;
    if (type === 'ping') return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    type = msg.type || type;
    if (type === 'message_start') {
      this.msgId = (msg.message && msg.message.id) || '';
    } else if (type === 'content_block_start') {
      const b = msg.content_block;
      if (b && b.type === 'tool_use' && LIVE_TOOLS.has(b.name)) this.blocks.set(msg.index, new LiveStream(b.id, b.name));
      if (b) {
        try { this.actStart(msg.index, b); } catch (e) { log('activity tap error', e.message); }
      }
    } else if (type === 'content_block_delta') {
      const s = this.blocks.get(msg.index);
      if (s && msg.delta && msg.delta.type === 'input_json_delta') s.feed(msg.delta.partial_json || '');
      const a = this.acts.get(msg.index);
      if (a && msg.delta) a.delta(msg.delta);
    } else if (type === 'content_block_stop') {
      const s = this.blocks.get(msg.index);
      if (s) {
        s.end(false);
        this.blocks.delete(msg.index);
      }
      const a = this.acts.get(msg.index);
      if (a) {
        a.end();
        this.acts.delete(msg.index);
      }
    } else if (type === 'message_stop') {
      this.finish(false);
    } else if (type === 'error') {
      this.finish(true);
    }
  }

  finish(aborted) {
    for (const s of this.blocks.values()) s.end(aborted);
    this.blocks.clear();
    for (const a of this.acts.values()) a.end();
    this.acts.clear();
  }
}

// ---------------------------------------------------------------------------
// API proxy

const HOP_REQ = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'accept-encoding']);
const HOP_RES = new Set(['connection', 'keep-alive', 'transfer-encoding']);

function apiError(res, status, message) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
}

// Without `eager_input_streaming`, the API buffers each tool parameter until it is complete,
// so a Write's `content` would arrive in one burst. This is the only change the proxy makes to
// a request: it sets the flag on the Write and Edit tool definitions of streaming requests.
// If the upstream rejects it, the request is resent untouched and the flag is not added again.
let eagerStreaming = process.env.CODE_VIZ_EAGER !== '0' && config.eagerStreaming !== false;

function withEagerStreaming(raw) {
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return null; }
  if (!body || body.stream !== true || !Array.isArray(body.tools)) return null;
  let changed = false;
  for (const tool of body.tools) {
    if (tool && (!tool.type || tool.type === 'custom') && LIVE_TOOLS.has(tool.name) && tool.eager_input_streaming === undefined) {
      tool.eager_input_streaming = true;
      changed = true;
    }
  }
  return changed ? Buffer.from(JSON.stringify(body)) : null;
}

function readBuffer(req, cb) {
  const chunks = [];
  let size = 0;
  let failed = false;
  req.on('data', (c) => {
    if (failed) return;
    size += c.length;
    if (size > 256 * 1024 * 1024) {
      failed = true;
      cb(new Error('request body too large'));
    } else chunks.push(c);
  });
  req.on('end', () => { if (!failed) cb(null, Buffer.concat(chunks)); });
  req.on('error', (e) => { if (!failed) { failed = true; cb(e); } });
}

function proxy(req, res) {
  if (UPSTREAM_IS_SELF) return apiError(res, 500, 'code-viz: upstream points back at the proxy; set "upstream" in ~/.claude/code-viz/config.json');
  const wasIdle = Date.now() - stats.lastAt > 15 * 60e3;
  stats.requests++;
  stats.lastAt = Date.now();
  if (wasIdle) broadcast('proxy', liveInfo());

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_REQ.has(k)) headers[k] = v;
  headers.host = UPSTREAM.host;

  const ctx = { req, res, headers, route: req.url.split('?')[0], started: Date.now(), up: null, tap: null };
  res.on('close', () => {
    if (!res.writableFinished) {
      if (ctx.up) ctx.up.destroy();
      if (ctx.tap) ctx.tap.finish(true);
    }
  });
  req.on('error', () => { if (ctx.up) ctx.up.destroy(); });

  if (!(eagerStreaming && req.method === 'POST' && ctx.route === '/v1/messages')) return forward(ctx, req, null);
  readBuffer(req, (err, raw) => {
    if (err) return apiError(res, 413, `code-viz proxy: ${err.message}`);
    let modified = null;
    try { modified = withEagerStreaming(raw); } catch (e) { log('rewrite error', e.message); }
    if (modified) forward(ctx, modified, raw);
    else forward(ctx, raw, null);
  });
}

// Send the request upstream and stream the response back. `body` is the incoming request
// stream or a Buffer; `original` is set when `body` was modified and is the fallback.
function forward(ctx, body, original, isRetry) {
  const { req, res, route } = ctx;
  const headers = { ...ctx.headers };
  if (Buffer.isBuffer(body)) {
    headers['content-length'] = String(body.length);
    delete headers['transfer-encoding'];
  }
  const up = upstreamLib.request(
    {
      protocol: UPSTREAM.protocol,
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || undefined,
      method: req.method,
      path: upstreamPrefix + req.url,
      headers,
      agent: upstreamAgent,
    },
    (ur) => {
      if (original && ur.statusCode === 400) {
        const chunks = [];
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => {
          let message = '';
          try { message = String(JSON.parse(Buffer.concat(chunks).toString('utf8')).error.message).slice(0, 200); } catch {}
          log('upstream returned 400 with eager_input_streaming set; retrying unmodified:', message);
          forward(ctx, original, null, true);
        });
        return;
      }
      if (isRetry && ur.statusCode !== 400 && eagerStreaming) {
        eagerStreaming = false;
        log('upstream rejected eager_input_streaming; no longer adding it (tool input will arrive in bursts)');
      }
      const out = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP_RES.has(k)) out[k] = v;
      res.writeHead(ur.statusCode, ur.statusMessage, out);
      const sse = /text\/event-stream/i.test(ur.headers['content-type'] || '') && !ur.headers['content-encoding'];
      if (sse) {
        const tap = (ctx.tap = new SSETap());
        ur.on('data', (chunk) => {
          try { tap.push(chunk); } catch (e) { log('tap error', e.message); }
        });
      }
      ur.pipe(res);
      ur.on('end', () => {
        if (ctx.tap) ctx.tap.finish(true);
        log('proxy', req.method, route, ur.statusCode, `${Date.now() - ctx.started}ms`);
      });
      const fail = () => {
        if (ctx.tap) ctx.tap.finish(true);
        res.destroy();
      };
      ur.on('aborted', fail);
      ur.on('error', fail);
    }
  );
  ctx.up = up;
  up.on('error', (e) => {
    log('upstream error', req.method, route, e.code || e.message);
    if (ctx.tap) ctx.tap.finish(true);
    apiError(res, 502, `code-viz proxy could not reach ${UPSTREAM.origin}: ${e.code || e.message}`);
  });
  if (Buffer.isBuffer(body)) up.end(body);
  else body.pipe(up);
}

let settingsCache = { t: 0, configured: false };
function liveConfigured() {
  if (Date.now() - settingsCache.t > 5000) {
    const s = readJSON(path.join(os.homedir(), '.claude', 'settings.json'), {});
    const url = s && s.env && s.env.ANTHROPIC_BASE_URL;
    settingsCache = { t: Date.now(), configured: typeof url === 'string' && HOSTS.has(hostOf(url)) };
  }
  return settingsCache.configured;
}
function liveInfo() {
  return {
    configured: liveConfigured(),
    active: Date.now() - stats.lastAt < 15 * 60e3,
    lastAt: stats.lastAt,
    requests: stats.requests,
    streams: stats.streams,
    eager: eagerStreaming,
  };
}

// ---------------------------------------------------------------------------
// Demo

const demoApi = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  project(dir) { projects.add(dir); },
  id() { return 'demo_' + crypto.randomBytes(8).toString('hex'); },
  stream(id, tool, baseText) {
    return new LiveStream(id, tool, () => ({ exists: baseText != null, text: baseText }));
  },
  pre(id, tool, file, before) {
    broadcast('pre', { toolUseId: id, tool, file, ...where(file), session: 'demo', ts: Date.now(), before, exists: before != null });
  },
  post(id, tool, file, before, after) {
    remember(file, after);
    return recordEdit({ toolUseId: id, tool, file, session: 'demo', before, after, created: before == null, demo: true });
  },
};
let demoRunning = false;

// ---------------------------------------------------------------------------
// HTTP server

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/__cv/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/__cv/diff.js': ['diff.js', 'text/javascript; charset=utf-8'],
  '/__cv/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/__cv/icon.svg': ['icon.svg', 'image/svg+xml'],
};

// True when version a is newer than b ("0.10.0" > "0.9.3").
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function deny(res, why) {
  res.writeHead(403, { 'content-type': 'text/plain' });
  res.end(`code-viz: forbidden (${why})`);
}
function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  let failed = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES && !failed) {
      failed = true;
      cb(new Error('body too large'));
      req.destroy();
    } else if (!failed) chunks.push(c);
  });
  req.on('end', () => { if (!failed) cb(null, Buffer.concat(chunks).toString('utf8')); });
  req.on('error', (e) => { if (!failed) { failed = true; cb(e); } });
}

function openEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  send(res, 'hello', {
    version: VERSION,
    pid: process.pid,
    live: liveInfo(),
    github: blamer.githubStatus(),
    history: history.map(meta),
    latest: history.length ? history[history.length - 1] : null,
    activity: activity.snapshot(),
    screens: screens.list(),
  });
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function local(req, res, pathname, url) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    const file = STATIC[pathname];
    if (file) {
      fs.readFile(path.join(VIEWER, file[0]), (err, buf) => {
        if (err) return json(res, 404, { error: 'missing asset' });
        res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' });
        res.end(buf);
      });
      return;
    }
    if (pathname === '/__cv/config.js') {
      // Viewer defaults from the config file, read on every page load so an edit applies on reload.
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(`window.CODE_VIZ_CONFIG = ${JSON.stringify(settings.viewerOptions())};\n`);
    }
    if (pathname === '/__cv/events') return openEvents(req, res);
    if (pathname === '/__cv/usage') {
      usage.ensure();
      return json(res, 200, usage.snapshot());
    }
    if (pathname === '/__cv/health') {
      return json(res, 200, { name: 'code-viz', version: VERSION, pid: process.pid, port: PORT, root: path.resolve(__dirname, '..'), upstream: UPSTREAM.origin, live: liveInfo(), github: blamer.githubStatus(), viewers: clients.size });
    }
    const sm = pathname.match(/^\/__cv\/screen\/(\d+)$/);
    if (sm) {
      const sc = screens.get(sm[1]);
      return sc ? json(res, 200, sc) : json(res, 404, { error: 'not found' });
    }
    const m = pathname.match(/^\/__cv\/edit\/(\d+)$/);
    if (m) {
      const edit = history.find((h) => h.id === Number(m[1]));
      return edit ? json(res, 200, edit) : json(res, 404, { error: 'not found' });
    }
    if (pathname === '/__cv/blame') {
      const file = new URL(url, 'http://localhost').searchParams.get('path');
      if (!file || !known.has(file)) return json(res, 404, { error: 'unknown file' });
      if (runDemo.owns(file)) return json(res, 200, runDemo.blame(file, known.get(file)));
      blamer
        .blame(file, readText(file).text)
        .then((r) => json(res, 200, r))
        .catch((e) => {
          log('blame error', e.stack);
          json(res, 500, { error: 'blame failed' });
        });
      return;
    }
    if (pathname === '/__cv/file') {
      const file = new URL(url, 'http://localhost').searchParams.get('path');
      // Only files Claude has already touched; this is not a general file server.
      if (!file || !known.has(file)) return json(res, 404, { error: 'unknown file' });
      const r = readText(file);
      return json(res, 200, { file, text: r.text, exists: r.exists });
    }
    return json(res, 404, { error: 'not found' });
  }

  if (req.method === 'POST') {
    // A custom header forces a CORS preflight for cross-site requests, which is never answered.
    if (req.headers['x-code-viz'] !== '1') return deny(res, 'header');
    if (pathname === '/__cv/hook') {
      return readBody(req, (err, body) => {
        if (err) return json(res, 413, { error: err.message });
        let payload;
        try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
        try { handleHook(payload, String(req.headers['x-code-viz-entry'] || '')); } catch (e) { log('hook error', e.stack); }
        json(res, 200, { ok: true });
      });
    }
    if (pathname === '/__cv/statusline') {
      // From the optional status line forwarder: only the plan usage numbers are kept.
      return readBody(req, (err, body) => {
        let line = '';
        if (!err) {
          try { line = usage.statusline(JSON.parse(body)); } catch {}
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(line);
      });
    }
    if (pathname === '/__cv/demo') {
      json(res, 200, { ok: true, running: demoRunning });
      if (!demoRunning) {
        demoRunning = true;
        runDemo(demoApi)
          .catch((e) => log('demo error', e.stack))
          .finally(() => { demoRunning = false; });
      }
      return;
    }
    if (pathname === '/__cv/shutdown') {
      // Sessions keep running the plugin copy they started with, so an older copy's
      // ensure-server would otherwise replace this server with its own version on every
      // prompt. Only a caller at least as new as this server (or `?force=1`) may stop it.
      const theirs = String(req.headers['x-code-viz-version'] || '0');
      const force = new URL(url, 'http://localhost').searchParams.get('force') === '1';
      if (!force && newer(VERSION, theirs)) {
        log(`refused shutdown from older client ${theirs}`);
        return json(res, 409, { ok: false, error: `a newer Code Viz (${VERSION}) is running`, version: VERSION });
      }
      json(res, 200, { ok: true });
      log('shutdown requested');
      setTimeout(() => process.exit(0), 50);
      return;
    }
  }
  json(res, 404, { error: 'not found' });
}

function route(req, res) {
  // Host and Origin checks block DNS-rebinding and cross-site requests from web pages.
  const host = String(req.headers.host || '').toLowerCase();
  if (!HOSTS.has(host)) return deny(res, 'host');
  const origin = req.headers.origin;
  if (origin && !ORIGINS.has(origin)) return deny(res, 'origin');
  const url = req.url || '/';
  if (!url.startsWith('/')) return deny(res, 'url');
  const pathname = url.split('?')[0];
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  if (pathname === '/' || pathname.startsWith('/__cv/')) return local(req, res, pathname, url);
  return proxy(req, res);
}

const server = http.createServer((req, res) => {
  try {
    route(req, res);
  } catch (e) {
    log('route error', e.stack);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
server.keepAliveTimeout = 120e3;
server.headersTimeout = 125e3;
server.requestTimeout = 0;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`port ${PORT} already in use; exiting`);
    process.exit(0);
  }
  log('server error', e.stack);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`code-viz ${VERSION} listening on http://127.0.0.1:${PORT} (pid ${process.pid}, upstream ${UPSTREAM.origin})`);
  try { fs.writeFileSync(path.join(HOME, 'server.pid'), String(process.pid)); } catch {}
  try { transcripts.start(); } catch (e) { log('transcripts failed to start', e.stack); }
});

process.on('uncaughtException', (e) => log('uncaught', e && e.stack));
process.on('unhandledRejection', (e) => log('unhandled', e && e.stack));
