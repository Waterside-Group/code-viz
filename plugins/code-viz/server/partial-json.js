'use strict';
// Incremental parser for the top-level object of a streamed tool input (the concatenated
// `input_json_delta.partial_json` chunks). String values are reported as they grow, so the
// viewer can show `content` / `new_string` while the model is still generating them.
//
// push(chunk) returns events:
//   { key, start: true }            a string value began
//   { key, text }                   more characters of that string (already unescaped)
//   { key, done: true, value? }     the value finished (value is set for non-strings)
// Nested objects/arrays are skipped and reported only as done.

const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };

function parseScalar(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  const n = Number(s);
  return Number.isNaN(n) ? s : n;
}

class PartialJSON {
  constructor() {
    this.state = 'start';
    this.key = '';
    this.keyBuf = '';
    this.esc = false;
    this.uni = null;
    this.scalar = '';
    this.depth = 0;
    this.nestStr = false;
    this.nestEsc = false;
  }

  push(chunk) {
    const out = [];
    let text = '';
    const flush = () => {
      if (text) out.push({ key: this.key, text });
      text = '';
    };

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      switch (this.state) {
        case 'start':
          if (ch === '{') this.state = 'key?';
          break;
        case 'key?':
          if (ch === '"') {
            this.state = 'key';
            this.keyBuf = '';
          } else if (ch === '}') this.state = 'done';
          break;
        case 'key':
          if (this.esc) {
            this.keyBuf += ESCAPES[ch] ?? ch;
            this.esc = false;
          } else if (ch === '\\') this.esc = true;
          else if (ch === '"') {
            this.key = this.keyBuf;
            this.state = 'colon';
          } else this.keyBuf += ch;
          break;
        case 'colon':
          if (ch === ':') this.state = 'value?';
          break;
        case 'value?':
          if (ch === '"') {
            this.state = 'str';
            out.push({ key: this.key, start: true });
          } else if (ch === '{' || ch === '[') {
            this.state = 'nest';
            this.depth = 1;
          } else if (ch !== ' ' && ch !== '\n' && ch !== '\t' && ch !== '\r') {
            this.state = 'scalar';
            this.scalar = ch;
          }
          break;
        case 'str':
          if (this.uni !== null) {
            this.uni += ch;
            if (this.uni.length === 4) {
              text += String.fromCharCode(parseInt(this.uni, 16));
              this.uni = null;
            }
          } else if (this.esc) {
            this.esc = false;
            if (ch === 'u') this.uni = '';
            else text += ESCAPES[ch] ?? ch;
          } else if (ch === '\\') this.esc = true;
          else if (ch === '"') {
            flush();
            out.push({ key: this.key, done: true });
            this.state = 'after';
          } else text += ch;
          break;
        case 'scalar':
          if (ch === ',' || ch === '}') {
            out.push({ key: this.key, done: true, value: parseScalar(this.scalar.trim()) });
            this.state = ch === ',' ? 'key?' : 'done';
          } else this.scalar += ch;
          break;
        case 'nest':
          if (this.nestStr) {
            if (this.nestEsc) this.nestEsc = false;
            else if (ch === '\\') this.nestEsc = true;
            else if (ch === '"') this.nestStr = false;
          } else if (ch === '"') this.nestStr = true;
          else if (ch === '{' || ch === '[') this.depth++;
          else if ((ch === '}' || ch === ']') && --this.depth === 0) {
            out.push({ key: this.key, done: true });
            this.state = 'after';
          }
          break;
        case 'after':
          if (ch === ',') this.state = 'key?';
          else if (ch === '}') this.state = 'done';
          break;
        default:
          break;
      }
    }
    flush();
    return out;
  }
}

module.exports = { PartialJSON };
