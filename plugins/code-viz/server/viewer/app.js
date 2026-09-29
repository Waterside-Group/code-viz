/* Code Viz viewer: shows the file Claude is editing and animates every change. */
(() => {
  'use strict';

  const D = window.CVDiff;
  const { EQ, DEL } = D;
  const $ = (id) => document.getElementById(id);
  const ui = {
    code: $('code'),
    rows: $('rows'),
    empty: $('empty'),
    banner: $('banner'),
    bannerText: $('banner-text'),
    bannerBtn: $('banner-btn'),
    ficon: $('ficon'),
    fname: $('fname'),
    fpath: $('fpath'),
    stats: $('stats'),
    status: $('status'),
    statusText: $('status-text'),
    tabs: $('tabs'),
    timeline: $('timeline'),
    replay: $('replay'),
    speed: $('speed'),
    follow: $('follow'),
    wrap: $('wrap'),
    authors: $('authors'),
    people: $('people'),
    pbar: $('pbar'),
    pchips: $('pchips'),
    psrc: $('psrc'),
    card: $('author-card'),
    focusStyle: $('focus-style'),
    chkGh: $('chk-gh'),
    ghState: $('gh-state'),
    mode: $('mode'),
    marks: $('marks'),
    demo: $('demo'),
    chkConn: $('chk-conn'),
    chkLive: $('chk-live'),
    liveState: $('live-state'),
    liveHint: $('live-hint'),
    chkAct: $('chk-act'),
    actState: $('act-state'),
    feed: $('feed'),
    flist: $('flist'),
    flive: $('flive'),
    fjump: $('fjump'),
    fcount: $('fcount'),
    now: $('now'),
  };

  // ---------------------------------------------------------------------------
  // Preferences and small helpers

  const prefs = {
    get(k, d) {
      try {
        const v = localStorage.getItem('codeviz:' + k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try { localStorage.setItem('codeviz:' + k, JSON.stringify(v)); } catch {}
    },
  };
  // Defaults come from the Code Viz config file (served as /__cv/config.js); a choice made
  // with the footer buttons is remembered in this browser and wins over them.
  const CFG = window.CODE_VIZ_CONFIG || {};
  if (CFG.theme === 'light' || CFG.theme === 'dark') document.documentElement.dataset.theme = CFG.theme;
  let speed = prefs.get('speed', [0.5, 1, 2, 4].includes(CFG.speed) ? CFG.speed : 1);
  let follow = prefs.get('follow', CFG.follow !== false);
  let wrap = prefs.get('wrap', CFG.wrap !== false);
  let authorsOn = prefs.get('authors', CFG.authors !== false);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => (document.hidden ? setTimeout(r, 50) : requestAnimationFrame(r)));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const patch = (r, p) => Object.assign({}, r, p, { _k: undefined });
  const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
  const dirname = (p) => (p.lastIndexOf('/') > 0 ? p.slice(0, p.lastIndexOf('/')) : '');
  const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ESC[c]);

  // ---------------------------------------------------------------------------
  // Syntax highlighting (highlight.js when it loaded, plain text otherwise)

  const LANG = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    mts: 'typescript', cts: 'typescript', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
    kts: 'kotlin', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', m: 'objectivec',
    cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', jsonc: 'json', yml: 'yaml',
    yaml: 'yaml', toml: 'ini', ini: 'ini', md: 'markdown', mdx: 'markdown', html: 'xml', htm: 'xml', xml: 'xml',
    svg: 'xml', vue: 'xml', svelte: 'xml', css: 'css', scss: 'scss', less: 'less', sql: 'sql', lua: 'lua', r: 'r',
    pl: 'perl', graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff', mk: 'makefile',
  };
  function langOf(file) {
    if (!window.hljs) return null;
    const name = basename(file).toLowerCase();
    const lang = name === 'makefile' ? 'makefile' : LANG[name.includes('.') ? name.split('.').pop() : ''];
    return lang && hljs.getLanguage(lang) ? lang : null;
  }
  function extLabel(file) {
    const name = basename(file);
    const ext = name.includes('.') ? name.split('.').pop() : '';
    return ext && ext.length <= 4 ? ext.toUpperCase() : '{ }';
  }

  const hlCache = new Map();
  function hlLine(text, lang) {
    if (!lang || !text) return esc(text);
    const key = lang + '\u0000' + text;
    let html = hlCache.get(key);
    if (html === undefined) {
      try { html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch { html = esc(text); }
      if (hlCache.size > 8000) hlCache.clear();
      hlCache.set(key, html);
    }
    return html;
  }

  // Highlight a whole file (so multi-line comments and strings are right), then split the
  // output into per-line HTML with balanced spans.
  function hlFile(text, lang, lines) {
    lines = lines || D.splitLines(text);
    if (!lang || text.length > 300000) return lines.map(esc);
    let html;
    try { html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch { return lines.map(esc); }
    const out = [];
    const stack = [];
    let cur = '';
    let last = 0;
    const tokens = /<span[^>]*>|<\/span>|\n/g;
    let m;
    while ((m = tokens.exec(html))) {
      cur += html.slice(last, m.index);
      last = tokens.lastIndex;
      if (m[0] === '\n') {
        out.push(cur + '</span>'.repeat(stack.length));
        cur = stack.join('');
      } else if (m[0] === '</span>') {
        stack.pop();
        cur += m[0];
      } else {
        stack.push(m[0]);
        cur += m[0];
      }
    }
    out.push(cur + html.slice(last));
    if (out.length > lines.length) out.length = lines.length;
    return out.length === lines.length ? out : lines.map((t) => hlLine(t, lang));
  }
  function hlFileCached(f) {
    if (!f._hl || f._hl.text !== f.text) f._hl = { text: f.text, html: hlFile(f.text, f.lang) };
    return f._hl.html;
  }

  // Wrap character ranges of highlighted HTML in <i class> marks and insert a caret, keeping
  // tags balanced (marks are closed before every tag and reopened lazily after it).
  const CARET = '<span class="caret"></span>';
  function decorate(html, marks, caret) {
    let out = '';
    let pos = 0;
    let open = '';
    for (let i = 0; i < html.length; ) {
      const ch = html[i];
      if (ch === '<') {
        const j = html.indexOf('>', i) + 1 || html.length;
        if (open) {
          out += '</i>';
          open = '';
        }
        out += html.slice(i, j);
        i = j;
        continue;
      }
      let unit = ch;
      if (ch === '&') {
        const j = html.indexOf(';', i) + 1 || i + 1;
        unit = html.slice(i, j);
        i = j;
      } else i++;
      if (pos === caret) {
        if (open) {
          out += '</i>';
          open = '';
        }
        out += CARET;
      }
      let cls = '';
      for (const mk of marks) if (pos >= mk.from && pos < mk.to) cls = cls ? cls + ' ' + mk.cls : mk.cls;
      if (cls !== open) {
        if (open) out += '</i>';
        if (cls) out += '<i class="' + cls + '">';
        open = cls;
      }
      out += unit;
      pos++;
    }
    if (open) out += '</i>';
    if (caret >= pos) out += CARET;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Authorship: who last changed each line (git blame, with GitHub identities)

  const CLAUDE_KEY = 'claude';
  const people = new Map([[CLAUDE_KEY, { key: CLAUDE_KEY, name: 'Claude', claude: true }]]);
  const commitsById = new Map();
  const HUES = [212, 276, 186, 322, 48, 250, 158, 298, 96, 200];
  function hueOf(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return HUES[h % HUES.length];
  }
  const personOf = (key) => people.get(key) || { key, name: key.replace(/^\w+:/, '') };
  const initials = (name) => name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  const firstName = (name) => name.split(/\s+/)[0];
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
  // When a line was committed: the date and the time, never a relative age.
  const DATE_FMT = { month: 'short', day: 'numeric', year: 'numeric' };
  const when = (t) => new Date(t).toLocaleDateString([], DATE_FMT) + ' · ' + new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const whenShort = (t) => new Date(t).toLocaleDateString([], DATE_FMT);
  const STAR = '<svg viewBox="0 0 16 16"><path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" fill="currentColor"/></svg>';
  function avatar(p, px) {
    if (p.claude) return '<b class="av cl" aria-hidden="true">' + STAR + '</b>';
    const src = safeUrl(p.avatar);
    if (src) return '<img class="av" src="' + esc(src + (src.includes('?') ? '&' : '?') + 's=' + (px || 48)) + '" alt="" loading="lazy" referrerpolicy="no-referrer">';
    return '<b class="av" aria-hidden="true">' + esc(initials(p.name)) + '</b>';
  }
  const tint = (p) => (p.claude ? '' : ' style="--ph:' + hueOf(p.key) + '"');
  // The first line of each run of a person's lines carries their label. A run of two or more
  // lines gets the tall label (a larger photo, the name, and the commit date and time below
  // it), drawn over the gutter of the run's second line; a one-line run gets a single line.
  function authorCell(r, span) {
    if (!authorsOn) return '';
    if (!r.au) return '<span class="au none"></span>';
    const p = personOf(r.au);
    const cls = 'au' + (p.claude ? ' cl' : '') + (r.aw ? ' w' : '') + (r.ac ? '' : ' uc');
    if (!span) return '<span class="' + cls + '"' + tint(p) + '></span>';
    const c = r.ac ? commitsById.get(r.ac) : null;
    const tall = span > 1;
    const date = r.aw ? 'Writing now' : c ? when(c.time) : 'Not committed yet';
    const short = r.aw ? 'Writing now' : c ? whenShort(c.time) : 'Not committed';
    return (
      '<span class="' + cls + ' st' + (tall ? ' tall' : '') + '"' + tint(p) + ' title="' + esc(p.name + ' · ' + date) + '"><span class="lab">' +
      avatar(p, tall ? 64 : 40) +
      '<span class="nm"><b><span class="full">' + esc(p.name) + '</span><span class="first">' + esc(firstName(p.name)) + '</span>' +
      (c && c.claude ? '<i class="co" title="Co-authored with Claude"></i>' : '') + '</b>' +
      '<em><span class="long">' + esc(tall ? date : short) + '</span><span class="brief">' + esc(short) + '</span></em></span></span></span>'
    );
  }
  // Length of each run of lines by the same person, at the run's first line (0 elsewhere).
  function runStarts(rows) {
    const out = new Array(rows.length).fill(0);
    let prev = null;
    let start = -1;
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i].au ? rows[i].au + (rows[i].aw ? '*' : '') : null;
      if (a && a !== prev) out[(start = i)] = 1;
      else if (a && start >= 0) out[start]++;
      prev = a;
    }
    return out;
  }
  const spanKey = (n) => (n ? (n > 1 ? '^t' : '^') : '');

  // Size the author column to the longest name in the file, so names never truncate.
  const SANS = getComputedStyle(document.documentElement).getPropertyValue('--sans') || 'sans-serif';
  const measure = document.createElement('canvas').getContext('2d');
  const textWidth = (s, font) => {
    measure.font = font + ' ' + SANS;
    return measure.measureText(s).width;
  };
  function fitAuthors(keys) {
    let name = 0;
    for (const k of keys) name = Math.max(name, textWidth(personOf(k).name, '600 12.5px'));
    const dateW = textWidth(when(Date.UTC(2026, 11, 28, 23, 58)), '11px');
    const tall = 12 + 28 + 9 + Math.max(name, dateW) + 12;
    const single = 12 + 18 + 7 + name + 7 + textWidth('Dec 28, 2026', '11px') + 12;
    ui.code.style.setProperty('--au-fit', Math.ceil(clamp(Math.max(tall, single), 176, 340)) + 'px');
  }
  const blameLines = (f, text) => (authorsOn && f.blame && f.blame.text === text ? f.blame.lines : null);
  const byClaude = { p: CLAUDE_KEY, c: '' };

  // ---------------------------------------------------------------------------
  // Rows and rendering
  //
  // A row: { k: 'ctx'|'add'|'del'|'mod'|'pend', t: text, h?: precomputed html,
  //          m?: [{from, to, cls}] marks, c?: caret column, r?: recent-change kind,
  //          x?: lines were deleted here, f?: flash as freshly changed, cl?: collapsing }

  const view = { rows: [], keys: [], els: [], lang: null };

  function rowKey(r) {
    if (r._k) return r._k;
    let k = r.k + (r.r ? '.' + r.r : '') + (r.x ? '.x' : '') + (r.f ? '.f' : '') + (r.cl ? '.c' : '') + '|' + (r.c == null ? '' : r.c) + '|';
    if (r.m) for (const m of r.m) k += m.from + '-' + m.to + m.cls + ',';
    k += '|' + (r.au ? r.au + (r.aw ? '*' : '') + '@' + (r.ac || '') : '') + (authorsOn ? 'A' : '');
    k += '|' + (r.h != null ? '\u0001' + r.h : r.t);
    r._k = k;
    return k;
  }
  function rowClass(r) {
    return 'row ' + r.k + (r.r ? ' rc-' + r.r : '') + (r.x ? ' dx' : '') + (r.f ? ' fresh' : '') + (r.cl ? ' collapse' : '');
  }
  function rowInner(r, start) {
    let h = r.h != null ? r.h : hlLine(r.t, view.lang);
    if ((r.m && r.m.length) || r.c != null) h = decorate(h, r.m || [], r.c == null ? -1 : r.c);
    return '<div class="in">' + authorCell(r, start) + '<span class="ln"></span><span class="tx">' + h + '</span></div>';
  }
  function paint(e, r, start) {
    e.className = rowClass(r);
    e.dataset.p = r.au || '';
    e.innerHTML = rowInner(r, start);
  }

  // Reconcile the DOM with a new row list, touching only rows between the common prefix and
  // suffix. Newly inserted rows slide in.
  function render(rows, opts) {
    const st = runStarts(rows);
    const keys = rows.map((r, i) => rowKey(r) + spanKey(st[i]));
    const old = view.keys;
    const oldEls = view.els;
    const n0 = old.length;
    const n1 = keys.length;
    let p = 0;
    while (p < n0 && p < n1 && old[p] === keys[p]) p++;
    let s = 0;
    while (s < n0 - p && s < n1 - p && old[n0 - 1 - s] === keys[n1 - 1 - s]) s++;
    const midOld = n0 - p - s;
    const midNew = n1 - p - s;
    const common = Math.min(midOld, midNew);
    const els = oldEls.slice(0, p);
    for (let i = 0; i < common; i++) {
      const e = oldEls[p + i];
      paint(e, rows[p + i], st[p + i]);
      els.push(e);
    }
    for (let i = common; i < midOld; i++) oldEls[p + i].remove();
    if (midNew > common) {
      const frag = document.createDocumentFragment();
      const added = [];
      for (let i = common; i < midNew; i++) {
        const e = document.createElement('div');
        paint(e, rows[p + i], st[p + i]);
        frag.appendChild(e);
        els.push(e);
        added.push(e);
      }
      ui.rows.insertBefore(frag, s ? oldEls[n0 - s] : null);
      if (!(opts && opts.noEnter) && added.length <= 40 && !document.hidden) {
        for (const e of added) e.classList.add('enter');
        // Rows clip their content only while they grow in (a settled row lets an author
        // label spill over the next line's gutter).
        requestAnimationFrame(() => requestAnimationFrame(() => {
          for (const e of added) {
            e.classList.remove('enter');
            e.classList.add('grow');
          }
          setTimeout(() => { for (const e of added) e.classList.remove('grow'); }, 260);
        }));
      }
    }
    for (let i = n0 - s; i < n0; i++) els.push(oldEls[i]);
    view.rows = rows;
    view.keys = keys;
    view.els = els;
  }

  function renderAll(rows) {
    const st = runStarts(rows);
    let html = '';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      html += '<div class="' + rowClass(r) + '" data-p="' + esc(r.au || '') + '">' + rowInner(r, st[i]) + '</div>';
    }
    ui.rows.innerHTML = html;
    view.els = Array.from(ui.rows.children);
    view.rows = rows;
    view.keys = rows.map((r, i) => rowKey(r) + spanKey(st[i]));
  }

  // Animation frames draw only while their file is the one on screen.
  function draw(job, rows) {
    if (job && job.f && job.f !== current) return;
    render(rows);
  }

  // ---------------------------------------------------------------------------
  // Scroll following

  const LH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lh')) || 20;
  const PAD_TOP = 8;
  let hold = 0;
  let goalY = null;
  let goalX = null;
  const userScrolled = () => {
    hold = performance.now() + 2500;
    goalY = goalX = null;
  };
  for (const ev of ['wheel', 'touchstart', 'mousedown']) ui.code.addEventListener(ev, userScrolled, { passive: true });

  const rowTop = (idx) => (view.els[idx] ? view.els[idx].offsetTop : PAD_TOP + idx * LH);
  const contentBottom = () => {
    const e = view.els[view.els.length - 1];
    return e ? e.offsetTop + e.offsetHeight : PAD_TOP;
  };
  // Never scroll further than needed to keep the last line in the upper 70% of the view, so
  // a file that fits on screen stays put.
  const clampY = (y) => clamp(y, 0, Math.max(0, contentBottom() - ui.code.clientHeight * 0.7));
  function scrollY(y, now) {
    if (now) {
      ui.code.scrollTop = y;
      goalY = null;
    } else goalY = y;
  }
  function scrollX(x, now) {
    if (now) {
      ui.code.scrollLeft = x;
      goalX = null;
    } else goalX = x;
  }

  // Keep the caret (or row idx) comfortably in view.
  function track(job, idx) {
    if (!follow || performance.now() < hold || idx < 0 || (job && job.f && job.f !== current)) return;
    const now = instant(job);
    const e = view.els[idx];
    const c = e && e.querySelector('.caret');
    const vh = ui.code.clientHeight;
    const top = rowTop(idx) + (c ? c.offsetTop : 0);
    const cur = goalY != null ? goalY : ui.code.scrollTop;
    if (top < cur + vh * 0.18 || top > cur + vh * 0.72) scrollY(clampY(top - vh * 0.38), now);
    if (wrap || !c) return;
    // Without wrapping: scroll right only when the caret would be off screen, and come back
    // to the left edge as soon as it fits again.
    const x = c.offsetLeft;
    const vw = ui.code.clientWidth;
    const curX = goalX != null ? goalX : ui.code.scrollLeft;
    const want = x <= vw - 48 ? 0 : Math.max(0, x - vw * 0.55);
    if (x > curX + vw - 48 || x < curX + 72 || (want === 0 && curX > 0)) scrollX(want, now);
  }
  function center(job, idx) {
    if (!follow || performance.now() < hold || (job && job.f && job.f !== current)) return;
    scrollY(clampY(rowTop(idx) - ui.code.clientHeight * 0.38), instant(job));
  }
  (function scrollLoop() {
    if (goalY != null) {
      const cur = ui.code.scrollTop;
      const d = goalY - cur;
      ui.code.scrollTop = Math.abs(d) < 1.5 ? goalY : cur + d * 0.2;
      if (Math.abs(d) < 1.5 || ui.code.scrollTop === cur) goalY = null;
    }
    if (goalX != null) {
      const cur = ui.code.scrollLeft;
      const d = goalX - cur;
      ui.code.scrollLeft = Math.abs(d) < 1.5 ? goalX : cur + d * 0.25;
      if (Math.abs(d) < 1.5 || ui.code.scrollLeft === cur) goalX = null;
    }
    requestAnimationFrame(scrollLoop);
  })();

  // ---------------------------------------------------------------------------
  // Files, header, tabs, minimap

  const files = new Map();
  let current = null;
  let fileSeq = 0;

  function fileState(file, info) {
    let f = files.get(file);
    if (!f) {
      f = { file, rel: file, project: '', text: '', lang: langOf(file), recent: null, scroll: 0, adds: 0, dels: 0, unseen: false, order: ++fileSeq, past: null };
      files.set(file, f);
    }
    if (info && info.rel) f.rel = info.rel;
    if (info && info.project) f.project = info.project;
    return f;
  }

  function committedRows(f, fresh) {
    const lines = D.splitLines(f.text);
    const html = hlFileCached(f);
    const rc = f.recent;
    const bl = blameLines(f, f.text);
    const rows = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const kind = rc ? rc.kinds.get(i) : undefined;
      rows[i] = { k: 'ctx', t: lines[i], h: html[i], r: kind, x: rc ? rc.delAt.has(i) : false, f: fresh && kind ? 1 : 0, au: bl ? bl[i].p : undefined, ac: bl ? bl[i].c : undefined };
    }
    return rows;
  }

  function showFile(f, force) {
    if (current === f && !force) return setView('code');
    const switching = current !== f;
    if (current && switching) current.scroll = ui.code.scrollTop;
    current = f;
    f.unseen = false;
    view.lang = f.lang;
    renderAll(committedRows(f, false));
    if (switching) {
      ui.code.scrollTop = f.scroll || 0;
      ui.code.scrollLeft = 0;
      goalY = goalX = null;
      ui.code.classList.remove('swap');
      void ui.code.offsetWidth;
      ui.code.classList.add('swap');
    }
    ui.empty.hidden = true;
    setView('code');
    updateHeader();
    renderTabs();
    updateMarks();
    updatePeople();
    if (authorsOn && !f.noRepo && !blameLines(f, f.text)) scheduleBlame(f, 60);
  }

  function updateHeader() {
    if (viewMode === 'screen' && shown) return screenHeader();
    if (viewMode === 'feed' && !split) return feedHeader();
    const f = current;
    if (!f) return feedHeader();
    ui.fname.textContent = basename(f.file);
    ui.fpath.textContent = [f.project, dirname(f.rel)].filter(Boolean).join(' · ') || dirname(f.file) || ' ';
    ui.fpath.title = f.file;
    ui.ficon.textContent = extLabel(f.file);
    ui.stats.innerHTML = f.adds || f.dels ? '<span class="a">+' + f.adds + '</span><span class="d">−' + f.dels + '</span>' : '';
    document.title = basename(f.file) + ' · Code Viz';
  }

  function renderTabs() {
    const list = [...files.values()].sort((a, b) => a.order - b.order).slice(-10);
    ui.tabs.textContent = '';
    if (!split) {
      const a = document.createElement('button');
      a.className = 'tab act' + (viewMode === 'feed' ? ' on' : '') + (liveSession() ? ' busy' : '');
      a.title = 'Everything Claude is doing: prompts, thinking and tool calls';
      a.innerHTML = '<span class="pulse" aria-hidden="true"></span><span>Activity</span>';
      a.onclick = () => setView('feed');
      ui.tabs.appendChild(a);
      if (viewMode === 'feed') requestAnimationFrame(() => a.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    }
    if (scr.last) {
      const t = document.createElement('button');
      t.className = 'tab' + (viewMode === 'screen' ? ' on' : '');
      t.title = 'The last terminal or browser screen';
      t.innerHTML = '<span>' + (scr.last.kind === 'terminal' ? 'Terminal' : 'Browser') + '</span>' + (scr.unseen && viewMode !== 'screen' ? '<span class="dot"></span>' : '');
      t.onclick = () => openScreen(scr.last);
      ui.tabs.appendChild(t);
    }
    for (const f of list) {
      const b = document.createElement('button');
      b.className = 'tab' + (f === current && viewMode === 'code' ? ' on' : '');
      b.title = f.rel;
      const name = document.createElement('span');
      name.textContent = basename(f.file);
      b.appendChild(name);
      if (f.unseen) b.insertAdjacentHTML('beforeend', '<span class="dot"></span>');
      b.onclick = () => (f === current ? setView('code') : showFile(f));
      ui.tabs.appendChild(b);
      if (f === current && viewMode === 'code') requestAnimationFrame(() => b.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    }
  }

  function updateMarks() {
    const f = current;
    let html = '';
    if (f && f.recent && f.recent.kinds.size) {
      const total = Math.max(1, view.rows.length);
      let start = -1;
      let prev = -2;
      let kind = '';
      const put = () => {
        if (start >= 0) html += '<i class="' + kind + '" style="top:' + ((start / total) * 100).toFixed(2) + '%;height:max(3px,' + (((prev - start + 1) / total) * 100).toFixed(2) + '%)"></i>';
      };
      for (const [i, k] of f.recent.kinds) {
        if (i === prev + 1 && k === kind) {
          prev = i;
          continue;
        }
        put();
        start = prev = i;
        kind = k;
      }
      put();
    }
    ui.marks.innerHTML = html;
  }

  function recentFrom(oldText, newText) {
    const B = D.splitLines(newText);
    const ops = D.diffLines(D.splitLines(oldText), B);
    const hs = D.hunks(ops);
    const kinds = new Map();
    const delAt = new Set();
    let adds = 0;
    let dels = 0;
    for (const h of hs) {
      const nd = h.a1 - h.a0;
      const na = h.b1 - h.b0;
      adds += na;
      dels += nd;
      for (let j = h.b0; j < h.b1; j++) kinds.set(j, nd ? 'mod' : 'add');
      if (!na && B.length) delAt.add(Math.min(h.b0, B.length - 1));
    }
    return { kinds, delAt, adds, dels, ops };
  }

  // Make `text` the file's settled state, marking what changed relative to `from`.
  function commit(f, text, from, fresh) {
    const old = from == null ? f.text : from;
    const rc = recentFrom(old, text);
    // Carry authorship across the edit right away (unchanged lines keep their author, new
    // lines are Claude's), then confirm against git in the background.
    if (f.blame && f.blame.text === old && old !== text) {
      const next = [];
      for (const o of rc.ops) {
        if (o.t === EQ) next.push(f.blame.lines[o.a]);
        else if (o.t !== DEL) next.push(byClaude);
      }
      f.blame = { text, lines: next };
      f.blameVer = (f.blameVer || 0) + 1;
    }
    if (old !== text) scheduleBlame(f, 1500);
    f.text = text;
    f.recent = rc;
    f.adds = rc.adds;
    f.dels = rc.dels;
    if (current === f) {
      render(committedRows(f, fresh !== false), { noEnter: true });
      updateHeader();
      updateMarks();
      updatePeople();
      if (!wrap && follow && performance.now() >= hold && ui.code.scrollLeft > 0) goalX = 0;
    } else {
      f.unseen = true;
      renderTabs();
    }
  }

  function showBanner(text, withButton) {
    ui.bannerText.textContent = text;
    ui.bannerBtn.hidden = !withButton;
    ui.banner.hidden = false;
  }
  function hideBanner() {
    ui.banner.hidden = true;
  }
  // Leave replay mode for a file: restore its latest known state.
  function clearPast(f) {
    if (f && f.past) {
      const p = f.past;
      f.past = null;
      Object.assign(f, p);
      if (current === f) showFile(f, true);
    }
    hideBanner();
  }

  // ---------------------------------------------------------------------------
  // Status and timeline

  let statusTimer = 0;
  let connected = false;
  function setStatus(kind, text) {
    clearTimeout(statusTimer);
    ui.status.className = 'pill ' + kind;
    ui.statusText.textContent = text;
  }
  function flash(kind, text, ms) {
    setStatus(kind, text);
    flashing = true;
    statusTimer = setTimeout(() => {
      flashing = false;
      if (!running && !queue.length) setIdle();
    }, ms || 1500);
  }
  let flashing = false;
  // Between edits the pill says what Claude is doing, from the activity feed.
  function setIdle() {
    if (!connected) return setStatus('bad', 'Disconnected');
    const s = liveSession();
    if (!s) return setStatus('idle', 'Idle');
    if (s.state === 'thinking') return setStatus('think', 'Thinking');
    if (s.state === 'tool') {
      const it = s.tool && feed.items.get(s.tool);
      return setStatus('live', it && it.meta ? it.meta.label || 'Running a tool' : 'Running a tool');
    }
    setStatus('live', 'Working');
  }

  const edits = [];
  function addTimeline(e) {
    if (edits.some((x) => x.id === e.id)) return;
    edits.push({ id: e.id, file: e.file, tool: e.tool, ts: e.ts });
    if (edits.length > 150) {
      edits.shift();
      if (ui.timeline.firstChild) ui.timeline.firstChild.remove();
    }
    const b = document.createElement('button');
    b.className = 'tick ' + (e.tool === 'Write' ? 'w' : 'e') + (e.demo ? ' demo' : '');
    const size = (e.adds || 0) + (e.dels || 0);
    b.style.setProperty('--h', Math.round(clamp(5 + Math.log2(1 + size) * 2.4, 5, 18)) + 'px');
    b.title = `${e.tool} ${e.rel}\n+${e.adds} −${e.dels} · ${time(e.ts)}${e.demo ? ' · demo' : ''}\nClick to replay`;
    b.setAttribute('aria-label', `Replay ${e.tool} of ${e.rel} at ${time(e.ts)}`);
    b.onclick = () => replay(e.id);
    ui.timeline.appendChild(b);
    ui.timeline.scrollLeft = ui.timeline.scrollWidth;
  }

  function setLive(info) {
    if (!info) return;
    const active = !!info.active;
    ui.mode.className = 'mode' + (active ? ' on' : '');
    ui.mode.textContent = active ? 'Live' : 'Replay';
    ui.mode.title = active
      ? 'Keystroke streaming is on: edits and thinking are drawn while Claude generates them.'
      : 'Each edit is replayed the moment Claude saves it. Terminal sessions can stream it token by token with "code-viz live on"; the desktop app sets its own API address, so it cannot.';
    ui.chkLive.classList.toggle('ok', active);
    ui.liveState.textContent = active ? 'on' : info.configured ? 'on for terminal sessions' : 'off';
  }
  function updateEmpty() {
    ui.chkConn.classList.toggle('ok', connected);
    const n = feed.sessions.size;
    ui.chkAct.classList.toggle('ok', n > 0);
    ui.actState.textContent = n ? `following ${n} session${n === 1 ? '' : 's'}` : 'waiting for a Claude Code session';
    ui.empty.hidden = viewMode === 'screen' ? true : viewMode === 'feed' && !split ? feed.items.size > 0 : !!current;
  }

  // ---------------------------------------------------------------------------
  // Job queue: one animation at a time, sped up when work piles up

  const queue = [];
  let running = null;
  function enqueue(job) {
    queue.push(job);
    pump();
  }
  async function pump() {
    if (running) return;
    while (queue.length) {
      running = queue.shift();
      try {
        await running.run(running);
      } catch (e) {
        console.error('[code-viz]', e);
      }
      running = null;
      lastEditAt = performance.now();
    }
    if (/\b(live|replay|think)\b/.test(ui.status.className)) setIdle();
  }
  let lastEditAt = 0;
  const instant = (job) => document.hidden || !!(job && (job.skip || (job.f && job.f !== current) || (job.sc && (viewMode !== 'screen' || job.sc !== shown || reduceMotion.matches))));
  const rate = () => speed * (queue.length > 1 ? Math.min(6, queue.length) : 1);
  const wait = (ms, job) => (instant(job) ? Promise.resolve() : sleep(ms / rate()));

  async function stepper(job, total, cps, onStep) {
    let n = 0;
    let last = performance.now();
    while (n < total) {
      await frame();
      if (instant(job)) break;
      const now = performance.now();
      n = Math.min(total, n + Math.max(1, Math.round((cps * rate() * (now - last)) / 1000)));
      last = now;
      onStep(n);
    }
    if (n < total) onStep(total);
  }

  // ---------------------------------------------------------------------------
  // Replay animation: turn `fromText` into `toText` hunk by hunk

  function similar(a, b) {
    if (!a.trim() || !b.trim()) return false;
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return p + s >= Math.max(a.length, b.length) * 0.45;
  }

  async function animateTransition(job, f, fromText, toText, markFrom) {
    const A = D.splitLines(fromText);
    const B = D.splitLines(toText);
    const hs = D.hunks(D.diffLines(A, B));
    job.f = f;
    if (!hs.length || instant(job)) return commit(f, toText, markFrom == null ? fromText : markFrom);
    const htmlA = hlFile(fromText, f.lang, A);
    const blA = blameLines(f, fromText);
    let doc = A.map((t, i) => ({ k: 'ctx', t, h: htmlA[i], au: blA ? blA[i].p : undefined, ac: blA ? blA[i].c : undefined }));
    render(doc, { noEnter: true });
    let chars = 0;
    for (const h of hs) for (let j = h.b0; j < h.b1; j++) chars += B[j].length + 1;
    const budget = clamp(500 + chars * 12, 500, 4000);
    const cps = Math.max(40, (chars / budget) * 1000);
    for (let i = 0; i < hs.length && !instant(job); i++) {
      const h = hs[i];
      const dels = A.slice(h.a0, h.a1);
      const adds = B.slice(h.b0, h.b1);
      const pre = doc.slice(0, h.b0);
      const delRowsIn = doc.slice(h.b0, h.b0 + dels.length);
      const post = doc.slice(h.b0 + dels.length);
      center(job, h.b0);
      await wait(i === 0 ? 140 : 220, job);
      const inPlace = dels.length && dels.length === adds.length && dels.length <= 4 && dels.every((d, j) => similar(d, adds[j]));
      if (inPlace) await animInPlace(job, pre, post, delRowsIn, adds, cps);
      else await animBlock(job, pre, post, delRowsIn, adds, cps);
      const kind = dels.length ? 'mod' : 'add';
      doc = pre.concat(adds.map((t) => ({ k: 'ctx', t, r: kind, au: CLAUDE_KEY })), post);
      draw(job, doc);
    }
    commit(f, toText, markFrom == null ? fromText : markFrom);
  }

  // Deleted lines turn red, then the replacement is typed below them, then the red collapses.
  async function animBlock(job, pre, post, delsIn, adds, cps) {
    const delRows = delsIn.map((r) => ({ k: 'del', t: r.t, au: r.au, ac: r.ac }));
    if (delRows.length) {
      draw(job, pre.concat(delRows, post));
      await wait(Math.min(450, 220 + delRows.length * 25), job);
    }
    if (adds.length) {
      const full = adds.join('\n');
      const at = pre.length + delRows.length;
      await stepper(job, full.length, cps, (n) => {
        const cur = full.slice(0, n).split('\n');
        const last = cur.length - 1;
        draw(job, pre.concat(delRows, cur.map((t, i) => (i === last ? { k: 'add', t, c: t.length, au: CLAUDE_KEY, aw: 1 } : { k: 'add', t, au: CLAUDE_KEY, aw: 1 })), post));
        track(job, at + last);
      });
    }
    if (delRows.length && !instant(job)) {
      draw(job, pre.concat(delRows.map((r) => patch(r, { cl: 1 })), adds.map((t) => ({ k: 'add', t, au: CLAUDE_KEY })), post));
      await sleep(230);
    }
  }

  // Small modifications happen inside the line: select the old part, backspace it, type the new.
  async function animInPlace(job, pre, post, delsIn, adds, cps) {
    const done = [];
    const dels = delsIn.map((r) => r.t);
    for (let i = 0; i < dels.length; i++) {
      const d = dels[i];
      const a = adds[i];
      let p = 0;
      while (p < d.length && p < a.length && d[p] === a[p]) p++;
      let s = 0;
      while (s < d.length - p && s < a.length - p && d[d.length - 1 - s] === a[a.length - 1 - s]) s++;
      const head = d.slice(0, p);
      const tail = d.slice(d.length - s);
      const oldMid = d.slice(p, d.length - s);
      const newMid = a.slice(p, a.length - s);
      const rest = delsIn.slice(i + 1);
      const idx = pre.length + done.length;
      const show = (row) => {
        row.au = CLAUDE_KEY;
        row.aw = 1;
        draw(job, pre.concat(done, [row], rest, post));
        track(job, idx);
      };
      if (oldMid) {
        show({ k: 'mod', t: d, m: [{ from: p, to: p + oldMid.length, cls: 'md' }], c: p + oldMid.length });
        await wait(240, job);
        if (oldMid.length > 24) show({ k: 'mod', t: head + tail, c: p });
        else {
          await stepper(job, oldMid.length, cps * 1.8, (n) => {
            const k = oldMid.length - n;
            show({ k: 'mod', t: head + oldMid.slice(0, k) + tail, m: k ? [{ from: p, to: p + k, cls: 'md' }] : null, c: p + k });
          });
        }
        await wait(90, job);
      }
      if (newMid) {
        await stepper(job, newMid.length, cps, (n) => show({ k: 'mod', t: head + newMid.slice(0, n) + tail, m: [{ from: p, to: p + n, cls: 'ma' }], c: p + n }));
      }
      done.push({ k: 'ctx', t: a, r: 'mod', au: CLAUDE_KEY });
      await wait(70, job);
    }
  }

  // ---------------------------------------------------------------------------
  // Live streams: draw Write/Edit tool input while it is being generated

  const streams = new Map();

  // Ease the displayed length toward what has arrived, so bursty token delivery still reads
  // as steady typing.
  function advance(shown, target, dt, job) {
    if (shown >= target || instant(job)) return target;
    const backlog = target - shown;
    return Math.min(target, shown + Math.max(1, Math.ceil(backlog * Math.min(1, (dt * rate()) / 200))));
  }

  function spanRows(lines, a, b, cls, kind, caret) {
    const rows = [];
    let off = 0;
    for (const t of lines) {
      const end = off + t.length;
      const from = Math.max(a, off) - off;
      const to = Math.min(b, end) - off;
      const r = { k: kind, t };
      if (to > from) r.m = [{ from, to, cls }];
      if (caret >= off && caret <= end) r.c = caret - off;
      if (kind === 'add') {
        r.au = CLAUDE_KEY;
        r.aw = 1;
      }
      rows.push(r);
      off = end + 1;
    }
    return rows;
  }

  // Unchanged lines at either edge of a del/add block are shown as plain context instead.
  function trimSame(dels, adds) {
    const lead = [];
    const trail = [];
    const same = (x, y) => x && y && x.t === y.t && !x.m && !y.m;
    while (same(dels[0], adds[0])) {
      const d = dels.shift();
      const a = adds.shift();
      lead.push({ k: 'ctx', t: a.t, c: a.c, au: d.au, ac: d.ac });
    }
    while (same(dels[dels.length - 1], adds[adds.length - 1])) {
      const d = dels.pop();
      const a = adds.pop();
      trail.unshift({ k: 'ctx', t: a.t, c: a.c, au: d.au, ac: d.ac });
    }
    return { lead, trail };
  }

  async function liveEdit(job, s, f, base) {
    const lines = D.splitLines(base);
    const html = hlFile(base, f.lang, lines);
    let baseRows;
    let ver;
    const build = () => {
      const bl = blameLines(f, base);
      baseRows = lines.map((t, i) => ({ k: 'ctx', t, h: html[i], au: bl ? bl[i].p : undefined, ac: bl ? bl[i].c : undefined }));
      ver = f.blameVer;
    };
    build();
    const starts = [0];
    for (let i = 0; i < base.length; i++) if (base.charCodeAt(i) === 10) starts.push(i + 1);
    const lastLine = Math.max(0, lines.length - 1);
    const lineOf = (off) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= off) lo = mid;
        else hi = mid - 1;
      }
      return Math.min(lo, lastLine);
    };
    const lineEnd = (L) => starts[L] + (lines[L] || '').length;

    draw(job, baseRows);
    let shownOld = 0;
    let shownNew = 0;
    let ms = -1;
    let phase = '';
    let t = performance.now();
    const say = (p, text) => {
      if (phase !== p) {
        phase = p;
        setStatus('live', text);
      }
    };
    for (;;) {
      await frame();
      const now = performance.now();
      const dt = now - t;
      t = now;
      if (f.blameVer !== ver) build();
      const old = s.fields.old_string || '';
      const hasNew = s.fields.new_string !== undefined;
      const neu = s.fields.new_string || '';
      shownOld = advance(shownOld, old.length, dt, job);
      if (hasNew && shownOld >= old.length) shownNew = advance(shownNew, neu.length, dt, job);
      const finished = s.aborted || (s.ended && shownOld >= old.length && shownNew >= neu.length);
      const oldShown = old.slice(0, shownOld);
      if (oldShown && (ms < 0 || !base.startsWith(oldShown, ms))) ms = base.indexOf(oldShown);

      if (ms < 0 || !lines.length) {
        say('find', oldShown ? 'Finding the code to change' : 'Claude is editing');
        draw(job, baseRows);
      } else if (!(hasNew && shownOld >= old.length)) {
        // Selecting: highlight the text that is about to be replaced as old_string arrives.
        say('select', 'Selecting code to replace');
        const me = ms + oldShown.length;
        const L0 = lineOf(ms);
        const Lc = lineOf(me);
        const Lz = Math.max(L0, Lc, lineOf(Math.max(ms, me - 1)));
        const mid = [];
        for (let L = L0; L <= Lz; L++) {
          const rs = starts[L];
          const from = Math.max(ms, rs) - rs;
          const to = Math.min(me, lineEnd(L)) - rs;
          mid.push({ k: 'ctx', t: lines[L], h: baseRows[L].h, au: baseRows[L].au, ac: baseRows[L].ac, m: to > from ? [{ from, to, cls: 'sel' }] : null, c: L === Lc ? clamp(me - rs, 0, lines[L].length) : null });
        }
        draw(job, baseRows.slice(0, L0).concat(mid, baseRows.slice(Lz + 1)));
        track(job, Lc);
      } else {
        // Writing: old lines in red, the replacement typed in below them.
        say('write', 'Writing the replacement');
        const me = ms + old.length;
        const L0 = lineOf(ms);
        const Le = lineOf(me);
        const ls = starts[L0];
        const le = Math.max(me, lineEnd(Le));
        const neuShown = neu.slice(0, shownNew);
        let delText = base.slice(ls, le);
        if (delText.endsWith('\n')) delText = delText.slice(0, -1);
        const addText = base.slice(ls, ms) + neuShown + base.slice(me, le);
        const caret = ms - ls + neuShown.length;
        const delRows = spanRows(delText.split('\n'), ms - ls, me - ls, 'md', 'del', -1);
        delRows.forEach((r, j) => {
          const b = baseRows[L0 + j];
          if (b) {
            r.au = b.au;
            r.ac = b.ac;
          }
        });
        const addRows = spanRows(addText.split('\n'), ms - ls, caret, 'ma', 'add', caret);
        if (addText.endsWith('\n') && addRows[addRows.length - 1].c == null) addRows.pop();
        if (!addText && !neuShown) addRows.length = 0;
        const { lead, trail } = trimSame(delRows, addRows);
        const pre = baseRows.slice(0, L0).concat(lead);
        const block = pre.concat(delRows, addRows, trail);
        draw(job, block.concat(baseRows.slice(Le + 1)));
        let ci = block.findIndex((r) => r.c != null);
        if (ci < 0) ci = pre.length + delRows.length;
        track(job, ci);
      }
      if (finished) break;
    }
    const old = s.fields.old_string || '';
    const neu = s.fields.new_string || '';
    if (ms < 0 || !old || !base.startsWith(old, ms)) return null;
    if (s.replaceAll) return base.split(old).join(neu);
    return base.slice(0, ms) + neu + base.slice(ms + old.length);
  }

  // Rows for a Write over an existing file: diff the finished lines so far against the old
  // file; old lines not reached yet stay dimmed below the caret.
  function overwriteRows(lines, baseRows, pendRows, done) {
    const win = Math.min(lines.length, done.length + 40);
    const ops = D.diffLines(lines.slice(0, win), done, 800, true);
    if (!ops) return { head: done.map((t) => ({ k: 'add', t, au: CLAUDE_KEY, aw: 1 })), tail: pendRows };
    let end = ops.length;
    while (end > 0 && ops[end - 1].t === DEL) end--;
    const head = [];
    for (let i = 0; i < end; i++) {
      const o = ops[i];
      const b = baseRows[o.a];
      head.push(o.t === EQ ? b : o.t === DEL ? { k: 'del', t: lines[o.a], au: b.au, ac: b.ac } : { k: 'add', t: done[o.b], au: CLAUDE_KEY, aw: 1 });
    }
    const tail = [];
    for (let i = end; i < ops.length; i++) tail.push(pendRows[ops[i].a]);
    for (let a = win; a < lines.length; a++) tail.push(pendRows[a]);
    return { head, tail };
  }

  async function liveWrite(job, s, f, base) {
    const lines = D.splitLines(base);
    const html = hlFile(base, f.lang, lines);
    let baseRows;
    let pendRows;
    let ver;
    let doneCount = -1;
    let head = [];
    let tail;
    const build = () => {
      const bl = blameLines(f, base);
      baseRows = lines.map((t, i) => ({ k: 'ctx', t, h: html[i], au: bl ? bl[i].p : undefined, ac: bl ? bl[i].c : undefined }));
      pendRows = baseRows.map((r) => ({ k: 'pend', t: r.t, h: r.h, au: r.au, ac: r.ac }));
      tail = pendRows;
      ver = f.blameVer;
      if (lines.length) doneCount = -1;
    };
    build();
    setStatus('live', lines.length ? 'Rewriting the file' : 'Writing a new file');
    draw(job, pendRows);
    let shown = 0;
    let t = performance.now();
    for (;;) {
      await frame();
      const now = performance.now();
      const dt = now - t;
      t = now;
      if (f.blameVer !== ver) build();
      const content = s.fields.content || '';
      shown = advance(shown, content.length, dt, job);
      const parts = content.slice(0, shown).split('\n');
      const partial = parts.pop();
      if (parts.length !== doneCount) {
        if (!lines.length) {
          for (let i = head.length; i < parts.length; i++) head.push({ k: 'add', t: parts[i], au: CLAUDE_KEY, aw: 1 });
        } else ({ head, tail } = overwriteRows(lines, baseRows, pendRows, parts));
        doneCount = parts.length;
      }
      draw(job, head.concat([{ k: 'add', t: partial, c: partial.length, au: CLAUDE_KEY, aw: 1 }], tail));
      track(job, head.length);
      if (s.aborted || (s.ended && shown >= content.length)) break;
    }
    return s.fields.content || '';
  }

  async function waitForResult(s) {
    const t0 = performance.now();
    while (!s.post && !s.fail && !s.aborted) {
      const waited = performance.now() - t0;
      if ((queue.length && waited > 1500) || waited > 120000) return;
      await sleep(40);
    }
  }

  // The edit landed: collapse the red, keep the green, then reconcile with what is on disk.
  async function settle(job, f, base, preview, after) {
    if (!instant(job) && current === f && view.rows.some((r) => r.k === 'del' || r.k === 'pend')) {
      draw(job, view.rows.map((r) => (r.k === 'del' || r.k === 'pend' ? patch(r, { cl: 1, c: null, m: null }) : r.c != null || r.aw ? patch(r, { c: null, aw: 0 }) : r)));
      await sleep(240);
    }
    commit(f, preview, base);
    if (after !== preview) {
      await wait(160, job);
      await animateTransition(job, f, preview, after, base);
    }
  }

  // The edit was rejected or interrupted: fold the proposal away and restore the file.
  async function revert(job, f, disk) {
    if (!instant(job) && current === f && view.rows.some((r) => r.k !== 'ctx')) {
      draw(job, view.rows.map((r) => (r.k === 'add' ? patch(r, { cl: 1, c: null, m: null }) : r.k === 'del' || r.k === 'pend' || r.k === 'mod' ? patch(r, { k: 'ctx', m: null, c: null }) : r.c != null || r.m ? patch(r, { c: null, m: null }) : r)));
      await sleep(260);
    }
    f.text = disk;
    f.recent = null;
    if (current === f) showFile(f, true);
  }

  async function runLive(job, s) {
    setStatus('live', s.tool === 'Write' ? 'Claude is writing' : 'Claude is editing');
    while (!s.file && !s.ended) await sleep(30);
    if (!s.file) return;
    const f = fileState(s.file, s);
    const base = s.base == null ? '' : s.base;
    clearPast(f);
    const onScreen = follow || !current || current === f;
    if (f.text !== base) {
      f.text = base;
      f.recent = null;
      if (current === f) showFile(f, true);
    }
    if (onScreen) showFile(f);
    job.f = f;

    let preview = null;
    if (!s.unreadable) preview = s.tool === 'Write' ? await liveWrite(job, s, f, base) : await liveEdit(job, s, f, base);
    if (!s.post && !s.fail && !s.aborted) setStatus('await', 'Waiting to apply');
    await waitForResult(s);
    s.done = true;
    setTimeout(() => streams.delete(s.id), 5 * 60e3);

    if (s.post) {
      await settle(job, f, base, preview == null ? base : preview, s.post.after);
      if (current === f) flash('ok', s.tool === 'Write' ? 'File written' : 'Edit applied');
    } else if (s.fail || s.aborted) {
      await revert(job, f, s.fail && s.fail.text != null ? s.fail.text : base);
      if (current === f) flash('bad', s.aborted ? 'Interrupted' : s.fail.reason === 'denied' ? 'Edit denied' : 'Edit not applied', 2200);
    } else {
      // No result yet (waiting on a permission prompt, or other work queued up). Show the
      // proposal as settled; the Post event reconciles it later.
      await settle(job, f, base, preview == null ? base : preview, preview == null ? base : preview);
      setStatus('await', 'Awaiting confirmation');
    }
  }

  // ---------------------------------------------------------------------------
  // Replays from the timeline

  async function replay(id) {
    let e;
    try {
      const r = await fetch('/__cv/edit/' + id);
      if (!r.ok) throw new Error(String(r.status));
      e = await r.json();
    } catch {
      flash('bad', 'That edit is no longer available', 1800);
      return;
    }
    if (running && running.kind === 'replay') running.skip = true;
    for (const j of queue) if (j.kind === 'replay') j.skip = true;
    enqueue({
      kind: 'replay',
      run: async (job) => {
        const f = fileState(e.file, e);
        if (!f.past) f.past = { text: f.text, recent: f.recent, adds: f.adds, dels: f.dels };
        f.text = e.before;
        f.recent = null;
        showFile(f, true);
        job.f = f;
        const what = e.tool === 'Write' ? 'write' : 'edit';
        showBanner(`Replaying ${what} from ${time(e.ts)}`, false);
        setStatus('replay', 'Replaying');
        await animateTransition(job, f, e.before, e.after);
        if (f.past && f.past.text !== f.text) showBanner(`Showing a past ${what} from ${time(e.ts)}`, true);
        else {
          f.past = null;
          hideBanner();
        }
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Authorship: fetching, summary strip, focus and hover card

  function scheduleBlame(f, ms, attempt) {
    if (!authorsOn || f.noRepo) return;
    clearTimeout(f.blameTimer);
    f.blameTimer = setTimeout(() => requestBlame(f, attempt || 0), ms);
  }

  async function requestBlame(f, attempt) {
    if (!authorsOn || f.noRepo) return;
    if (f.blaming) {
      f.blameAgain = true;
      return;
    }
    f.blaming = true;
    let d = null;
    try {
      const r = await fetch('/__cv/blame?path=' + encodeURIComponent(f.file));
      if (r.ok) d = await r.json();
    } catch {}
    f.blaming = false;
    if (f.blameAgain) {
      f.blameAgain = false;
      return requestBlame(f, 0);
    }
    if (!d) return;
    if (!d.repo) {
      f.noRepo = true;
      if (current === f) updatePeople();
      return;
    }
    f.repo = d.repo;
    if (!d.lines) return;
    for (const p of d.people) people.set(p.key, Object.assign({}, people.get(p.key), p));
    for (const c of d.commits) commitsById.set(c.sha, Object.assign({}, c, { personKey: d.people[c.person].key }));
    if (d.text !== f.text) {
      // The file moved on while git was running; ask again once it settles.
      if ((attempt || 0) < 3) scheduleBlame(f, 1200, (attempt || 0) + 1);
      return;
    }
    f.blame = { text: d.text, lines: d.lines.map(([pi, ci]) => ({ p: d.people[pi].key, c: ci >= 0 ? d.commits[ci].sha : '' })) };
    f.blameVer = (f.blameVer || 0) + 1;
    if (current === f) {
      if (!running || running.f !== f) render(committedRows(f, false), { noEnter: true });
      updatePeople();
    }
  }

  let focusKey = null;
  function setFocus(key) {
    focusKey = key && key !== focusKey ? key : null;
    ui.focusStyle.textContent = focusKey ? '.code .row:not([data-p="' + CSS.escape(focusKey) + '"]) .tx { opacity: 0.28; }' : '';
    updatePeople();
  }

  function updatePeople() {
    const f = current;
    const bl = f ? blameLines(f, f.text) : null;
    if (!bl || !bl.length) {
      ui.people.hidden = true;
      return;
    }
    const counts = new Map();
    for (const b of bl) counts.set(b.p, (counts.get(b.p) || 0) + 1);
    fitAuthors(counts.keys());
    const list = [...counts].sort((a, b) => b[1] - a[1]);
    let bar = '';
    let chips = '';
    for (const [key, n] of list) {
      const p = personOf(key);
      const pct = (n / bl.length) * 100;
      bar += '<i class="' + (p.claude ? 'cl' : '') + '" style="flex:' + n + (p.claude ? '' : ';--ph:' + hueOf(p.key)) + '"></i>';
      chips +=
        '<button type="button" class="pc' + (p.claude ? ' cl' : '') + (focusKey === key ? ' on' : '') + '"' + tint(p) + ' data-k="' + esc(key) + '" title="' + esc(p.name + (p.login ? ' (@' + p.login + ')' : '') + ': ' + n + ' of ' + bl.length + ' lines. Click to highlight.') + '">' +
        avatar(p) + '<span>' + esc(p.name) + '</span><em>' + (pct < 1 ? '<1' : Math.round(pct)) + '%</em></button>';
    }
    ui.pbar.innerHTML = bar;
    ui.pchips.innerHTML = chips;
    const repo = f.repo || {};
    ui.psrc.textContent = repo.ghOk ? 'GitHub' : 'git';
    ui.psrc.title = repo.ghOk
      ? 'Line authors from git blame, names and avatars from GitHub (' + repo.github + ')'
      : repo.github
        ? 'Line authors from git blame. Sign in with the gh CLI to show GitHub names, avatars and pull requests.'
        : 'Line authors from git blame';
    ui.people.hidden = false;
  }
  ui.pchips.addEventListener('click', (e) => {
    const b = e.target.closest('.pc');
    if (b) setFocus(b.dataset.k);
  });
  ui.rows.addEventListener('click', (e) => {
    const cell = e.target.closest('.au');
    const row = cell && cell.closest('.row');
    if (row && row.dataset.p) setFocus(row.dataset.p);
  });

  let cardTimer = 0;
  function showCard(r, rect) {
    const p = personOf(r.au);
    const c = r.ac ? commitsById.get(r.ac) : null;
    const link = (url, text) => (safeUrl(url) ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + text + '</a>' : text);
    let html = '<div class="ch"' + tint(p) + '>' + avatar(p) + '<div><b>' + esc(p.name) + '</b>' + (p.login ? link(p.url || 'https://github.com/' + p.login, '@' + esc(p.login)) : p.email ? '<span>' + esc(p.email) + '</span>' : '') + '</div></div>';
    if (r.aw) html += '<p class="cm">Claude is writing this right now</p>';
    else if (!c) html += '<p class="cm">' + (p.claude ? 'Written by Claude' : 'Changed locally') + '</p><p class="cf">Not committed yet</p>';
    else {
      html += '<p class="cm">' + esc(c.summary || '(no message)') + '</p>';
      html += '<p class="cf"><code>' + c.sha.slice(0, 7) + '</code> · ' + when(c.time) + (c.claude ? ' · <span class="wc">with Claude</span>' : '') + '</p>';
      if (c.pr) html += '<p class="cf">' + link(c.pr.url, '#' + c.pr.number + ' ' + esc(c.pr.title)) + '</p>';
      else if (c.url) html += '<p class="cf">' + link(c.url, 'View commit') + '</p>';
    }
    ui.card.innerHTML = html;
    ui.card.hidden = false;
    const w = ui.card.offsetWidth;
    const h = ui.card.offsetHeight;
    ui.card.style.left = clamp(rect.right + 8, 8, innerWidth - w - 8) + 'px';
    ui.card.style.top = clamp(rect.top - 6, 8, innerHeight - h - 8) + 'px';
  }
  function hideCard() {
    ui.card.hidden = true;
  }
  ui.rows.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.au');
    if (!cell) return;
    const row = cell.closest('.row');
    const r = view.rows[view.els.indexOf(row)];
    if (!r || !r.au) return;
    clearTimeout(cardTimer);
    showCard(r, cell.getBoundingClientRect());
  });
  ui.rows.addEventListener('mouseout', (e) => {
    if (e.target.closest('.au')) cardTimer = setTimeout(hideCard, 200);
  });
  ui.card.addEventListener('mouseenter', () => clearTimeout(cardTimer));
  ui.card.addEventListener('mouseleave', () => (cardTimer = setTimeout(hideCard, 200)));
  ui.code.addEventListener('scroll', hideCard, { passive: true });

  function setGithub(status) {
    ui.chkGh.classList.toggle('ok', !!(status && status.ok));
    ui.ghState.textContent = !status ? 'checking' : status.ok ? 'signed in as @' + status.login : status.disabled ? 'off in the config (names come from git)' : status.missing ? 'gh CLI not installed (names come from git)' : 'not signed in (names come from git)';
  }

  // ---------------------------------------------------------------------------
  // Activity feed: prompts, thinking, replies and every tool call, as they happen
  //
  // Items come from the server already merged (see server/activity.js) and are upserted by
  // id. They are kept in timestamp order rather than arrival order: a thinking block reaches
  // the transcript a moment after the tool call it led to has started, and still belongs
  // above it.

  const feed = { items: new Map(), els: new Map(), sessions: new Map(), open: new Set() };
  const MAX_FEED = 400;
  const STALE = 20 * 60e3;
  const splitMq = window.matchMedia('(min-width: 1100px)');
  let split = splitMq.matches;
  let viewMode = 'feed';

  const ICONS = {
    bolt: '<path d="M9.2 1.3 3.4 9h4.1l-.9 5.7L12.6 7H8.4z"/>',
    tri: '<path d="M8 2.2 14.2 13.3H1.8z"/>',
    spark: '<path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z"/>',
    branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 5v6M11.5 6.5c0 3-3 3.2-7 4.4"/>',
    box: '<path d="M2.5 5 8 2.5 13.5 5v6L8 13.5 2.5 11zM2.5 5 8 7.5 13.5 5M8 7.5v6"/>',
    hex: '<path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z"/><path d="M6.2 6.2v3.6M9.8 6.2v3.6M6.2 8h3.6"/>',
    db: '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
    globe: '<circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c1.8 1.6 2.6 3.6 2.6 5.8S9.8 12.2 8 13.8C6.2 12.2 5.4 10.2 5.4 8S6.2 3.8 8 2.2"/>',
    term: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="M4.5 6 6.8 8l-2.3 2M8.5 10.5h3"/>',
    doc: '<path d="M4 1.8h5l3 3v9.4H4zM9 1.8v3h3"/>',
    search: '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/>',
    pen: '<path d="M10.8 2.7a1.6 1.6 0 0 1 2.3 2.3L5.6 12.5l-3.1 1 1-3.1z"/>',
    agent: '<rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 5V2.5M6 9h.01M10 9h.01"/>',
    window: '<rect x="2" y="3" width="12" height="10" rx="1.8"/><path d="M2 6h12M4.2 4.5h.01M5.8 4.5h.01"/>',
    hash: '<path d="M6 2 4.5 14M11.5 2 10 14M2.5 5.5h11M2 10.5h11"/>',
    mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.5 4.5 5.5 4.5 5.5-4.5"/>',
    grid: '<path d="M2.5 2.5h5v5h-5zM8.5 2.5h5v5h-5zM2.5 8.5h5v5h-5zM8.5 8.5h5v5h-5z"/>',
    hub: '<circle cx="8" cy="8" r="2"/><circle cx="8" cy="2.8" r="1.2"/><circle cx="12.6" cy="11" r="1.2"/><circle cx="3.4" cy="11" r="1.2"/><path d="M8 4v2M11.6 10.4 9.7 9.1M4.4 10.4l1.9-1.3"/>',
    cloud: '<path d="M4.5 12.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.6-1 3.3 3.3 0 0 1-.3 7z"/>',
    phone: '<rect x="4.5" y="1.8" width="7" height="12.4" rx="1.6"/><path d="M7.2 12h1.6"/>',
    check: '<path d="m3 8.5 3 3 7-7"/>',
    plug: '<path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3"/>',
    hammer: '<path d="m9 2.5 4.5 4.5-2 2L7 4.5zM8 7.5l-5.5 5.5 1.5 1.5L9.5 9"/>',
    card: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M2 6.5h12"/>',
    gh: '<path d="M6 13.4c-3 .9-3-1.5-4.2-1.8M10 14.8v-2.2a2 2 0 0 0-.5-1.5c1.9-.2 3.8-.9 3.8-4.1a3.2 3.2 0 0 0-.9-2.2 3 3 0 0 0-.1-2.2s-.7-.2-2.3.9a8 8 0 0 0-4.2 0C4.2 2.4 3.5 2.6 3.5 2.6a3 3 0 0 0-.1 2.2 3.2 3.2 0 0 0-.9 2.2c0 3.2 1.9 3.9 3.8 4.1a2 2 0 0 0-.5 1.5v2.2"/>',
  };
  const FILLED = new Set(['bolt', 'tri', 'spark']);
  // Service -> [color, icon]. "accent" follows the theme.
  const SVC = {
    supabase: ['#3ecf8e', 'bolt'], vercel: ['#8f8f99', 'tri'], github: ['#8b949e', 'gh'], git: ['#f05033', 'branch'],
    npm: ['#cb3837', 'box'], node: ['#5fa04e', 'hex'], postgres: ['#4f7cc4', 'db'], http: ['#3f76d9', 'globe'],
    python: ['#3776ab', 'term'], docker: ['#2496ed', 'box'], shell: ['#8a919b', 'term'], files: ['#8a919b', 'doc'],
    search: ['#8a919b', 'search'], edit: ['accent', 'pen'], web: ['#3f76d9', 'globe'], agent: ['#8b5cf6', 'agent'],
    skill: ['#c08a1e', 'spark'], browser: ['#3f76d9', 'window'], chrome: ['#3f76d9', 'window'], app: ['accent', 'window'],
    slack: ['#e01e5a', 'hash'], hubspot: ['#ff7a59', 'hub'], gmail: ['#ea4335', 'mail'], microsoft: ['#0078d4', 'grid'],
    dropbox: ['#0061ff', 'box'], canva: ['#00c4cc', 'spark'], higgsfield: ['#a855f7', 'spark'], docs: ['accent', 'doc'],
    artifact: ['accent', 'window'], anthropic: ['accent', 'spark'], xcode: ['#147efb', 'hammer'], brew: ['#e0a030', 'box'],
    stripe: ['#635bff', 'card'], aws: ['#ff9900', 'cloud'], gcloud: ['#4285f4', 'cloud'], ios: ['#147efb', 'phone'],
    tasks: ['#8a919b', 'check'], terminal: ['#8a919b', 'term'], claude: ['accent', 'spark'], mcp: ['#8a919b', 'plug'],
  };
  const svgIcon = (name) => '<svg viewBox="0 0 16 16" aria-hidden="true"' + (FILLED.has(name) ? ' class="f"' : '') + '>' + (ICONS[name] || ICONS.plug) + '</svg>';
  function badge(svc, label) {
    const [color, ic] = SVC[svc] || SVC.mcp;
    return '<span class="sv"' + (color === 'accent' ? '' : ' style="--sc:' + color + '"') + (label ? ' title="' + esc(label) + '"' : '') + '>' + svgIcon(ic) + '</span>';
  }
  const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-6.5"/></svg>';
  const CROSS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>';

  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  function dur(ms) {
    if (ms == null || !(ms >= 0)) return '';
    if (ms < 1000) return Math.max(1, Math.round(ms)) + 'ms';
    const s = ms / 1000;
    if (s < 10) return s.toFixed(1) + 's';
    if (s < 60) return Math.round(s) + 's';
    return Math.floor(s / 60) + 'm ' + String(Math.round(s % 60)).padStart(2, '0') + 's';
  }
  // Elapsed time on a running clock: whole seconds, so it ticks rather than flickers.
  const tick = (ms) => (ms < 60e3 ? Math.floor(Math.max(0, ms) / 1000) + 's' : Math.floor(ms / 60e3) + 'm ' + String(Math.floor((ms % 60e3) / 1000)).padStart(2, '0') + 's');
  function hl(code, lang) {
    if (!code) return '';
    if (window.hljs && lang && hljs.getLanguage(lang) && code.length < 60000) {
      try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch {}
    }
    return esc(code);
  }
  // Claude's replies: plain text with `code` and **bold**.
  const lite = (t) => esc(t).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');

  function liveSession() {
    let best = null;
    const now = Date.now();
    for (const s of feed.sessions.values()) {
      if (s.state === 'idle' || now - s.since > STALE) continue;
      if (!best || s.since > best.since) best = s;
    }
    return best;
  }

  function setView(mode) {
    const m = split && mode === 'feed' ? (viewMode === 'screen' ? 'screen' : 'code') : mode;
    const changed = m !== viewMode || document.body.dataset.view !== m;
    viewMode = m;
    document.body.dataset.view = m;
    if (!changed) return;
    if (m === 'feed') {
      hideCard();
      toBottom(true);
    }
    updateHeader();
    renderTabs();
    updateEmpty();
    renderNow();
  }

  function feedHeader() {
    ui.fname.textContent = 'Activity';
    const now = Date.now();
    const projects = [...new Set([...feed.sessions.values()].filter((s) => now - s.since < STALE || s.state !== 'idle').map((s) => s.project).filter(Boolean))];
    ui.fpath.textContent = projects.length ? projects.join(' · ') : 'Waiting for Claude';
    ui.fpath.title = '';
    ui.ficon.innerHTML = STAR;
    let tools = 0;
    for (const it of feed.items.values()) if (it.kind === 'tool') tools++;
    ui.stats.innerHTML = tools ? '<span class="n">' + tools + ' tool call' + (tools === 1 ? '' : 's') + '</span>' : '';
    document.title = 'Activity · Code Viz';
  }

  // ------------------------------------------------------------------------
  // Cards

  function head(badgeHtml, title, sub, right) {
    return '<div class="fh">' + badgeHtml + '<div class="ft"><b>' + title + '</b>' + (sub ? '<span class="fs">' + sub + '</span>' : '') + '</div>' + (right || '') + '</div>';
  }
  function statusHTML(it) {
    const t0 = it.started || it.ts;
    if (it.status === 'running') return '<span class="fst run"><i class="spin"></i><span class="el" data-t0="' + t0 + '">' + tick(Date.now() - t0) + '</span></span>';
    const d = it.ended && t0 ? dur(it.ended - t0) : '';
    if (it.status === 'ok') return '<span class="fst ok" title="' + esc(clock(t0)) + '">' + CHECK + (d ? '<span>' + d + '</span>' : '') + '</span>';
    if (!it.status) return '<span class="ftime">' + clock(t0) + '</span>';
    const label = it.status === 'denied' ? 'Denied' : it.status === 'interrupted' ? 'Interrupted' : 'Failed';
    return '<span class="fst bad">' + CROSS + '<span>' + label + (d ? ' · ' + d : '') + '</span></span>';
  }
  function outputHTML(it, out) {
    const bad = it.status === 'error' || it.status === 'denied';
    if (out.table && !bad) {
      const t = out.table;
      if (!t.total) return '<div class="fo"><span class="fol">No rows</span></div>';
      let h = '<div class="fo tbl"><span class="fol">' + t.total + ' row' + (t.total === 1 ? '' : 's') + '</span><div class="tw"><table><thead><tr>';
      for (const c of t.cols) h += '<th>' + esc(c) + '</th>';
      h += '</tr></thead><tbody>';
      for (const r of t.rows) h += '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>';
      h += '</tbody></table></div>';
      if (t.total > t.rows.length) h += '<span class="fol">+ ' + (t.total - t.rows.length) + ' more</span>';
      return h + '</div>';
    }
    const text = (out.text || '').replace(/\s+$/, '');
    if (!text) return '';
    const lines = text.split('\n');
    const open = feed.open.has(it.id + ':o');
    const shown = open ? text : lines.slice(0, bad ? 8 : 4).join('\n');
    const more = !open && lines.length > (bad ? 8 : 4);
    return (
      '<div class="fo' + (bad ? ' bad' : '') + (open ? ' open' : '') + '" data-x="o"><span class="fol">' + (bad ? 'Error' : 'Output') +
      ' · ' + lines.length + ' line' + (lines.length === 1 ? '' : 's') + (more ? ' · show all' : open && lines.length > 4 ? ' · show less' : '') +
      '</span><pre>' + esc(shown) + '</pre></div>'
    );
  }
  function toolHTML(it) {
    const m = it.meta || { svc: 'claude', title: it.name || 'Tool' };
    let sub = esc(m.sub || '');
    let out = it.output;
    if (m.svc === 'files' && out && /^\d+ lines$/.test(out.text || '')) {
      sub += (sub ? ' · ' : '') + esc(out.text);
      out = null;
    }
    if (it.edit) sub += (sub ? ' ' : '') + '<span class="fd"><span class="a">+' + it.edit.adds + '</span><span class="d">−' + it.edit.dels + '</span></span>';
    let html = head(badge(m.svc, m.label), esc(m.title || it.name || 'Tool'), sub, statusHTML(it));
    if (m.detail) {
      const open = feed.open.has(it.id + ':c');
      const long = m.detail.split('\n').length > 8 || m.detail.length > 700;
      html += '<pre class="fc' + (open ? ' open' : '') + (long ? ' long' : '') + (it.partial ? ' typing' : '') + '" data-x="c"><code>' + hl(m.detail, m.lang) + (it.partial ? '<span class="caret"></span>' : '') + '</code></pre>';
    }
    if (out && (out.text || out.table)) html += outputHTML(it, out);
    return html;
  }
  function thinkHTML(it) {
    const now = it.live || it.partial;
    const title = now ? 'Thinking' : it.ms ? 'Thought for ' + dur(it.ms) : 'Thought';
    const open = feed.open.has(it.id);
    const text = it.text || '';
    return (
      head('<span class="sv th">' + svgIcon('spark') + '</span>', title, '', '<span class="ftime">' + clock(it.ts) + '</span>') +
      (text ? '<div class="fx think' + (open ? ' open' : '') + '" data-x="t">' + esc(text) + (now ? '<span class="caret"></span>' : '') + '</div>' : '')
    );
  }
  function textHTML(it) {
    const open = feed.open.has(it.id);
    return head(badge('claude'), 'Claude', '', '<span class="ftime">' + clock(it.ts) + '</span>') + '<div class="fx reply' + (open ? ' open' : '') + '" data-x="t">' + lite(it.text || '') + '</div>';
  }
  function promptHTML(it) {
    const s = feed.sessions.get(it.session);
    const project = feed.sessions.size > 1 ? it.project || (s && s.project) || '' : '';
    return (
      '<div class="pw"><span>' + (it.queued ? 'You, while Claude was working' : 'You') + '</span>' + (project ? '<em>' + esc(project) + '</em>' : '') + '<i>' + clock(it.ts) + '</i></div>' +
      '<div class="px' + (feed.open.has(it.id) ? ' open' : '') + '" data-x="t">' + esc(it.text || '') + '</div>'
    );
  }
  function itemHTML(it) {
    if (it.kind === 'tool') return toolHTML(it);
    if (it.kind === 'think') return thinkHTML(it);
    if (it.kind === 'text') return textHTML(it);
    if (it.kind === 'prompt') return promptHTML(it);
    return '<div class="fnote">' + esc(it.text || '') + ' · ' + clock(it.ts) + '</div>';
  }

  // ------------------------------------------------------------------------
  // Keeping the list in order, and the view pinned to the newest item

  const nearBottom = () => ui.flist.scrollHeight - ui.flist.scrollTop - ui.flist.clientHeight < 90;
  function toBottom(now) {
    ui.fjump.hidden = true;
    requestAnimationFrame(() => ui.flist.scrollTo({ top: ui.flist.scrollHeight, behavior: now || document.hidden ? 'auto' : 'smooth' }));
  }
  ui.flist.addEventListener('scroll', () => { if (nearBottom()) ui.fjump.hidden = true; }, { passive: true });
  ui.fjump.onclick = () => toBottom();

  function place(el, ts) {
    for (let n = ui.flist.lastElementChild; n; n = n.previousElementSibling) {
      if (n !== el && (n._ts || 0) <= ts) return ui.flist.insertBefore(el, n.nextElementSibling);
    }
    ui.flist.insertBefore(el, ui.flist.firstElementChild);
  }
  function prune() {
    while (feed.els.size > MAX_FEED && ui.flist.firstElementChild) {
      const first = ui.flist.firstElementChild;
      first.remove();
      feed.els.delete(first.dataset.id);
      feed.items.delete(first.dataset.id);
    }
  }

  // A thinking block arrives whole; type it out quickly so it reads as it was thought.
  function typeIn(el, text) {
    const box = el.querySelector('.fx');
    if (!box || document.hidden || viewMode !== 'feed') return;
    const total = text.length;
    const ms = clamp(total * 5, 350, 1800);
    const t0 = performance.now();
    const html = el._html;
    const step = () => {
      if (!box.isConnected || el._html !== html) return;
      const k = Math.min(1, (performance.now() - t0) / ms);
      box.textContent = text.slice(0, Math.round(total * k));
      if (k < 1) {
        box.insertAdjacentHTML('beforeend', '<span class="caret"></span>');
        requestAnimationFrame(step);
      }
    };
    step();
  }

  function upsertItem(it, backlog) {
    const isNew = !feed.items.has(it.id);
    feed.items.set(it.id, it);
    const stick = nearBottom();
    let el = feed.els.get(it.id);
    if (!el) {
      el = document.createElement('div');
      el.dataset.id = it.id;
      el._ts = it.ts;
      feed.els.set(it.id, el);
      place(el, it.ts);
      prune();
    } else if (it.ts < el._ts) {
      el._ts = it.ts;
      place(el, it.ts);
    }
    const cls = 'fi k-' + it.kind + (it.status ? ' s-' + it.status : '') + (it.live || it.partial ? ' live' : '') + (it.agent ? ' sub' : '');
    if (el.className.replace(/ ?\bin\b/, '') !== cls) el.className = cls + (el.classList.contains('in') ? ' in' : '');
    const html = itemHTML(it);
    if (el._html !== html) {
      el.innerHTML = html;
      el._html = html;
    }
    if (backlog) return;
    if (isNew) {
      el.classList.add('in');
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('in')));
      if (it.kind === 'think' && it.text && !it.partial) typeIn(el, it.text);
    }
    if (stick) toBottom();
    else if (isNew && viewMode === 'feed') ui.fjump.hidden = false;
  }

  ui.flist.addEventListener('click', (e) => {
    const el = e.target.closest('.fi');
    const it = el && feed.items.get(el.dataset.id);
    if (!it) return;
    const sel = window.getSelection && String(window.getSelection());
    const x = e.target.closest('[data-x]');
    if (x && !sel) {
      const key = x.dataset.x === 'c' ? it.id + ':c' : x.dataset.x === 'o' ? it.id + ':o' : it.id;
      if (feed.open.has(key)) feed.open.delete(key);
      else feed.open.add(key);
      el._html = '';
      upsertItem(it, true);
      return;
    }
    if (it.kind === 'tool' && e.target.closest('.fh') && scr.byTool.has(it.id)) return openScreen(scr.byTool.get(it.id));
    if (it.kind === 'tool' && it.meta && it.meta.file && e.target.closest('.fh')) {
      const f = files.get(it.meta.file);
      if (f) showFile(f);
    }
  });

  // ------------------------------------------------------------------------
  // What each session is doing right now

  function stateLabel(s) {
    if (s.state === 'thinking') return 'Thinking';
    if (s.state === 'tool') {
      const it = s.tool && feed.items.get(s.tool);
      return it && it.meta ? it.meta.title : 'Running a tool';
    }
    return 'Working';
  }
  const stateIcon = (s) => (s.state === 'thinking' ? '<span class="orb" aria-hidden="true"></span>' : '<i class="spin" aria-hidden="true"></i>');
  function renderLive() {
    const now = Date.now();
    let html = '';
    for (const s of feed.sessions.values()) {
      if (s.state === 'idle' || now - s.since > STALE) continue;
      html +=
        '<div class="lv ' + s.state + '">' + stateIcon(s) + '<span class="lt">' + esc(stateLabel(s)) + (s.state === 'thinking' ? '<span class="dots"><i></i><i></i><i></i></span>' : '') + '</span>' +
        (feed.sessions.size > 1 && s.project ? '<em>' + esc(s.project) + '</em>' : '') +
        '<span class="el" data-t0="' + s.since + '">' + tick(now - s.since) + '</span></div>';
    }
    if (ui.flive._html !== html) {
      const stick = nearBottom();
      ui.flive.innerHTML = html;
      ui.flive._html = html;
      if (stick) toBottom();
    }
    renderNow();
  }
  // The same, as a small chip over the code, so it stays visible while a file is shown.
  function renderNow() {
    const s = liveSession();
    const it = s && s.state === 'tool' && s.tool ? feed.items.get(s.tool) : null;
    const show = !!s && viewMode === 'code' && !split && !(it && it.meta && it.meta.svc === 'edit');
    ui.now.hidden = !show;
    if (!show) return;
    const html = stateIcon(s) + '<span>' + esc(stateLabel(s)) + '</span><span class="el" data-t0="' + s.since + '">' + tick(Date.now() - s.since) + '</span>';
    if (ui.now._html !== html) {
      ui.now.innerHTML = html;
      ui.now._html = html;
    }
  }
  ui.now.onclick = () => setView('feed');
  setInterval(() => {
    const now = Date.now();
    for (const e of document.querySelectorAll('.el[data-t0]')) e.textContent = tick(now - Number(e.dataset.t0));
  }, 250);

  // Follow mode: go back to the feed when Claude moves on from editing.
  let feedTimer = 0;
  function autoFeed() {
    if (!follow || split || viewMode === 'feed' || running || queue.length) return;
    const wait = lastEditAt + 2500 - performance.now();
    clearTimeout(feedTimer);
    if (wait > 0) feedTimer = setTimeout(autoFeed, wait + 50);
    else setView('feed');
  }

  function loadActivity(snap) {
    ui.flist.textContent = '';
    feed.items.clear();
    feed.els.clear();
    feed.sessions.clear();
    for (const s of (snap && snap.sessions) || []) feed.sessions.set(s.session, s);
    for (const it of (snap && snap.items) || []) upsertItem(it, true);
    renderLive();
    renderTabs();
    toBottom(true);
  }
  function onAct(it) {
    const isNew = !feed.items.has(it.id);
    upsertItem(it, !!it.backlog);
    if (it.backlog || !isNew) return;
    if (!(it.kind === 'tool' && it.meta && it.meta.svc === 'edit')) autoFeed();
    if (viewMode === 'feed' || (split && !current)) feedHeader();
    updateEmpty();
  }
  function onActDelta(d) {
    const it = feed.items.get(d.id);
    if (!it) return;
    it.text = (it.text || '') + d.text;
    upsertItem(it, true);
    if (nearBottom()) toBottom(true);
  }
  function onActState(s) {
    const prev = feed.sessions.get(s.session);
    feed.sessions.set(s.session, s);
    renderLive();
    if (!running && !queue.length && !flashing) setIdle();
    if (!prev || (prev.state === 'idle') !== (s.state === 'idle')) renderTabs();
    if (viewMode === 'feed' || (split && !current)) feedHeader();
    updateEmpty();
  }

  function applySplit() {
    split = splitMq.matches;
    document.body.classList.toggle('split', split);
    viewMode = split ? (viewMode === 'screen' ? 'screen' : 'code') : current || viewMode === 'screen' ? viewMode : 'feed';
    document.body.dataset.view = viewMode;
    updateHeader();
    renderTabs();
    updateEmpty();
    renderNow();
  }
  splitMq.addEventListener('change', applySplit);

  // ---------------------------------------------------------------------------
  // Tool screens: shell commands play on a 1990 phosphor terminal, web searches and page
  // fetches in a browser window. The server builds them from hook events, already redacted and
  // capped (server/screens.js). They share the animation queue with file edits, so they play
  // in order and follow the speed setting.

  const sui = { box: $('screen'), host: $('scr-host'), skip: $('scr-skip'), replay: $('scr-replay') };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const scr = { byId: new Map(), byTool: new Map(), last: null, unseen: false };
  let shown = null;
  const LENS = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/></svg>';
  const LOCK = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';
  const GLOBE = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c1.8 1.6 2.6 3.6 2.6 5.8S9.8 12.2 8 13.8C6.2 12.2 5.4 10.2 5.4 8S6.2 3.8 8 2.2"/></svg>';
  const STATUS_WORD = { ok: 'done', error: 'failed', interrupted: 'interrupted', denied: 'denied', background: 'in background', running: 'running' };

  const promptOf = (s) => (s.shell === 'ps' ? 'PS ' + (s.cwd || '~') + '> ' : ((s.cwd || '').split('/').filter(Boolean).pop() || '~') + ' $ ');
  const screenTitle = (s) => (s.kind === 'terminal' ? s.program || 'Terminal' : s.kind === 'search' ? 'Web search' : s.domain || 'Web page');
  const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
  const pathOf = (u) => {
    try { const x = new URL(u); return (x.pathname === '/' ? x.hostname : x.pathname + x.search) || u; } catch { return u || ''; }
  };
  function exitText(s) {
    const d = s.durationMs != null ? ' · ' + dur(s.durationMs) : '';
    if (s.status === 'ok') return '[exit 0' + d + ']';
    if (s.status === 'error') return '[exit ' + (s.exitCode != null ? s.exitCode : '?') + d + ']';
    if (s.status === 'interrupted') return '^C [interrupted' + d + ']';
    if (s.status === 'denied') return '[permission denied]';
    if (s.status === 'background') return '[running in the background' + (s.backgroundTaskId ? ': ' + s.backgroundTaskId : '') + ']';
    return '';
  }

  function screenHeader() {
    const s = shown;
    ui.fname.textContent = screenTitle(s);
    ui.fpath.textContent = (s.kind === 'terminal' ? s.cwd : s.kind === 'search' ? s.query : s.url) || ' ';
    ui.fpath.title = ui.fpath.textContent;
    ui.ficon.textContent = s.kind === 'terminal' ? '>_' : 'WWW';
    ui.stats.innerHTML = s.ended ? '<span class="n">' + esc(STATUS_WORD[s.status] || '') + (s.durationMs != null ? ' · ' + dur(s.durationMs) : '') + '</span>' : '';
    document.title = screenTitle(s) + ' · Code Viz';
  }

  // Put a screen on the stage (its frame only; the play functions fill it in).
  function buildScreen(s) {
    if (s.kind === 'terminal') {
      sui.host.innerHTML =
        '<div class="crt ' + (CFG.terminalColor === 'amber' ? 'amber' : 'green') + '"><div class="crt-glass' + (reduceMotion.matches ? '' : ' on') + '">' +
        '<div class="crt-bar"><span class="crt-prog">' + esc(s.program || 'sh') + '</span><span class="crt-cwd">' + esc(s.cwd || '') + '</span><span class="crt-stat" data-k="stat"></span></div>' +
        '<div class="crt-body" data-k="body">' + (s.description ? '<div class="crt-rem"># ' + esc(s.description) + '</div>' : '') +
        '<div class="crt-line"><span class="crt-ps">' + esc(promptOf(s)) + '</span><span data-k="cmd"></span><span class="crt-cur" data-k="cur"></span></div>' +
        '<div class="crt-line" data-k="wait" hidden><span class="crt-cur"></span></div>' +
        '<div class="crt-more" data-k="more" hidden></div><pre class="crt-out" data-k="out"></pre><pre class="crt-out crt-err" data-k="err"></pre>' +
        '<div class="crt-exit" data-k="exit" hidden></div><div class="crt-line" data-k="next" hidden><span class="crt-ps">' + esc(promptOf(s)) + '</span><span class="crt-cur"></span></div></div>' +
        '</div><div class="crt-plate"><span>CODE VIZ · TERMINAL</span><i></i></div></div>';
    } else {
      sui.host.innerHTML =
        '<div class="brw"><div class="brw-top"><span class="brw-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
        '<div class="brw-addr">' + (s.kind === 'search' ? LENS : LOCK) + '<span class="brw-q" data-k="q"></span><span class="brw-cur" data-k="cur"></span></div></div>' +
        '<div class="brw-load" data-k="load"><i></i></div><div class="brw-page" data-k="page"></div></div>';
    }
    sui.host.dataset.id = String(s.id);
  }
  const part = (k) => sui.host.querySelector('[data-k="' + k + '"]');

  async function typeInto(job, el, text) {
    if (!el) return;
    if (instant(job) || !text) {
      el.textContent = text;
      return;
    }
    await stepper(job, text.length, Math.max(38, text.length / 1.6), (n) => (el.textContent = text.slice(0, n)));
  }
  async function streamLines(job, el, text, after) {
    if (!el || !text) return;
    const lines = text.split('\n');
    if (instant(job)) {
      el.textContent = text;
      after();
      return;
    }
    await stepper(job, lines.length, clamp(lines.length / 1.4, 24, 600), (n) => {
      el.textContent = lines.slice(0, n).join('\n');
      after();
    });
  }
  // Wait for the result. Gives up (the result then plays as its own step) when other work is
  // queued, so a long command doesn't hold up the file edits behind it.
  async function waitEnded(job, s) {
    const t0 = performance.now();
    while (!s.ended) {
      const waited = performance.now() - t0;
      if (job.skip || (queue.length && waited > 1500) || waited > 10 * 60e3) return false;
      await sleep(80);
    }
    return true;
  }

  // phase: 'type' (type the command, then the result), 'show' (command at once), 'continue'
  // (the command is already on screen).
  async function playTerminal(job, s, phase) {
    const body = part('body');
    const down = () => { if (body) body.scrollTop = body.scrollHeight; };
    if (phase === 'type') await typeInto(job, part('cmd'), s.command || '');
    else if (phase === 'show') part('cmd').textContent = s.command || '';
    part('cur').hidden = true;
    part('wait').hidden = !!s.ended;
    part('stat').innerHTML = s.ended ? esc(STATUS_WORD[s.status] || '') : '<span class="el" data-t0="' + s.ts + '">' + tick(Date.now() - s.ts) + '</span> running';
    down();
    if (!s.ended && !(await waitEnded(job, s))) return false;
    part('wait').hidden = true;
    part('stat').textContent = STATUS_WORD[s.status] || '';
    const out = s.output || { text: '' };
    if (out.dropped) {
      part('more').hidden = false;
      part('more').textContent = '... ' + out.dropped.toLocaleString() + ' earlier line' + (out.dropped === 1 ? '' : 's') + ' not shown';
    }
    await streamLines(job, part('out'), out.text, down);
    await streamLines(job, part('err'), (s.stderr && s.stderr.text) || '', down);
    const ex = part('exit');
    ex.textContent = exitText(s);
    ex.className = 'crt-exit' + (s.status === 'ok' || s.status === 'background' ? '' : ' bad');
    ex.hidden = !ex.textContent;
    part('next').hidden = false;
    down();
    return true;
  }

  function renderPage(s) {
    const bad = s.status === 'error' || s.status === 'denied' || s.status === 'interrupted';
    let h = '';
    if (s.kind === 'search') {
      h += '<div class="brw-engine">' + LENS + '<span>Web search' + (s.domains && s.domains.length ? ' · only ' + esc(s.domains.join(', ')) : '') + '</span></div>';
      h += '<h2 class="brw-h">' + esc(s.query || '') + '</h2>';
      h += '<div class="brw-meta">' + [s.results ? s.results.length + ' result' + (s.results.length === 1 ? '' : 's') : '', s.durationMs != null ? dur(s.durationMs) : ''].filter(Boolean).join(' · ') + '</div><ol class="brw-res">';
      for (const r of s.results || []) {
        const u = safeUrl(r.url);
        h +=
          '<li class="stag"><div class="brw-dom"><span class="brw-fav">' + esc((r.domain || '?')[0].toUpperCase()) + '</span>' + esc(r.domain || '') + '</div>' +
          (u ? '<a class="brw-title" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(r.title) + '</a>' : '<span class="brw-title">' + esc(r.title) + '</span>') +
          '<div class="brw-url">' + esc(r.url) + '</div></li>';
      }
      h += '</ol>';
      if (s.summary) h += '<div class="brw-sum stag' + (bad ? ' brw-err' : '') + '"><b>' + (bad ? 'Error' : 'Summary returned with the results') + '</b>' + esc(s.summary) + '</div>';
    } else {
      h += '<div class="brw-engine">' + GLOBE + '<span>' + esc(s.domain || '') + '</span></div>';
      h += '<h2 class="brw-h">' + esc(pathOf(s.url)) + '</h2>';
      h += '<div class="brw-meta">' + [s.http ? (s.http.code + ' ' + (s.http.text || '')).trim() : '', s.http && s.http.bytes != null ? kb(s.http.bytes) : '', s.durationMs != null ? dur(s.durationMs) : ''].filter(Boolean).map(esc).join(' · ') + '</div>';
      if (s.prompt) h += '<div class="brw-ask stag">Claude asked about this page: ' + esc(s.prompt) + '</div>';
      h += '<article class="brw-art stag' + (bad ? ' brw-err' : '') + '">' + esc(s.summary || (bad ? 'The page could not be fetched.' : '')) + '</article>';
    }
    part('page').innerHTML = h;
  }

  async function playBrowser(job, s, phase) {
    const text = s.kind === 'search' ? s.query || '' : s.url || '';
    if (phase === 'type') await typeInto(job, part('q'), text);
    else if (phase === 'show') part('q').textContent = text;
    part('cur').hidden = true;
    if (!s.ended) {
      part('load').className = 'brw-load busy';
      if (!(await waitEnded(job, s))) return false;
    }
    part('load').className = 'brw-load done';
    renderPage(s);
    const items = [...part('page').querySelectorAll('.stag')];
    if (!instant(job)) {
      for (const el of items) el.classList.add('in');
      for (const el of items) {
        await wait(60, job);
        el.classList.remove('in');
      }
    }
    return true;
  }

  // mode: 'start' (from PreToolUse), 'result' (a result that arrived after its start finished
  // playing), 'replay'.
  async function runScreen(job, s, mode) {
    job.sc = s;
    s._pending = true;
    scr.last = s;
    const onStage = sui.host.dataset.id === String(s.id);
    if (mode === 'replay' || follow || viewMode === 'screen' || (!current && !split && viewMode !== 'feed')) showScreen(s);
    else {
      scr.unseen = true;
      renderTabs();
    }
    const phase = mode === 'result' && onStage ? 'continue' : mode === 'result' ? 'show' : 'type';
    if (phase !== 'continue') buildScreen(s);
    sui.skip.hidden = viewMode !== 'screen';
    sui.replay.hidden = true;
    setStatus('live', s.kind === 'terminal' ? 'Running ' + (s.program || 'a command') : s.kind === 'search' ? 'Searching the web' : 'Fetching a page');
    const done = s.kind === 'terminal' ? await playTerminal(job, s, phase) : await playBrowser(job, s, phase);
    s._pending = false;
    s._waiting = !done;
    sui.skip.hidden = true;
    sui.replay.hidden = !s.ended;
    if (shown === s && viewMode === 'screen') {
      updateHeader();
      if (done) flash(s.status === 'ok' || s.status === 'background' ? 'ok' : 'bad', s.kind === 'terminal' ? (s.status === 'ok' ? 'Command done' : 'Command ' + (STATUS_WORD[s.status] || 'ended')) : s.status === 'ok' ? 'Page loaded' : 'Request failed', 1600);
    }
  }

  function showScreen(s) {
    shown = s;
    scr.last = s;
    scr.unseen = false;
    if (current && viewMode === 'code') current.scroll = ui.code.scrollTop;
    hideCard();
    setView('screen');
    updateHeader();
    renderTabs();
    updateEmpty();
  }
  // Show a screen in its current state at once (a tab or feed card was clicked).
  function openScreen(s) {
    if (!s) return;
    showScreen(s);
    if (sui.host.dataset.id !== String(s.id) || !(running && running.sc === s)) {
      buildScreen(s);
      const job = { skip: true, sc: s };
      (s.kind === 'terminal' ? playTerminal(job, s, 'show') : playBrowser(job, s, 'show')).then(() => {
        sui.replay.hidden = !s.ended;
        updateHeader();
      });
    }
  }

  async function replayScreen(id) {
    let s = scr.byId.get(Number(id));
    if (!s || !s.ended) {
      try {
        const r = await fetch('/__cv/screen/' + id);
        if (r.ok) s = Object.assign(s || {}, await r.json());
      } catch {}
    }
    if (!s || !s.kind) return flash('bad', 'That screen is no longer available', 1800);
    scr.byId.set(s.id, s);
    if (running && running.kind === 'replay') running.skip = true;
    for (const j of queue) if (j.kind === 'replay') j.skip = true;
    enqueue({ kind: 'replay', run: (job) => runScreen(job, s, 'replay') });
  }

  function addScreenTick(m) {
    const label = m.label != null ? m.label : m.kind === 'terminal' ? (m.command || '').split('\n')[0] : m.kind === 'search' ? m.query : m.url;
    const what = m.kind === 'terminal' ? 'Command' : m.kind === 'search' ? 'Search' : 'Fetch';
    const b = document.createElement('button');
    b.className = 'tick ' + (m.kind === 'terminal' ? 'tt' : 'tb');
    b.style.setProperty('--h', '9px');
    b.title = what + ': ' + String(label || '').slice(0, 120) + '\n' + time(m.ts) + ' · Click to replay';
    b.setAttribute('aria-label', 'Replay ' + what.toLowerCase() + ' ' + String(label || '').slice(0, 80) + ' at ' + time(m.ts));
    b.onclick = () => replayScreen(m.id);
    ui.timeline.appendChild(b);
    while (ui.timeline.children.length > 300) ui.timeline.firstChild.remove();
    ui.timeline.scrollLeft = ui.timeline.scrollWidth;
  }

  function onScreenStart(d) {
    const s = Object.assign({}, d);
    scr.byId.set(s.id, s);
    scr.byTool.set(s.toolUseId, s);
    s._pending = true;
    addScreenTick(s);
    // Real-time work first: an animation still replaying an older edit or screen is skipped.
    if (running && running.kind === 'replay') running.skip = true;
    enqueue({ kind: 'screen', run: (job) => runScreen(job, s, 'start') });
  }
  function onScreenEnd(d) {
    let s = scr.byId.get(d.id);
    if (!s) {
      s = Object.assign({}, d);
      scr.byId.set(s.id, s);
      scr.byTool.set(s.toolUseId, s);
      s._pending = true;
      addScreenTick(s);
      return enqueue({ kind: 'screen', run: (job) => runScreen(job, s, 'start') });
    }
    Object.assign(s, d);
    // Its start is still queued or playing, and picks the result up itself.
    if (s._pending && !s._waiting) return;
    s._waiting = false;
    enqueue({ kind: 'screen', run: (job) => runScreen(job, s, 'result') });
  }
  sui.skip.onclick = () => {
    if (running && running.sc === shown) running.skip = true;
  };
  sui.replay.onclick = () => shown && replayScreen(shown.id);

  // ---------------------------------------------------------------------------
  // Token usage: the session gauge, and per-repo totals (aggregated by the server from the
  // usage numbers in session transcripts; see server/usage.js)

  const uui = { box: $('usage'), sum: $('usum'), gauge: $('ug'), fill: $('ugfill'), text: $('ut'), eta: $('ue'), detail: $('udetail'), rows: $('urows'), note: $('unote'), btn: $('usage-btn') };
  let usageOn = prefs.get('usage', CFG.usage !== false);
  let usageOpen = prefs.get('usageOpen', false);
  let usageData = null;
  const tok = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n || 0));
  const hm = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function etaText(s, burn) {
    const e = s.eta;
    const pace = tok(burn.tokensPerMinute) + '/min';
    if (!e) return pace;
    const budget = e.basis === 'budget';
    if (e.reached) return budget ? 'Budget used up' : 'Limit reached';
    if (e.pending) return 'ETA measuring · ' + pace;
    if (e.at) return (budget ? 'Budget out ~' : '100% ~') + hm(e.at) + ' · ' + pace;
    return 'Lasts until reset · ' + pace;
  }

  function renderUsage() {
    uui.box.hidden = !usageOn;
    uui.btn.classList.toggle('on', usageOn);
    uui.btn.setAttribute('aria-pressed', String(usageOn));
    if (!usageOn) return;
    uui.sum.setAttribute('aria-expanded', String(usageOpen));
    uui.detail.hidden = !usageOpen;
    const u = usageData;
    if (!u) {
      uui.text.textContent = 'Counting tokens';
      uui.eta.textContent = '';
      return;
    }
    const s = u.session;
    let pct = null;
    let text;
    if (s.source === 'statusline') {
      pct = s.usedPercent;
      text = 'Session ' + Math.round(pct) + '% used · resets ' + hm(s.resetsAt) + (s.weekPercent != null ? ' · week ' + Math.round(s.weekPercent) + '%' : '');
    } else if (s.source === 'estimate') {
      if (s.budget) pct = s.budgetPercent;
      text = 'Session ~' + tok(s.tokens) + (s.budget ? ' of ' + tok(s.budget) + ' budget' : ' tokens') + ' · resets ~' + hm(s.resetsAt);
    } else {
      text = u.scanning ? 'Counting tokens' : 'No active 5-hour session';
    }
    uui.text.textContent = text;
    uui.eta.textContent = s.source ? etaText(s, u.burn) : '';
    uui.gauge.className = 'ug' + (pct == null ? ' unknown' : pct >= 90 ? ' bad' : pct >= 75 ? ' warn' : '');
    uui.fill.style.width = pct == null ? '0' : Math.max(2, Math.min(100, pct)) + '%';
    const where = s.source === 'statusline' ? 'Plan usage from Claude Code (status line, as of ' + hm(s.asOf) + ')' : s.source === 'estimate' ? 'Estimated from this machine: plan percent not available' : '';
    uui.sum.title = [text, uui.eta.textContent, where].filter(Boolean).join('\n');
    if (!usageOpen) return;

    const period = u.period.kind === 'window' ? 'this 5-hour window' : 'today';
    let html = '';
    for (const r of u.repos) {
      const models = r.models.map((m) => m.model.replace(/^claude-/, '') + ' ' + tok(m.total)).join(', ');
      html +=
        '<div class="ur" title="' + esc(r.path + (r.git ? '' : ' (not a git repository)') + '\n' + r.sessions + ' session' + (r.sessions === 1 ? '' : 's') + ', ' + r.replies + ' replies\n' + models) + '">' +
        '<span class="ud' + (r.active ? ' on' : '') + '"></span><b>' + esc(r.name) + '</b><span class="uv">' + tok(r.total) + '</span></div>' +
        '<div class="ub"><span>in ' + tok(r.in) + '</span><span>out ' + tok(r.out) + '</span><span>cache write ' + tok(r.cacheWrite) + '</span><span>cache read ' + tok(r.cacheRead) + '</span></div>';
    }
    if (!u.repos.length) html = '<div class="ur"><b>' + (u.scanning ? 'Counting tokens' : 'No Claude Code replies ' + period) + '</b></div>';
    else if (u.repos.length > 1) html += '<div class="ur all"><span class="ud"></span><b>All repos, ' + period + '</b><span class="uv">' + tok(u.all.total) + '</span></div>';
    uui.rows.innerHTML = html;
    let note = 'Per repo, ' + period + '. Totals are input + output + cache writes; cache reads are listed separately because they re-read context already counted and would dwarf everything else.';
    if (s.source === 'statusline') note += ' Session percent and reset time come from Claude Code (status line, as of ' + hm(s.asOf) + '); the ETA is the recent pace of that percentage.';
    else {
      note += ' Plan usage percent is not available here: Claude Code only shares it with status line commands (see the README).';
      if (s.source === 'estimate') note += ' The window times are estimated from this machine\'s Claude Code activity; claude.ai and other devices count toward your limit too.';
      note += s.budget ? ' The ETA is an estimate against your sessionTokenBudget of ' + tok(s.budget) + ' tokens.' : ' Set sessionTokenBudget in the config to get an ETA.';
    }
    uui.note.textContent = note;
  }

  function fetchUsage() {
    fetch('/__cv/usage')
      .then((r) => r.json())
      .then((d) => {
        usageData = d;
        renderUsage();
        // The first read of the transcripts takes a moment; ask again until it is done.
        if (d.scanning) setTimeout(fetchUsage, 1500);
      })
      .catch(() => {});
  }
  function onUsage(d) {
    usageData = d;
    renderUsage();
  }
  uui.sum.onclick = () => {
    usageOpen = !usageOpen;
    prefs.set('usageOpen', usageOpen);
    renderUsage();
  };
  uui.btn.onclick = () => {
    usageOn = !usageOn;
    prefs.set('usage', usageOn);
    renderUsage();
    if (usageOn) fetchUsage();
  };

  // ---------------------------------------------------------------------------
  // Server events

  function onHello(d) {
    connected = true;
    setLive(d.live);
    setGithub(d.github);
    if (!d.github) {
      setTimeout(() => {
        fetch('/__cv/health')
          .then((r) => r.json())
          .then((h) => setGithub(h.github || { ok: false }))
          .catch(() => {});
      }, 2500);
    }
    edits.length = 0;
    ui.timeline.textContent = '';
    const ticks = [...(d.history || []).map((e) => ({ t: e.ts, e })), ...(d.screens || []).map((m) => ({ t: m.ts, m }))].sort((a, b) => a.t - b.t);
    for (const k of ticks) k.e ? addTimeline(k.e) : addScreenTick(k.m);
    if (!current && !files.size && d.latest) {
      const f = fileState(d.latest.file, d.latest);
      f.text = d.latest.after;
      f.recent = recentFrom(d.latest.before, d.latest.after);
      f.adds = f.recent.adds;
      f.dels = f.recent.dels;
      showFile(f, true);
    }
    loadActivity(d.activity);
    if (usageOn) fetchUsage();
    renderUsage();
    // Open on the feed when Claude has been active lately, otherwise on the last edit.
    let recent = false;
    for (const it of feed.items.values()) if (Date.now() - it.ts < 10 * 60e3) recent = true;
    setView(recent || !current ? 'feed' : 'code');
    updateHeader();
    updateEmpty();
    if (!running) setIdle();
  }

  function onPre(d) {
    const s = d.toolUseId && streams.get(d.toolUseId);
    if (s) {
      s.pre = d;
      return;
    }
    enqueue({
      kind: 'pre',
      run: async () => {
        const f = fileState(d.file, d);
        const before = d.before == null ? '' : d.before;
        clearPast(f);
        if (f.text !== before) {
          f.text = before;
          f.recent = null;
          if (current === f) showFile(f, true);
        }
        if (follow || !current) showFile(f);
        if (current === f) flash('await', d.tool === 'Write' ? (d.exists ? 'Rewriting file' : 'Creating file') : 'Editing', 60000);
      },
    });
  }

  function onPost(d) {
    addTimeline(d);
    const s = d.toolUseId && streams.get(d.toolUseId);
    if (s && !s.done) {
      s.post = d;
      return;
    }
    enqueue({
      kind: 'edit',
      run: async (job) => {
        const f = fileState(d.file, d);
        const before = d.before || '';
        clearPast(f);
        if (s && s.done) {
          // A live proposal was already shown; reconcile it with the file on disk.
          if (follow && current !== f) showFile(f);
          if (f.text === d.after) commit(f, d.after, before, false);
          else await animateTransition(job, f, f.text, d.after, before);
          if (current === f) flash('ok', 'Edit applied');
          return;
        }
        if (f.text !== before) {
          f.text = before;
          f.recent = null;
          if (current === f) showFile(f, true);
        }
        if (follow || !current) showFile(f);
        job.f = f;
        if (current !== f) return commit(f, d.after, before);
        setStatus('replay', d.tool === 'Write' ? (d.created ? 'Creating file' : 'Rewriting file') : 'Applying edit');
        await animateTransition(job, f, before, d.after);
        flash('ok', d.tool === 'Write' ? 'File written' : 'Edit applied');
      },
    });
  }

  function onFail(d) {
    const s = d.toolUseId && streams.get(d.toolUseId);
    if (s && !s.done) {
      s.fail = d;
      return;
    }
    enqueue({
      kind: 'fail',
      run: async (job) => {
        const f = files.get(d.file);
        if (!f) return;
        job.f = f;
        if (d.text != null && f.text !== d.text) await revert(job, f, d.text);
        if (current === f) flash('bad', d.reason === 'denied' ? 'Edit denied' : 'Edit not applied', 2200);
      },
    });
  }

  function onLiveStart(d) {
    const s = { id: d.id, tool: d.tool, fields: {}, file: null, base: null, ended: false, aborted: false, pre: null, post: null, fail: null, done: false };
    streams.set(d.id, s);
    // Real-time work takes priority over replays that are still animating.
    if (running && running.kind !== 'live') running.skip = true;
    for (const j of queue) if (j.kind !== 'live') j.skip = true;
    enqueue({ kind: 'live', run: (job) => runLive(job, s) });
    setLive({ active: true, configured: true });
  }
  function onLiveFile(d) {
    const s = streams.get(d.id);
    if (!s) return;
    s.file = d.file;
    s.rel = d.rel;
    s.project = d.project;
    s.base = d.base;
    s.unreadable = !!d.unreadable;
  }
  function onLiveDelta(d) {
    const s = streams.get(d.id);
    if (!s) return;
    if (d.d) for (const k in d.d) s.fields[k] = (s.fields[k] || '') + d.d[k];
    if (d.replaceAll != null) s.replaceAll = d.replaceAll;
  }
  function onLiveEnd(d) {
    const s = streams.get(d.id);
    if (s) s.ended = true;
  }
  function onLiveAbort(d) {
    const s = streams.get(d.id);
    if (s) {
      s.ended = true;
      s.aborted = true;
    }
  }

  function connect() {
    const es = new EventSource('/__cv/events');
    const on = (type, fn) =>
      es.addEventListener(type, (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch { return; }
        try { fn(data); } catch (e) { console.error('[code-viz]', type, e); }
      });
    on('hello', onHello);
    on('pre', onPre);
    on('post', onPost);
    on('fail', onFail);
    on('live-start', onLiveStart);
    on('live-file', onLiveFile);
    on('live-delta', onLiveDelta);
    on('live-end', onLiveEnd);
    on('live-abort', onLiveAbort);
    on('proxy', setLive);
    on('act', onAct);
    on('act-delta', onActDelta);
    on('act-state', onActState);
    on('usage', onUsage);
    on('screen-start', onScreenStart);
    on('screen-end', onScreenEnd);
    es.onerror = () => {
      connected = false;
      if (!running) setStatus('bad', 'Disconnected');
      updateEmpty();
      // The browser retries on its own unless it gave up on the stream (it does after a
      // failed reconnect, e.g. while the server restarts for an update); then start over.
      if (es.readyState === EventSource.CLOSED) setTimeout(connect, 2000);
    };
  }

  // ---------------------------------------------------------------------------
  // Controls

  function playDemo() {
    fetch('/__cv/demo', { method: 'POST', headers: { 'X-Code-Viz': '1' } }).catch(() => {});
  }

  function initControls() {
    const speedButtons = ui.speed.querySelectorAll('button');
    for (const b of speedButtons) {
      b.classList.toggle('on', Number(b.dataset.v) === speed);
      b.onclick = () => {
        speed = Number(b.dataset.v);
        prefs.set('speed', speed);
        for (const x of speedButtons) x.classList.toggle('on', x === b);
      };
    }
    const setFollow = (v) => {
      follow = v;
      prefs.set('follow', v);
      ui.follow.setAttribute('aria-pressed', String(v));
      ui.follow.classList.toggle('on', v);
    };
    setFollow(follow);
    ui.follow.onclick = () => setFollow(!follow);
    const setWrap = (v) => {
      wrap = v;
      prefs.set('wrap', v);
      ui.wrap.setAttribute('aria-pressed', String(v));
      ui.wrap.classList.toggle('on', v);
      ui.code.classList.toggle('nowrap', !v);
      if (v) ui.code.scrollLeft = 0;
    };
    setWrap(wrap);
    ui.wrap.onclick = () => setWrap(!wrap);
    const setAuthors = (v) => {
      authorsOn = v;
      prefs.set('authors', v);
      ui.authors.setAttribute('aria-pressed', String(v));
      ui.authors.classList.toggle('on', v);
      ui.code.classList.toggle('authors', v);
      if (!v) setFocus(null);
      hideCard();
      if (current) {
        if (!running || running.f !== current) render(committedRows(current, false), { noEnter: true });
        updatePeople();
        if (v && !current.noRepo && !blameLines(current, current.text)) requestBlame(current, 0);
      }
    };
    setAuthors(authorsOn);
    ui.authors.onclick = () => setAuthors(!authorsOn);
    ui.replay.onclick = () => {
      if (viewMode === 'screen' && shown) return replayScreen(shown.id);
      const own = current ? edits.filter((e) => e.file === current.file) : [];
      const list = own.length ? own : edits;
      if (list.length) replay(list[list.length - 1].id);
    };
    ui.bannerBtn.onclick = () => clearPast(current);
    ui.demo.onclick = playDemo;
  }

  initControls();
  applySplit();
  setStatus('idle', 'Connecting');
  connect();
  if (location.hash === '#demo') {
    history.replaceState(null, '', location.pathname);
    setTimeout(playDemo, 400);
  }
})();
