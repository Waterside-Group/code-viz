'use strict';
// Token usage: per repository from Claude Code session transcripts, and the plan's 5-hour
// session window.
//
// From each transcript line this reads only the usage numbers, the model, the timestamp, the
// working directory and ids. Message content is parsed only transiently (to find those fields)
// and is never kept, logged or sent anywhere.
//
//  - Transcripts (~/.claude/projects/**/*.jsonl) are read backwards from the end at startup,
//    only as far as HORIZON_MS, then followed forwards by byte offset as they grow.
//  - Claude Code writes one line per content block of a reply, each with the same message id
//    and usage; only output_tokens grows between them. Records are merged by message id,
//    keeping the largest value of each field.
//  - Plan usage (percent of the 5-hour and 7-day limits, reset times) is not in transcripts or
//    hook input. Claude Code passes it only to status line commands, so it comes from the
//    optional status line forwarder (POST /__cv/statusline). Without it, the window is
//    estimated from local activity and an ETA needs a token budget from the config.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const ROOT = process.env.CODE_VIZ_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const HORIZON_MS = 24 * 3600e3;
const WINDOW_MS = 5 * 3600e3;
const SLACK_MS = 3600e3;
const ACTIVE_MS = 5 * 60e3;
const CHUNK = 1 << 20;
const POLL_MS = 3000;
const DISCOVER_MS = 30e3;
const HOUR = 3600e3;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

// The usage fields of one transcript line, or null for any other line.
function parseLine(line) {
  if (!line || line.indexOf('"usage"') === -1 || line.indexOf('"assistant"') === -1) return null;
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || j.type !== 'assistant' || !j.message || typeof j.message !== 'object') return null;
  const m = j.message;
  const u = m.usage;
  if (!u || typeof u !== 'object' || m.model === '<synthetic>') return null;
  const ts = Date.parse(j.timestamp);
  if (!Number.isFinite(ts)) return null;
  return {
    id: String(m.id || j.requestId || j.uuid || ''),
    ts,
    session: typeof j.sessionId === 'string' ? j.sessionId : '',
    cwd: typeof j.cwd === 'string' ? j.cwd : '',
    model: typeof m.model === 'string' ? m.model : '',
    in: num(u.input_tokens),
    out: num(u.output_tokens),
    cw: num(u.cache_creation_input_tokens),
    cr: num(u.cache_read_input_tokens),
  };
}

// The headline total: tokens sent, written to the cache, and generated. Cache reads are
// listed on their own: they are re-reads of context already paid for, often 100 times larger
// than everything else, and would drown out the other numbers.
const headline = (r) => r.in + r.cw + r.out;

const floorHour = (t) => Math.floor(t / HOUR) * HOUR;

class Usage {
  constructor({ log, onChange, settings }) {
    this.log = log || (() => {});
    this.onChange = onChange || (() => {});
    this.settings = settings;
    this.records = new Map();
    this.files = new Map();
    this.repos = new Map();
    this.limits = null;
    this.samples = [];
    this.scanning = false;
    this.changeTimer = null;
    this.cache = null;
  }

  // Started by the first request for usage (a viewer with the panel on), so nothing is read
  // while no one is looking.
  ensure() {
    if (this.started) return;
    this.started = true;
    this.start();
  }

  start() {
    this.discover(true).catch((e) => this.log('usage discover failed', e.message));
    setInterval(() => this.poll(), POLL_MS).unref();
    setInterval(() => this.discover(false).catch(() => {}), DISCOVER_MS).unref();
    setInterval(() => this.prune(), 10 * 60e3).unref();
    // Times (ETA, "active", the window) move on even when nothing new is written.
    setInterval(() => this.changed(), 30e3).unref();
  }

