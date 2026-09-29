// Line diff shared by the server (stats) and the viewer (animations).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CVDiff = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EQ = 0;
  const DEL = 1;
  const INS = 2;

  // Lines as an editor shows them: a trailing newline does not add an empty last line.
  function splitLines(text) {
    if (!text) return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  // Myers O(ND) diff over the middle section left after trimming the common prefix/suffix.
  // Returns null when the edit distance exceeds maxD.
  function myers(a, b, a0, a1, b0, b1, maxD) {
    const N = a1 - a0;
    const M = b1 - b0;
    const out = [];
    if (N === 0) {
      for (let j = b0; j < b1; j++) out.push({ t: INS, b: j });
      return out;
    }
    if (M === 0) {
      for (let i = a0; i < a1; i++) out.push({ t: DEL, a: i });
      return out;
    }
    const lim = Math.min(N + M, maxD);
    const off = lim + 1;
    const v = new Int32Array(2 * lim + 3);
    const trace = [];
    let found = -1;
    outer: for (let d = 0; d <= lim; d++) {
      // Snapshot of v before step d, for k in [-d-1, d+1], indexed by k + d + 1.
      trace.push(v.slice(off - d - 1, off + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && a[a0 + x] === b[b0 + y]) {
          x++;
          y++;
        }
        v[off + k] = x;
        if (x >= N && y >= M) {
          found = d;
          break outer;
        }
      }
    }
    if (found < 0) return null;

    const rev = [];
    let x = N;
    let y = M;
    for (let d = found; d >= 0; d--) {
      const t = trace[d];
      const base = d + 1;
      const k = x - y;
      const pk = k === -d || (k !== d && t[base + k - 1] < t[base + k + 1]) ? k + 1 : k - 1;
      const px = t[base + pk];
      const py = px - pk;
      while (x > px && y > py) {
        rev.push({ t: EQ, a: a0 + x - 1, b: b0 + y - 1 });
        x--;
        y--;
      }
      if (d > 0) {
        if (x === px) rev.push({ t: INS, b: b0 + y - 1 });
        else rev.push({ t: DEL, a: a0 + x - 1 });
      }
      x = px;
      y = py;
    }
    return rev.reverse();
  }

  // ops: [{t: EQ, a, b} | {t: DEL, a} | {t: INS, b}] in order.
  // With strict, returns null instead of a delete-everything/insert-everything fallback.
  function diffLines(a, b, maxD, strict) {
    if (maxD == null) maxD = 1500;
    const n = a.length;
    const m = b.length;
    let s = 0;
    while (s < n && s < m && a[s] === b[s]) s++;
    let ea = n;
    let eb = m;
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
      ea--;
      eb--;
    }
    const ops = [];
    for (let i = 0; i < s; i++) ops.push({ t: EQ, a: i, b: i });
    const mid = myers(a, b, s, ea, s, eb, maxD);
    if (mid) {
      for (const o of mid) ops.push(o);
    } else {
      if (strict) return null;
      for (let i = s; i < ea; i++) ops.push({ t: DEL, a: i });
      for (let j = s; j < eb; j++) ops.push({ t: INS, b: j });
    }
    for (let i = 0; i < n - ea; i++) ops.push({ t: EQ, a: ea + i, b: eb + i });
    return ops;
  }

  // Contiguous change regions: [{a0, a1, b0, b1}] (half-open ranges into a and b).
  function hunks(ops) {
    const out = [];
    let h = null;
    let ai = 0;
    let bi = 0;
    for (const o of ops) {
      if (o.t === EQ) {
        if (h) out.push(h);
        h = null;
        ai = o.a + 1;
        bi = o.b + 1;
        continue;
      }
      if (!h) h = { a0: ai, a1: ai, b0: bi, b1: bi };
      if (o.t === DEL) ai = h.a1 = o.a + 1;
      else bi = h.b1 = o.b + 1;
    }
    if (h) out.push(h);
    return out;
  }

  function diffStats(before, after) {
    const ops = diffLines(splitLines(before), splitLines(after));
    let adds = 0;
    let dels = 0;
    for (const o of ops) {
      if (o.t === INS) adds++;
      else if (o.t === DEL) dels++;
    }
    return { adds, dels };
  }

  return { EQ, DEL, INS, splitLines, diffLines, hunks, diffStats };
});
