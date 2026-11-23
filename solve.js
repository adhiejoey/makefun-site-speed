// A faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// run(input) returns exactly the output tree makefun-site's build returns for the
// case's site, byte for byte, but faster: the hot paths of the reference are
// rewritten — inline Markdown is scanned for its next special character instead of
// escaped one character at a time, slugs are memoised with an ASCII fast path,
// front matter is read by slicing instead of splitting the whole file, Markdown
// blocks render straight to their HTML without token objects, and template loops
// reuse one scope frame per execution instead of one per element.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ------------------------------------------------------------------ text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026".
 * `cache` is the run's memo (dates repeat across a site).
 */
function longDate(date, cache) {
  let out = cache.get(date);
  if (out === undefined) {
    const [y, m, d] = date.split('-');
    out = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    cache.set(date, out);
  }
  return out;
}

// ------------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. Read by slicing the front-matter region only: the body is the
 * text after the closing line, never split and re-joined.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing line (the first line after the opening that is exactly '---').
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let close = -1; // 0-based line index of the closing line
  let closeEnd = -1; // index just past the closing line's '\n' (or text.length)
  let lineNo = 1;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const lineEnd = e === -1 ? text.length : e;
    if (text.slice(pos, lineEnd) === '---') {
      close = lineNo;
      closeEnd = e === -1 ? text.length : e + 1;
      break;
    }
    lineNo++;
    if (e === -1) break;
    pos = e + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = firstNl + 1;
  for (let i = 1; i < close; i++) {
    const e = text.indexOf('\n', p);
    const lineEnd = e === -1 ? text.length : e;
    const line = text.slice(p, lineEnd);
    if (!/^[ \t]*$/.test(line) && !line.startsWith('#')) {
      const m = LINE.exec(line);
      if (!m) return { error: `line ${i + 1} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = lineEnd + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd >= text.length ? '' : text.slice(closeEnd) };
}

// ------------------------------------------------------------------ slugs

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9 one
 * "-", none at either end, at most SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when nothing is
 * left. `cache` is the run's memo: titles, tag names and headings repeat across a site.
 * Pure-ASCII text takes a fast path (NFKD is the identity on ASCII and no mark can occur); anything else runs the
 * full rule exactly as stated.
 */
function slugify(text, cache) {
  let out = cache.get(text);
  if (out !== undefined) return out;
  out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) {
      ascii = false;
      break;
    }
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (!ascii) {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ------------------------------------------------------------------ words

const WORD_RE = /\S+/g;

/**
 * The words of a body: its runs of characters other than whitespace. Counted by scanning the code units once,
 * no array built. The whitespace test is JavaScript's own \s set (the control whitespace, space, and the
 * Unicode spaces), so it agrees with /\S+/g exactly.
 */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let sp;
    if (c <= 32) sp = c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32;
    else if (c < 128) sp = false;
    else sp = c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (sp) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------------ markdown

const BLANK_RE = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const QUOTE_STRIP = /^> ?/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The next interesting character of inline text: a backslash, backtick, star, '[', or one the escape table names. */
const SPECIAL = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline, appended to `out`; `env.link(target)` is a link's href.
 * Plain runs are copied whole: only the characters that can open a span, a link or an
 * escape are ever examined one by one.
 */
function inlineInto(s, env, out) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    SPECIAL.lastIndex = i;
    const m = SPECIAL.exec(s);
    if (m === null) {
      out.push(s.slice(i));
      return;
    }
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    const c = s[j];
    if (c === '&') {
      out.push('&amp;');
      i = j + 1;
    } else if (c === '<') {
      out.push('&lt;');
      i = j + 1;
    } else if (c === '>') {
      out.push('&gt;');
      i = j + 1;
    } else if (c === '"') {
      out.push('&quot;');
      i = j + 1;
    } else if (c === "'") {
      out.push('&#39;');
      i = j + 1;
    } else if (c === '\\') {
      const d = s[j + 1];
      if (d !== undefined && ESCAPABLE.has(d)) {
        out.push(d === '>' ? '&gt;' : d);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>');
        out.push(escapeHtml(s.slice(j + 1, k)));
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out.push('<strong>');
          inlineInto(s.slice(j + 2, k), env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out.push('<em>');
          inlineInto(s.slice(j + 1, k), env, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
    } else {
      // '['
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="');
        out.push(escapeHtml(env.link(target)));
        out.push('">');
        inlineInto(s.slice(j + 1, k), env, out);
        out.push('</a>');
        i = mm + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
    }
  }
}

/** `s` rendered inline, as one string. */
function inlineStr(s, env) {
  const out = [];
  inlineInto(s, env, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * Blocks are read straight off the body with a cursor and rendered as they are found: no line array, no tokens,
 * and the HTML is built in one chunk array, each block followed by "\n" — so inline rendering writes straight
 * into the page's chunks instead of building a string per block.
 */
function renderMarkdown(src, env, slugCache) {
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let curPos = 0;
  let cur = null;
  const advance = () => {
    if (curPos >= n) {
      cur = null;
      return;
    }
    let e = src.indexOf('\n', curPos);
    if (e === -1) e = n;
    cur = src.slice(curPos, e);
    curPos = e === n ? n : e + 1;
  };
  advance();
  while (cur !== null) {
    const line = cur;
    if (line === '') {
      advance();
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        advance();
        continue;
      }
      // paragraph (a line that starts with spaces is one, once it is not blank)
      const textParts = [trimLine(line)];
      advance();
      while (cur !== null && !endsParagraph(cur)) {
        textParts.push(trimLine(cur));
        advance();
      }
      parts.push('<p>');
      const exStart = parts.length;
      inlineInto(textParts.join('\n'), env, parts);
      if (excerpt === null) excerpt = parts.slice(exStart).join('');
      parts.push('</p>\n');
      continue;
    }
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        let body = '';
        advance();
        while (cur !== null && !FENCE_CLOSE.test(cur)) {
          body += `${cur}\n`;
          advance();
        }
        advance(); // past the closing fence, or a no-op at the end
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        parts.push(`<pre><code${cls}>${escapeHtml(body)}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, slugCache), ids);
        const html = inlineStr(heading.text, env);
        parts.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        advance();
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) {
        parts.push('<hr>\n');
        advance();
        continue;
      }
    } else if (c0 === 62) {
      const rawLines = [];
      while (cur !== null && cur.charCodeAt(0) === 62) {
        rawLines.push(cur.replace(QUOTE_STRIP, ''));
        advance();
      }
      const qLines = rawLines.map(trimLine).filter((l) => l !== '');
      if (qLines.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else {
        parts.push('<blockquote>\n<p>');
        inlineInto(qLines.join('\n'), env, parts);
        parts.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      const bullet = BULLET.exec(line);
      const ordered = bullet === null ? ORDERED.exec(line) : null;
      if (bullet !== null || ordered !== null) {
        const isOrdered = ordered !== null;
        const marker = isOrdered ? ORDERED : BULLET;
        const start = isOrdered ? Number(ordered[1]) : 1;
        const items = [];
        while (cur !== null) {
          const m = marker.exec(cur);
          if (m !== null) {
            items.push([trimLine(isOrdered ? m[2] : m[1])]);
            advance();
          } else if (CONTINUED.test(cur)) {
            items[items.length - 1].push(trimLine(cur));
            advance();
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
        parts.push(`${open}\n`);
        for (const item of items) {
          parts.push('<li>');
          inlineInto(item.join('\n'), env, parts);
          parts.push('</li>\n');
        }
        parts.push(`</${tag}>\n`);
        continue;
      }
    }
    // paragraph
    const textParts = [trimLine(line)];
    advance();
    while (cur !== null && !endsParagraph(cur)) {
      textParts.push(trimLine(cur));
      advance();
    }
    parts.push('<p>');
    const exStart = parts.length;
    inlineInto(textParts.join('\n'), env, parts);
    if (excerpt === null) excerpt = parts.slice(exStart).join('');
    parts.push('</p>\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The value at `path` in `vars`: its first name from the scope, then own properties. A name is absent when its
 * value is undefined: no variable this build ever binds is undefined (loop elements are cards, tags and headings,
 * and the page's values are objects, arrays and strings), so the test is exact and no scope chain is walked.
 */
function lookup(vars, path) {
  let v = vars[path[0]];
  if (v === undefined) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` in `vars`, one scope object for the whole render. A loop binds its element and its
 * `loop` record in that same object and restores what was there before when it ends, so an inner loop shadows an
 * outer one exactly as a scope chain would — without building a frame per element or per execution. Rendering is
 * synchronous, so no iteration can see another's bindings.
 */
function renderNodes(nodes, vars, ctx, depth, out) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(vars, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(vars, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(vars, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, vars, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(vars, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        const prevName = vars[n.name];
        const prevLoop = vars.loop;
        const loop = { index: 1, first: true, last: len === 1, length: len };
        vars.loop = loop;
        for (let k = 0; k < len; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          renderNodes(n.body, vars, ctx, depth, out);
        }
        vars[n.name] = prevName;
        vars.loop = prevLoop;
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, vars, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ links

/** `rel` (a link's path, "/"-separated) from the directory parts `dirParts`, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// ------------------------------------------------------------------ the build

/** A page's link record as templates read it. */
function linkOf(s, dateCache) {
  return s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const dateCache = new Map();

  // Templates, parsed in code-unit order of name; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort()) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of path; line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (!f.path.endsWith('.md')) {
      statics.push(f);
      continue;
    }
    const raw = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
    const fm = parseFrontMatter(raw);
    if ('error' in fm) {
      report.push(`refused ${f.path}: ${fm.error}`);
      continue;
    }
    const s = { path: f.path, data: fm.data, body: fm.body, post: f.path.startsWith('posts/') };
    const own = f.path.startsWith('tags/') ? 'tags' : f.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${f.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${f.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${f.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${f.path}`);
      continue;
    }
    sources.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const path = s.path;
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const p = rel === '' ? null : resolvePath(dirParts, rel);
        if (p !== null && bySource.has(p)) return `${bySource.get(p).url}${frag}`;
        if (p !== null && staticPaths.has(p)) return `${base}/${p}${frag}`;
        broken.add(`broken-link ${path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, and equal dates by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages as templates read them.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => {
    const c = s.post ? cards.get(s) : cardOf(s);
    return {
      title: c.title,
      url: c.url,
      date: c.date,
      date_long: c.date_long,
      summary: c.summary,
      excerpt: c.excerpt,
      reading_minutes: c.reading_minutes,
      tags: c.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null, dateCache),
      older: linkOf(s.older ?? null, dateCache),
      is_post: s.post,
    };
  };

  // Layouts: every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    const scope = { site, tags: allTags, recent, ...vars };
    renderNodes(nodes, scope, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort();
  const pageCount = sources.reduce((n, s) => n + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
