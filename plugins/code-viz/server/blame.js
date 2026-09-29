'use strict';
// Line authorship. `git blame` maps each line to the commit that last changed it, with the
// author's name and email from git; that needs no network and no sign-in. When the user's `gh`
// CLI is signed in and the repo is on GitHub, commit authors are also resolved to GitHub people
// (login, profile name, avatar) and the pull request that merged the commit. Credentials stay
// with `gh`: this file only runs `gh api` and never reads, logs or stores a token.
// Uncommitted lines are credited to Claude when Claude wrote them, otherwise to the local
// git user.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { splitLines, diffLines, INS } = require('./viewer/diff');

const ZERO = '0000000000000000000000000000000000000000';
const SHA = /^[0-9a-f]{40}$/;
const CLAUDE = { key: 'claude', name: 'Claude', claude: true };
const GH_BATCH = 40;
const MAX_TEXT = 2 * 1024 * 1024;

function run(cmd, args, { cwd, input, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
    let child;
    try {
      child = execFile(cmd, args, { cwd, env, timeout, maxBuffer: 128 * 1024 * 1024 }, (err, stdout, stderr) =>
        resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
      );
    } catch (e) {
      return resolve({ ok: false, code: e.code, stdout: '', stderr: e.message });
    }
    child.on('error', () => {});
    if (input != null) child.stdin.end(input);
  });
}

function githubRepo(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url || '');
  return m ? { owner: m[1], name: m[2] } : null;
}

function noreplyLogin(email) {
  const m = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email || '');
  return m ? m[1] : null;
}

function isClaudeTrailer(name, email) {
  return /\bclaude\b/i.test(name || '') || /@anthropic\.com$/i.test(email || '');
}

// git blame --porcelain: a header per line ("<sha> <orig> <final> [<count>]"), commit fields
// the first time a commit appears, then the line itself prefixed with a tab.
function parsePorcelain(out) {
  const lines = [];
  const commits = {};
  let cur = null;
  for (const row of out.split('\n')) {
    if (!row) continue;
    if (row[0] === '\t') {
      lines.push(cur);
      continue;
    }
    const head = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(row);
    if (head) {
      cur = head[1];
      if (!commits[cur]) commits[cur] = { sha: cur };
      continue;
    }
    const sp = row.indexOf(' ');
    const key = sp < 0 ? row : row.slice(0, sp);
    const val = sp < 0 ? '' : row.slice(sp + 1);
    const c = commits[cur];
    if (!c) continue;
    if (key === 'author') c.author = val;
    else if (key === 'author-mail') c.email = val.replace(/^<|>$/g, '');
    else if (key === 'author-time') c.time = Number(val) * 1000;
    else if (key === 'summary') c.summary = val;
  }
  return { lines, commits };
}

class Blamer {
  constructor({ home, log, github }) {
    this.log = log || (() => {});
    // Whether GitHub lookups are allowed (the "github" setting); read on every check.
    this.githubAllowed = typeof github === 'function' ? github : () => github !== false;
    this.cacheFile = path.join(home, 'github-cache.json');
    this.claudeFile = path.join(home, 'claude-lines.json');
    this.repos = new Map();
    this.results = new Map();
    this.gh = null;
    this.ghChecking = null;
    this.ghRepoErrors = new Map();
    this.cache = this.load(this.cacheFile, { commits: {}, emails: {} });
    this.claudeLines = new Map(Object.entries(this.load(this.claudeFile, {})).map(([f, arr]) => [f, new Set(arr)]));
    this.saveTimer = null;
  }

