'use strict';
// Tool screens: a terminal for shell commands, and a browser for web searches and page
// fetches, built from hook payloads (PreToolUse starts a screen, PostToolUse or
// PostToolUseFailure finishes it).
//
// Everything a screen holds is redacted (see redact.js) and capped before it is stored or
// sent to the viewer, and it only ever goes to the local viewer.

const path = require('path');
const os = require('os');
const { redact } = require('./redact');
const { classify } = require('./activity');

const MAX_SCREENS = 100;
const MAX_LINE = 400;
const MAX_TEXT = 60000;
const MAX_SUMMARY = 6000;
const MAX_COMMAND = 4000;
const TERMINAL = new Set(['Bash', 'PowerShell']);
const BROWSER = new Set(['WebSearch', 'WebFetch']);

const home = os.homedir();
const tilde = (p) => (typeof p === 'string' && p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p || '');
const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s || '');
function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// The last `maxLines` lines of `text`, each at most MAX_LINE characters, redacted.
function tail(text, maxLines) {
  if (typeof text !== 'string' || !text) return { text: '', lines: 0, dropped: 0 };
  let t = text.length > MAX_TEXT * 2 ? text.slice(-MAX_TEXT * 2) : text;
  t = redact(t.replace(/\r\n?/g, '\n').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''));
  let lines = t.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  // Lines in the whole output (a trailing newline doesn't start another line).
  const total = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (lines.length > maxLines) lines = lines.slice(-maxLines);
  lines = lines.map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) + '…' : l));
  let out = lines.join('\n');
  if (out.length > MAX_TEXT) out = out.slice(-MAX_TEXT);
  return { text: out, lines: lines.length, dropped: Math.max(0, total - lines.length) };
}

class Screens {
  constructor({ broadcast, settings, log }) {
    this.broadcast = broadcast;
    this.settings = settings;
    this.log = log || (() => {});
    this.items = new Map();
    this.byTool = new Map();
    this.seq = 0;
  }

  enabled(tool) {
    const c = this.settings.load();
    if (TERMINAL.has(tool)) return c.terminalScreen;
    if (BROWSER.has(tool)) return c.browserScreen;
    return false;
  }

  fromHook(p) {
    const event = p.hook_event_name;
    const tool = p.tool_name;
    if (!tool || !p.tool_use_id || !(TERMINAL.has(tool) || BROWSER.has(tool))) return;
    if (event === 'PreToolUse') {
      if (!this.enabled(tool) || this.byTool.has(p.tool_use_id)) return;
      this.start(p);
    } else if (event === 'PostToolUse' || event === 'PostToolUseFailure' || event === 'PermissionDenied') {
      let id = this.byTool.get(p.tool_use_id);
      // A result without a start (the viewer or server started mid-call): make the screen now.
      if (!id) {
        if (!this.enabled(tool)) return;
        id = this.start(p, true);
      }
      this.finish(this.items.get(id), p, event);
    }
  }

  start(p, quiet) {
    const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
    const s = { id: ++this.seq, toolUseId: p.tool_use_id, tool: p.tool_name, session: p.session_id || null, ts: Date.now(), status: 'running', cwd: tilde(p.cwd) };
    if (TERMINAL.has(p.tool_name)) {
      const meta = classify(p.tool_name === 'PowerShell' ? 'Bash' : 'Bash', input, p.cwd);
      s.kind = 'terminal';
      s.command = cut(redact(typeof input.command === 'string' ? input.command : ''), MAX_COMMAND);
      s.description = cut(redact(typeof input.description === 'string' ? input.description : ''), 300);
      s.background = !!input.run_in_background;
      s.program = p.tool_name === 'PowerShell' ? 'PowerShell' : meta.svc === 'shell' ? (meta.title !== 'Shell' ? meta.title : 'sh') : meta.title;
      s.shell = p.tool_name === 'PowerShell' ? 'ps' : 'sh';
    } else if (p.tool_name === 'WebSearch') {
      s.kind = 'search';
      s.query = cut(redact(typeof input.query === 'string' ? input.query : ''), 500);
      s.domains = Array.isArray(input.allowed_domains) ? input.allowed_domains.slice(0, 8).map(String) : [];
    } else {
      s.kind = 'fetch';
      s.url = cut(redact(typeof input.url === 'string' ? input.url : ''), 2000);
      s.domain = domainOf(s.url);
      s.prompt = cut(redact(typeof input.prompt === 'string' ? input.prompt : ''), 500);
    }
    this.items.set(s.id, s);
    this.byTool.set(s.toolUseId, s.id);
    while (this.items.size > MAX_SCREENS) {
      const first = this.items.keys().next().value;
      this.byTool.delete(this.items.get(first).toolUseId);
      this.items.delete(first);
    }
    if (!quiet) this.broadcast('screen-start', s);
    return s.id;
  }