  changed() {
    this.cache = null;
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      try { this.onChange(); } catch (e) { this.log('usage change error', e.message); }
    }, 1500);
  }

  // Transcript files touched within the horizon: <project>/<session>.jsonl and
  // <project>/<session>/subagents/*.jsonl.
  async discover(initial) {
    const cutoff = Date.now() - HORIZON_MS;
    const found = [];
    let dirs;
    try { dirs = await fsp.readdir(ROOT, { withFileTypes: true }); } catch { return; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(ROOT, d.name);
      let names;
      try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const n of names) {
        const p = path.join(dir, n.name);
        if (n.isFile() && n.name.endsWith('.jsonl')) found.push(p);
        else if (n.isDirectory()) {
          let subs;
          try { subs = await fsp.readdir(path.join(p, 'subagents')); } catch { continue; }
          for (const s of subs) if (s.endsWith('.jsonl')) found.push(path.join(p, 'subagents', s));
        }
      }
    }
    const fresh = [];
    for (const f of found) {
      if (this.files.has(f)) continue;
      try {
        const st = await fsp.stat(f);
        if (st.mtimeMs >= cutoff) fresh.push({ f, m: st.mtimeMs });
      } catch {}
    }
    if (!fresh.length) return;
    fresh.sort((a, b) => b.m - a.m);
    if (initial) this.scanning = true;
    for (const { f } of fresh) await this.track(f);
    if (initial) {
      this.scanning = false;
      this.log(`usage: ${this.records.size} replies in ${this.files.size} transcripts from the last 24 hours`);
    }
    this.changed();
  }

  // A transcript was named in a hook or seen changing.
  touch(file) {
    if (!this.started || typeof file !== 'string' || !file.endsWith('.jsonl')) return;
    const f = path.resolve(file);
    if (this.files.has(f)) this.readForward(this.files.get(f));
    else this.track(f).catch(() => {});
  }

  async track(file) {
    if (this.files.has(file)) return;
    const t = { file, pos: 0, busy: false, again: false, at: Date.now() };
    this.files.set(file, t);
    t.busy = true;
    try {
      const st = await fsp.stat(file);
      t.pos = await this.scanBack(file, st.size, Date.now() - HORIZON_MS);
    } catch (e) {
      this.files.delete(file);
      return;
    } finally {
      t.busy = false;
    }
    if (t.again) this.readForward(t);
    this.changed();
  }

  add(r) {
    if (!r) return;
    const key = r.id || `${r.session}:${r.ts}`;
    const prev = this.records.get(key);
    if (!prev) {
      this.records.set(key, r);
    } else {
      prev.in = Math.max(prev.in, r.in);
      prev.out = Math.max(prev.out, r.out);
      prev.cw = Math.max(prev.cw, r.cw);
      prev.cr = Math.max(prev.cr, r.cr);
      prev.ts = Math.min(prev.ts, r.ts);
      if (!prev.cwd) prev.cwd = r.cwd;
    }
    if (r.cwd && !this.repos.has(r.cwd)) this.resolve(r.cwd);
  }

  // Read a file from the end back to `horizon` (with some slack, since lines are only roughly
  // in time order). Returns the offset just past the last complete line, where forward reading
  // continues.
  async scanBack(file, size, horizon) {
    const fh = await fsp.open(file, 'r');
    let end = 0;
    try {
      // Forward reading continues after the last newline, so a line still being written is
      // read once it is complete.
      for (let at = size; at > 0 && !end; ) {
        const len = Math.min(64 * 1024, at);
        at -= len;
        const tail = Buffer.alloc(len);
        await fh.read(tail, 0, len, at);
        const nl = tail.lastIndexOf(10);
        if (nl !== -1) end = at + nl + 1;
      }
      let pos = end;
      let carry = Buffer.alloc(0);
      let done = false;
      // Stop after several replies in a row older than the horizon, so one stray old line
      // (copied history, clock changes) doesn't end the scan early.
      let old = 0;
      while (pos > 0 && !done) {
        const len = Math.min(CHUNK, pos);
        pos -= len;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, pos);
        let data = carry.length ? Buffer.concat([buf, carry]) : buf;
        let from = 0;
        if (pos > 0) {
          const nl = data.indexOf(10);
          if (nl === -1) {
            carry = data;
            continue;
          }
          carry = Buffer.from(data.subarray(0, nl));
          from = nl + 1;
        } else carry = Buffer.alloc(0);
        const lines = data.subarray(from).toString('utf8').split('\n');
        data = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          const r = parseLine(lines[i]);
          if (!r) continue;
          if (r.ts < horizon - SLACK_MS) {
            if (++old >= 5) {
              done = true;
              break;
            }
            continue;
          }
          old = 0;
          if (r.ts >= horizon) this.add(r);
        }
        // Let hook requests through between chunks of a large file.
        await new Promise((res) => setImmediate(res));
      }
    } finally {
      await fh.close().catch(() => {});
    }
    return end;
  }

  async readForward(t) {
    if (t.busy) {
      t.again = true;
      return;
    }
    t.busy = true;
    t.again = false;
    let added = false;
    try {
      const st = await fsp.stat(t.file);
      if (st.size < t.pos) {
        // Rewritten or truncated: start over.
        t.pos = await this.scanBack(t.file, st.size, Date.now() - HORIZON_MS);
        added = true;
      } else if (st.size > t.pos) {
        const fh = await fsp.open(t.file, 'r');
        try {
          // Split on newline bytes (never part of a multi-byte character) and keep a partial
          // last line for the next read.
          let at = t.pos;
          let carry = Buffer.alloc(0);
          while (at < st.size) {
            const len = Math.min(CHUNK, st.size - at);
            const buf = Buffer.alloc(len);
            const { bytesRead } = await fh.read(buf, 0, len, at);
            if (bytesRead <= 0) break;
            at += bytesRead;
            const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
            const nl = data.lastIndexOf(10);
            if (nl === -1) {
              carry = Buffer.from(data);
              continue;
            }
            for (const line of data.subarray(0, nl).toString('utf8').split('\n')) {
              const r = parseLine(line);
              if (r) {
                this.add(r);
                added = true;
              }
            }
            carry = Buffer.from(data.subarray(nl + 1));
          }
          t.pos = at - carry.length;
        } finally {
          await fh.close().catch(() => {});
        }
      }
      t.at = Date.now();
    } catch {
      this.files.delete(t.file);
    } finally {
      t.busy = false;
    }
    if (added) this.changed();
    if (t.again) this.readForward(t);
  }

  poll() {
    for (const t of this.files.values()) {
      fs.stat(t.file, (err, st) => {
        if (err) return this.files.delete(t.file);
        if (st.size !== t.pos) this.readForward(t);
      });
    }
  }

  prune() {
    const cutoff = Date.now() - HORIZON_MS;
    for (const [k, r] of this.records) if (r.ts < cutoff) this.records.delete(k);
    for (const [f, t] of this.files) if (t.at < cutoff) this.files.delete(f);
    this.samples = this.samples.filter((s) => s.t > Date.now() - WINDOW_MS);
    this.changed();
  }

  // Map a working directory to its repository: the main checkout for a git worktree, else
  // the top of the working tree, else the directory itself.
  resolve(cwd) {
    this.repos.set(cwd, null);
    execFile('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { timeout: 5000 }, (err, stdout) => {
      let root = null;
      let git = false;
      if (!err) {
        const [top, common] = String(stdout).trim().split('\n');
        if (top) {
          git = true;
          root = common && path.basename(common) === '.git' ? path.dirname(common) : top;
        }
      }
      if (!root) {
        // A worktree that no longer exists: Claude Code keeps them under <repo>/.claude/worktrees/.
        const m = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/.exec(cwd);
        root = m ? m[1] : cwd;
        git = !!m;
      }
      this.repos.set(cwd, { root, git });
      this.changed();
    });
  }

  repoOf(cwd) {
    const hit = this.repos.get(cwd);
    if (hit) return hit;
    return { root: cwd || '(unknown)', git: false, pending: true };
  }

  // Plan usage from the status line forwarder. Only the rate_limits numbers are kept.
  statusline(payload) {
    const rl = payload && typeof payload === 'object' ? payload.rate_limits : null;
    const pick = (w) => (w && typeof w === 'object' && Number.isFinite(w.used_percentage) && Number.isFinite(w.resets_at) ? { pct: w.used_percentage, resetsAt: w.resets_at * 1000 } : null);
    const five = pick(rl && rl.five_hour);
    const week = pick(rl && rl.seven_day);
    if (five || week) {
      const now = Date.now();
      this.limits = { five, week, at: now };
      if (five) {
        this.samples = this.samples.filter((s) => s.resetsAt === five.resetsAt);
        const last = this.samples[this.samples.length - 1];
        if (!last || now - last.t > 20e3 || last.pct !== five.pct) this.samples.push({ t: now, pct: five.pct, resetsAt: five.resetsAt });
        if (this.samples.length > 500) this.samples.shift();
      }
      this.changed();
    }
    return this.statusText();
  }

  statusText() {
    const s = this.snapshot().session;
    if (s.source !== 'statusline') return '';
    const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    let text = `5h ${Math.round(s.usedPercent)}% · resets ${clock(s.resetsAt)}`;
    if (s.eta && s.eta.at) text += ` · 100% by ${clock(s.eta.at)}`;
    if (s.weekPercent != null) text += ` · 7d ${Math.round(s.weekPercent)}%`;
    return text;
  }

  // Tokens per minute over the last `minutes`, or since `since` if that is later.
  burn(now, minutes, since) {
    const from = Math.max(now - minutes * 60e3, since || 0);
    const span = Math.max(60e3, now - from);
    let tokens = 0;
    for (const r of this.records.values()) if (r.ts >= from) tokens += headline(r);
    return { tokensPerMinute: Math.round(tokens / (span / 60e3)), minutes: Math.round(span / 60e3) };
  }

  // The current 5-hour window, estimated from local activity: a window starts with the first
  // reply after the previous one ended (start rounded down to the hour) and lasts 5 hours.
  estimateWindow(now) {
    const times = [...this.records.values()].map((r) => r.ts).sort((a, b) => a - b);
    let start = null;
    let end = 0;
    for (const t of times) {
      if (t >= end) {
        start = floorHour(t);
        end = start + WINDOW_MS;
      }
    }
    return start != null && now < end ? { start, end } : null;
  }

  snapshot() {
    const now = Date.now();
    if (this.cache && now - this.cache.t < 1000) return this.cache.v;
    const cfg = this.settings.load();
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);

    // The 5-hour window: real, from the status line, while its reset time is ahead.
    const five = this.limits && this.limits.five && this.limits.five.resetsAt > now ? this.limits.five : null;
    const week = this.limits && this.limits.week && this.limits.week.resetsAt > now ? this.limits.week : null;
    const est = five ? null : this.estimateWindow(now);
    const win = five ? { start: five.resetsAt - WINDOW_MS, end: five.resetsAt } : est;

    const since = cfg.usagePeriod === 'window' ? (win ? win.start : now) : midnight.getTime();
    const groups = new Map();
    const all = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
    let windowTokens = 0;
    for (const r of this.records.values()) {
      if (win && r.ts >= win.start) windowTokens += headline(r);
      if (r.ts < since) continue;
      const repo = this.repoOf(r.cwd);
      let g = groups.get(repo.root);
      if (!g) {
        g = { name: path.basename(repo.root) || repo.root, path: repo.root, git: repo.git, in: 0, out: 0, cacheWrite: 0, cacheRead: 0, total: 0, replies: 0, sessions: new Set(), models: new Map(), lastAt: 0 };
        groups.set(repo.root, g);
      }
      g.in += r.in;
      g.out += r.out;
      g.cacheWrite += r.cw;
      g.cacheRead += r.cr;
      g.total += headline(r);
      g.replies++;
      if (r.session) g.sessions.add(r.session);
      if (r.model) g.models.set(r.model, (g.models.get(r.model) || 0) + headline(r));
      g.lastAt = Math.max(g.lastAt, r.ts);
      all.in += r.in;
      all.out += r.out;
      all.cacheWrite += r.cw;
      all.cacheRead += r.cr;
      all.total += headline(r);
    }
    const home = os.homedir();
    const repos = [...groups.values()]
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((g) => ({
        ...g,
        path: g.path.startsWith(home + path.sep) ? '~' + g.path.slice(home.length) : g.path,
        sessions: g.sessions.size,
        models: [...g.models].sort((a, b) => b[1] - a[1]).map(([model, total]) => ({ model, total })),
        active: now - g.lastAt < ACTIVE_MS,
      }));

    const burn = this.burn(now, cfg.burnWindowMinutes, win ? win.start : 0);
    const session = { source: five ? 'statusline' : est ? 'estimate' : null, start: win ? win.start : null, resetsAt: win ? win.end : null, tokens: windowTokens, eta: null };
    if (five) {
      session.usedPercent = five.pct;
      session.asOf = this.limits.at;
      session.eta = this.percentEta(now, five);
    }
    if (week) {
      session.weekPercent = week.pct;
      session.weekResetsAt = week.resetsAt;
    }
    const budget = cfg.sessionTokenBudget;
    if (budget) {
      session.budget = budget;
      session.budgetPercent = win ? Math.min(100, (windowTokens / budget) * 100) : 0;
      if (!session.eta && win) session.eta = this.budgetEta(now, budget, windowTokens, burn.tokensPerMinute, win.end);
    }

    const v = {
      generatedAt: now,
      scanning: this.scanning,
      period: { kind: cfg.usagePeriod, since },
      totals: 'input + output + cache writes (cache reads listed separately)',
      all,
      repos,
      burn,
      session,
    };
    this.cache = { t: now, v };
    return v;
  }

  // ETA to 100% from how fast the real percentage rose over the burn window.
  percentEta(now, five) {
    if (five.pct >= 100) return { basis: 'percent', reached: true };
    const minutes = this.settings.load().burnWindowMinutes;
    const last = this.samples[this.samples.length - 1];
    const old = this.samples.find((s) => s.t >= now - minutes * 60e3 && last && last.t - s.t >= 2 * 60e3);
    if (!last || !old) return { basis: 'percent', pending: true };
    const rate = (last.pct - old.pct) / (last.t - old.t);
    if (!(rate > 0)) return { basis: 'percent', beforeReset: false, flat: true };
    const at = last.t + (100 - last.pct) / rate;
    return at >= five.resetsAt ? { basis: 'percent', beforeReset: false } : { basis: 'percent', at, beforeReset: true };
  }

  // ETA against the user's own token budget for the window, at the current burn rate.
  budgetEta(now, budget, used, perMinute, end) {
    if (used >= budget) return { basis: 'budget', reached: true };
    if (!(perMinute > 0)) return { basis: 'budget', beforeReset: false, flat: true };
    const at = now + ((budget - used) / perMinute) * 60e3;
    return at >= end ? { basis: 'budget', beforeReset: false } : { basis: 'budget', at, beforeReset: true };
  }
}

module.exports = { Usage, parseLine, headline };