  load(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache));
        const lines = {};
        for (const [f, set] of [...this.claudeLines].slice(-200)) lines[f] = [...set].slice(-5000);
        fs.writeFileSync(this.claudeFile, JSON.stringify(lines));
      } catch (e) {
        this.log('blame cache save failed', e.message);
      }
    }, 1000);
    this.saveTimer.unref();
  }

  // Remember the lines Claude added, so uncommitted lines can be credited correctly.
  noteClaudeEdit(file, before, after) {
    const b = splitLines(after || '');
    let set = this.claudeLines.get(file);
    if (!set) this.claudeLines.set(file, (set = new Set()));
    for (const o of diffLines(splitLines(before || ''), b)) if (o.t === INS && b[o.b].trim()) set.add(b[o.b]);
    this.results.delete(file);
    this.save();
  }

  async repoFor(file) {
    const dir = path.dirname(file);
    const hit = this.repos.get(dir);
    if (hit && Date.now() - hit.t < 30000) return hit.repo;
    let repo = null;
    const top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
    if (top.ok) {
      const root = top.stdout.trim();
      const [head, remote, name, email] = await Promise.all([
        run('git', ['-C', root, 'rev-parse', '--verify', '-q', 'HEAD']),
        run('git', ['-C', root, 'remote', 'get-url', 'origin']),
        run('git', ['-C', root, 'config', 'user.name']),
        run('git', ['-C', root, 'config', 'user.email']),
      ]);
      repo = {
        top: root,
        head: head.ok ? head.stdout.trim() : null,
        github: githubRepo(remote.stdout.trim()),
        me: { name: name.stdout.trim() || 'You', email: email.stdout.trim().toLowerCase() },
      };
    }
    this.repos.set(dir, { t: Date.now(), repo });
    return repo;
  }

  // Signed-in GitHub account from the gh CLI. Checked at most every 10 minutes while signed
  // in, and every 30 seconds while not, so signing in with `gh auth login` shows up quickly.
  async github() {
    if (!this.githubAllowed()) return (this.gh = { t: Date.now(), ok: false, disabled: true });
    if (this.gh && !this.gh.disabled && Date.now() - this.gh.t < (this.gh.ok ? 10 * 60e3 : 30e3)) return this.gh;
    if (!this.ghChecking) {
      this.ghChecking = (async () => {
        const r = await run('gh', ['api', 'user'], { timeout: 10000 });
        let status = { t: Date.now(), ok: false, missing: r.code === 'ENOENT' };
        if (r.ok) {
          try {
            const u = JSON.parse(r.stdout);
            status = { t: Date.now(), ok: true, login: u.login, name: u.name || u.login, avatar: u.avatar_url, url: u.html_url };
          } catch {}
        }
        this.gh = status;
        this.ghChecking = null;
        return status;
      })();
    }
    return this.ghChecking;
  }

  // null while the first check (or a re-check after the "github" setting changed) is running.
  githubStatus() {
    const current = () => this.gh && !!this.gh.disabled === !this.githubAllowed();
    if (!current() || Date.now() - this.gh.t > (this.gh.ok ? 10 * 60e3 : 30e3)) this.github();
    if (!current()) return null;
    return { ok: this.gh.ok, login: this.gh.login || null, disabled: !!this.gh.disabled, missing: !!this.gh.missing };
  }

  // Resolve commits to GitHub users and pull requests with batched GraphQL queries.
  async enrich(gh, shas) {
    const key = `${gh.owner}/${gh.name}`;
    const err = this.ghRepoErrors.get(key);
    if (err && Date.now() - err < 10 * 60e3) return;
    const now = Date.now();
    const need = shas.filter((s) => {
      const c = this.cache.commits[s];
      return SHA.test(s) && (!c || (c.missing && now - c.t > 10 * 60e3));
    });
    for (let i = 0; i < need.length; i += GH_BATCH) {
      const batch = need.slice(i, i + GH_BATCH);
      const fields = batch
        .map((s, j) => `c${j}: object(oid: "${s}") { ... on Commit { url author { user { login name avatarUrl url } } associatedPullRequests(first: 1) { nodes { number title url } } } }`)
        .join('\n');
      const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
      const r = await run('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${gh.owner}`, '-f', `name=${gh.name}`]);
      let data = null;
      try { data = JSON.parse(r.stdout).data; } catch {}
      if (!data || !data.repository) {
        this.ghRepoErrors.set(key, Date.now());
        this.log('github lookup failed for', key, (r.stderr || '').trim().slice(0, 200));
        return;
      }
      batch.forEach((s, j) => {
        const c = data.repository[`c${j}`];
        if (!c) {
          this.cache.commits[s] = { missing: true, t: now };
          return;
        }
        const u = c.author && c.author.user;
        const pr = c.associatedPullRequests && c.associatedPullRequests.nodes && c.associatedPullRequests.nodes[0];
        this.cache.commits[s] = {
          url: c.url,
          user: u ? { login: u.login, name: u.name || u.login, avatar: u.avatarUrl, url: u.url } : null,
          pr: pr ? { number: pr.number, title: pr.title, url: pr.url } : null,
        };
      });
      this.save();
    }
  }

  async coauthors(top, shas) {
    const out = {};
    const real = shas.filter((s) => SHA.test(s) && s !== ZERO);
    if (!real.length) return out;
    const r = await run('git', ['-C', top, 'log', '--no-walk=unsorted', '--format=%H%x1f%B%x1e', ...real]);
    if (!r.ok) return out;
    for (const rec of r.stdout.split('\x1e')) {
      const [sha, body] = rec.trim().split('\x1f');
      if (!sha || !body) continue;
      const list = [];
      const re = /^co-authored-by:\s*(.+?)\s*<([^>]*)>\s*$/gim;
      let m;
      while ((m = re.exec(body))) list.push({ name: m[1], email: m[2] });
      out[sha] = list;
    }
    return out;
  }

  async blame(file, text) {
    const repo = await this.repoFor(file);
    if (!repo) return { file, repo: null };
    if (text == null || text.length > MAX_TEXT) return { file, repo: { top: repo.top, name: path.basename(repo.top) }, text, lines: null };
    const cached = this.results.get(file);
    if (cached && cached.text === text && cached.head === repo.head && Date.now() - cached.t < 5 * 60e3) return cached.result;

    const rel = path.relative(repo.top, file);
    const args = ['-C', repo.top, 'blame', '--porcelain', '-w', '-M'];
    const ignore = path.join(repo.top, '.git-blame-ignore-revs');
    if (fs.existsSync(ignore)) args.push('--ignore-revs-file', ignore);
    // Blame exactly the text the viewer shows, not whatever is on disk a moment later.
    args.push('--contents', '-', '--', rel);
    const r = repo.head ? await run('git', args, { input: text }) : { ok: false };
    const count = splitLines(text).length;
    const parsed = r.ok ? parsePorcelain(r.stdout) : { lines: new Array(count).fill(ZERO), commits: { [ZERO]: { sha: ZERO } } };
    if (parsed.lines.length !== count) return { file, repo: { top: repo.top }, text, lines: null, error: 'line count mismatch' };

    const shas = Object.keys(parsed.commits).filter((s) => s !== ZERO);
    const gh = repo.github ? await this.github() : null;
    const canAsk = !!(gh && gh.ok && repo.github);
    const [trailers] = await Promise.all([
      this.coauthors(repo.top, shas),
      canAsk ? Promise.race([this.enrich(repo.github, shas), new Promise((res) => setTimeout(res, 5000))]) : null,
    ]);
    const failedAt = repo.github && this.ghRepoErrors.get(`${repo.github.owner}/${repo.github.name}`);
    const ghOk = canAsk && !(failedAt && Date.now() - failedAt < 10 * 60e3);

    // Learn email -> GitHub login so unpushed commits and uncommitted lines by the same
    // person still resolve to their GitHub identity.
    for (const s of shas) {
      const c = parsed.commits[s];
      const g = this.cache.commits[s];
      if (g && g.user && c.email) this.cache.emails[c.email.toLowerCase()] = g.user;
    }

    const people = [];
    const index = new Map();
    const person = (p) => {
      if (!index.has(p.key)) {
        index.set(p.key, people.length);
        people.push(p);
      }
      return index.get(p.key);
    };
    const identity = (name, email, ghUser) => {
      const lower = (email || '').toLowerCase();
      const user = ghUser || this.cache.emails[lower] || null;
      const login = (user && user.login) || noreplyLogin(lower);
      if (login) return { key: 'gh:' + login.toLowerCase(), name: (user && user.name) || name || login, login, avatar: user && user.avatar, url: (user && user.url) || `https://github.com/${login}` };
      if (lower) return { key: 'em:' + lower, name: name || lower, email: lower };
      return { key: 'nm:' + (name || 'unknown'), name: name || 'Unknown' };
    };

    const commits = [];
    const commitIndex = new Map();
    for (const s of shas) {
      const c = parsed.commits[s];
      const g = this.cache.commits[s] || {};
      const co = trailers[s] || [];
      const who = identity(c.author, c.email, g.user);
      commitIndex.set(s, commits.length);
      commits.push({
        sha: s,
        summary: c.summary || '',
        time: c.time || 0,
        author: c.author || '',
        person: person(who),
        claude: co.some((x) => isClaudeTrailer(x.name, x.email)),
        coauthors: co.map((x) => x.name),
        url: g.url || (repo.github ? `https://github.com/${repo.github.owner}/${repo.github.name}/commit/${s}` : null),
        pr: g.pr || null,
      });
    }

    const me = { ...identity(repo.me.name, repo.me.email, null), me: true };
    const claudeSet = this.claudeLines.get(file);
    const textLines = splitLines(text);
    const lines = parsed.lines.map((s, i) => {
      if (s !== ZERO) {
        const ci = commitIndex.get(s);
        return [commits[ci].person, ci];
      }
      const byClaude = claudeSet && claudeSet.has(textLines[i]);
      return [person(byClaude ? CLAUDE : me), -1];
    });
    // Blank uncommitted lines belong to the code next to them (the next non-blank line in the
    // same uncommitted run, else the previous one).
    for (let i = 0; i < lines.length; i++) {
      if (lines[i][1] !== -1 || textLines[i].trim()) continue;
      let j = i + 1;
      while (j < lines.length && lines[j][1] === -1 && !textLines[j].trim()) j++;
      if (j < lines.length && lines[j][1] === -1) lines[i] = [lines[j][0], -1];
      else if (i > 0 && lines[i - 1][1] === -1) lines[i] = [lines[i - 1][0], -1];
    }

    const result = {
      file,
      text,
      repo: {
        top: repo.top,
        name: path.basename(repo.top),
        github: repo.github ? `${repo.github.owner}/${repo.github.name}` : null,
        ghLogin: gh && gh.ok ? gh.login : null,
        ghOk,
      },
      people,
      commits,
      lines,
    };
    this.results.set(file, { text, head: repo.head, t: Date.now(), result });
    if (this.results.size > 100) this.results.delete(this.results.keys().next().value);
    this.save();
    return result;
  }
}

module.exports = { Blamer, parsePorcelain, githubRepo, CLAUDE };