  finish(s, p, event) {
    if (!s || s.ended) return;
    const r = p.tool_response;
    const maxLines = this.settings.load().screenLines;
    s.ended = Date.now();
    s.durationMs = Number.isFinite(p.duration_ms) ? p.duration_ms : s.ended - s.ts;
    if (event === 'PermissionDenied') s.status = 'denied';
    else if (event === 'PostToolUseFailure') s.status = p.is_interrupt ? 'interrupted' : 'error';
    else s.status = 'ok';

    if (s.kind === 'terminal') {
      if (event === 'PostToolUseFailure') {
        const err = typeof p.error === 'string' ? p.error : '';
        const m = /^Exit code (-?\d+)\s*\n?/.exec(err);
        s.exitCode = m ? Number(m[1]) : null;
        s.output = tail(m ? err.slice(m[0].length) : err, maxLines);
      } else if (event === 'PostToolUse') {
        if (r && typeof r === 'object') {
          s.output = tail(typeof r.stdout === 'string' ? r.stdout : '', maxLines);
          s.stderr = tail(typeof r.stderr === 'string' ? r.stderr : '', Math.max(20, Math.round(maxLines / 4)));
          if (r.interrupted) s.status = 'interrupted';
          if (r.backgroundTaskId) {
            s.status = 'background';
            s.backgroundTaskId = String(r.backgroundTaskId).slice(0, 80);
          }
          if (r.isImage) s.image = true;
        } else s.output = tail(typeof r === 'string' ? r : '', maxLines);
        s.exitCode = s.status === 'ok' ? 0 : null;
      }
    } else if (s.kind === 'search') {
      s.results = [];
      const summary = [];
      if (r && typeof r === 'object' && Array.isArray(r.results)) {
        for (const item of r.results) {
          if (typeof item === 'string') summary.push(item);
          else if (item && Array.isArray(item.content)) {
            for (const c of item.content) {
              if (!c || typeof c.url !== 'string' || s.results.length >= 20) continue;
              const url = redact(c.url);
              s.results.push({ title: cut(redact(typeof c.title === 'string' ? c.title : url), 200), url: cut(url, 500), domain: domainOf(url) });
            }
          }
        }
        if (Number.isFinite(r.durationSeconds)) s.searchSeconds = r.durationSeconds;
      } else if (typeof r === 'string') summary.push(r);
      if (event === 'PostToolUseFailure' && typeof p.error === 'string') summary.push(p.error);
      s.summary = cut(redact(summary.join('\n\n').trim()), MAX_SUMMARY);
    } else if (s.kind === 'fetch') {
      if (r && typeof r === 'object') {
        if (Number.isFinite(r.code)) s.http = { code: r.code, text: typeof r.codeText === 'string' ? r.codeText.slice(0, 60) : '', bytes: Number.isFinite(r.bytes) ? r.bytes : null };
        if (typeof r.url === 'string' && r.url) {
          s.url = cut(redact(r.url), 2000);
          s.domain = domainOf(s.url);
        }
        s.summary = cut(redact(typeof r.result === 'string' ? r.result : ''), MAX_SUMMARY);
      } else s.summary = cut(redact(typeof r === 'string' ? r : typeof p.error === 'string' ? p.error : ''), MAX_SUMMARY);
    }
    this.broadcast('screen-end', s);
  }

  get(id) {
    return this.items.get(Number(id)) || null;
  }

  // For the viewer's timeline when it connects.
  list() {
    return [...this.items.values()].map((s) => ({ id: s.id, kind: s.kind, ts: s.ts, status: s.status, label: s.kind === 'terminal' ? s.command.split('\n')[0].slice(0, 80) : s.kind === 'search' ? s.query : s.url }));
  }
}

module.exports = { Screens, tail };
