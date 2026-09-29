'use strict';
// Redacts obvious secrets from text before Code Viz stores it or shows it: tool commands and
// their output, search queries, fetched URLs and summaries. It is a safety net for a local
// viewer, not a guarantee: it catches common shapes (tokens, keys, Authorization headers,
// .env-style KEY=value lines with secret names, credentials in URLs), not every secret.

const MARK = '[redacted]';

// Tokens with a recognizable prefix or shape.
const TOKENS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bsbp_[a-f0-9]{40}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
];

// Words that make a variable, header or key name a secret.
const SECRET_NAME = '(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|CREDENTIALS?|SESSION[_-]?KEY|SIGNING[_-]?KEY|DATABASE[_-]?URL|DB[_-]?URL|CONNECTION[_-]?STRING|DSN|WEBHOOK[_-]?URL|SERVICE[_-]?ROLE)';

const RULES = [
  // Authorization and similar headers, in curl flags, HTTP dumps and code.
  [/\b((?:proxy-)?authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)(["']?\s*[:=]\s*["']?)(?:(bearer|basic|token|digest)\s+)?([^\s"',;]+)/gi, (m, name, sep, scheme) => `${name}${sep}${scheme ? scheme + ' ' : ''}${MARK}`],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, (m, b) => `${b} ${MARK}`],
  // .env and shell style: NAME=value, export NAME="value", with a secret-sounding NAME.
  [new RegExp(`\\b((?:export\\s+)?[A-Z0-9_]*${SECRET_NAME}[A-Z0-9_]*)=("[^"\\n]*"|'[^'\\n]*'|[^\\s"']+)`, 'g'), (m, name) => `${name}=${MARK}`],
  // JSON and YAML keys: "password": "value", api_key: value.
  [new RegExp(`(["']?)(\\b[A-Za-z0-9_.-]*${SECRET_NAME}[A-Za-z0-9_.-]*)\\1(\\s*:\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s,}"']+)`, 'gi'), (m, q, name, sep, value) => (/^(true|false|null|\d+|\[redacted\])$/.test(value) ? m : `${q}${name}${q}${sep}${value[0] === '"' || value[0] === "'" ? value[0] + MARK + value[0] : MARK}`)],
  // Credentials inside URLs, and secret query parameters.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, (m, scheme) => `${scheme}${MARK}@`],
  [/([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|password|pwd|sig|signature|client_secret|auth)=)[^&\s#"']+/gi, (m, p) => `${p}${MARK}`],
];

function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const re of TOKENS) out = out.replace(re, MARK);
  for (const [re, fn] of RULES) out = out.replace(re, fn);
  return out;
}

// Redact every string in a JSON-like value (for tool inputs shown in the feed).
function redactDeep(value, depth = 0) {
  if (typeof value === 'string') return redact(value);
  if (!value || typeof value !== 'object' || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = new RegExp(`^[A-Za-z0-9_.-]*${SECRET_NAME}[A-Za-z0-9_.-]*$`, 'i').test(k) && typeof v === 'string' ? MARK : redactDeep(v, depth + 1);
  return out;
}

module.exports = { redact, redactDeep, MARK };
