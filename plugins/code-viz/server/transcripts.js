'use strict';
// Follows Claude Code session transcripts (~/.claude/projects/<project>/<session>.jsonl, plus
// <session>/subagents/*.jsonl for subagents) and hands every new line to a callback.
//
// A transcript is found three ways: the path in every hook payload, a recursive watch of the
// projects folder, and a scan at startup for sessions active in the last half hour (so a
// restarted server picks up the session it was restarted from). The first read of a file
// covers only its tail, marked as backlog so the viewer can show recent history without
// animating it as if it were happening now.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { StringDecoder } = require('string_decoder');

const ROOT = process.env.CODE_VIZ_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const BACKLOG_BYTES = 384 * 1024;
const RECENT_MS = 30 * 60e3;
const DROP_MS = 90 * 60e3;
const CHUNK = 4 * 1024 * 1024;

class Transcripts {
  constructor({ onEntry, onFile, log }) {
    this.onEntry = onEntry;
    this.onFile = onFile || null;
    this.log = log || (() => {});
    this.tails = new Map();
    this.watcher = null;
  }

  start() {
    this.scan();
    try {
      this.watcher = fs.watch(ROOT, { recursive: true, persistent: false }, (ev, name) => {
        if (!name || !String(name).endsWith('.jsonl')) return;
        const file = path.join(ROOT, String(name));
        if (this.onFile) this.onFile(file);
        const t = this.tails.get(file);
        if (t) this.read(t);
        else this.follow(file, { recentOnly: true });
      });
      this.watcher.on('error', (e) => {
        this.log('transcript watch error', e.message);
        this.watcher = null;
      });
    } catch (e) {
      this.log('transcript watch unavailable', e.message);
    }
    // Watch events can be coalesced or missed; a size check once a second catches up.
    setInterval(() => this.poll(), 1000).unref();
  }

  scan() {
    let dirs;
    try { dirs = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return; }
    const cutoff = Date.now() - RECENT_MS;
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(ROOT, d.name);
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const file = path.join(dir, n);
        try { if (fs.statSync(file).mtimeMs >= cutoff) this.follow(file); } catch {}
      }
    }
  }

  // Start following a transcript (or read what is new in one already followed). With
  // `recentOnly`, a file untouched for half an hour is left alone: an old session being
  // resumed will announce itself through its hooks.
  follow(file, opts) {
    if (!file || !String(file).endsWith('.jsonl')) return null;
    file = path.resolve(file);
    let t = this.tails.get(file);
    if (t) {
      this.read(t);
      return t;
    }
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    if (opts && opts.recentOnly && Date.now() - st.mtimeMs > RECENT_MS) return null;
    const agent = file.includes(`${path.sep}subagents${path.sep}`) ? path.basename(file, '.jsonl') : '';
    const session = agent ? path.basename(path.dirname(path.dirname(file))) : path.basename(file, '.jsonl');
    const start = Math.max(0, st.size - BACKLOG_BYTES);
    t = {
      file,
      pos: start,
      rest: '',
      skipPartial: start > 0,
      decoder: new StringDecoder('utf8'),
      ctx: { session, agent, backlog: true },
      at: Date.now(),
      reading: false,
    };
    this.tails.set(file, t);
    this.read(t);
    t.ctx.backlog = false;
    this.log('following', agent ? `subagent ${agent} of` : 'session', session);
    return t;
  }

  poll() {
    const now = Date.now();
    for (const t of this.tails.values()) {
      let st;
      try { st = fs.statSync(t.file); } catch {
        this.tails.delete(t.file);
        continue;
      }
      if (st.size !== t.pos) this.read(t);
      else if (now - t.at > DROP_MS) this.tails.delete(t.file);
    }
  }

  read(t) {
    if (t.reading) return;
    t.reading = true;
    let fd = null;
    try {
      fd = fs.openSync(t.file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size < t.pos) {
        // Rewritten or truncated: start over from its tail.
        t.pos = Math.max(0, size - BACKLOG_BYTES);
        t.rest = '';
        t.skipPartial = t.pos > 0;
        t.decoder = new StringDecoder('utf8');
      }
      while (t.pos < size) {
        const len = Math.min(CHUNK, size - t.pos);
        const buf = Buffer.allocUnsafe(len);
        const n = fs.readSync(fd, buf, 0, len, t.pos);
        if (n <= 0) break;
        t.pos += n;
        t.at = Date.now();
        const text = t.rest + t.decoder.write(buf.subarray(0, n));
        const lines = text.split('\n');
        t.rest = lines.pop();
        for (let i = 0; i < lines.length; i++) {
          if (t.skipPartial) {
            t.skipPartial = false;
            continue;
          }
          const line = lines[i];
          if (!line) continue;
          let j;
          try { j = JSON.parse(line); } catch { continue; }
          try { this.onEntry(j, t.ctx); } catch (e) { this.log('transcript entry error', e.stack); }
        }
      }
    } catch (e) {
      this.log('transcript read error', path.basename(t.file), e.message);
    } finally {
      if (fd != null) try { fs.closeSync(fd); } catch {}
      t.reading = false;
    }
  }
}

module.exports = { Transcripts };
