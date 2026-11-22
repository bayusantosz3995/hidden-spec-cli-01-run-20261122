// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), applies it to the tree rooted at the working directory,
// and changes every file or none. SPEC.md is the whole contract.
//
// Node 22 and its standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: print this one line, exit 2. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC section 3: a safe path. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------------------------------------------------------------- files

/** A file read as lines: its line break, and whether it ends with one. */
interface FileDoc {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const lines = text.split(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function renderFile(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.finalBreak ? doc.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

// ---------------------------------------------------------------- matching (SPEC section 5)

type Tier = 0 | 1 | 2;

function normLine(s: string, tier: Tier): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where `o` occurs in `file` at `tier`, at or after `from`. */
function occurrences(file: string[], o: string[], tier: Tier, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const on = o.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(file[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `o` occurs at or after `from`, and where. */
function findTier(file: string[], o: string[], strict: boolean, from = 0): { tier: Tier; at: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(file, o, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of an old or new block: `ctx` lines are in both and keep the file's own text. */
interface PLine {
  text: string;
  ctx: boolean;
}

/**
 * The lines that replace the matched ones: context lines are the file's own
 * matched lines; at tier 2 the other lines are re-indented from O's first
 * line's leading whitespace to the file's first matched line's.
 */
function buildReplacement(fileLines: string[], pos: number, o: PLine[], n: PLine[], tier: Tier): string[] {
  if (o.length === 0) return n.map((l) => l.text);
  const oCtx: number[] = [];
  o.forEach((l, i) => {
    if (l.ctx) oCtx.push(i);
  });
  let rank = 0;
  const f = leadingWs(fileLines[pos]!);
  const p = leadingWs(o[0]!.text);
  const out: string[] = [];
  for (const nl of n) {
    if (nl.ctx) {
      out.push(fileLines[pos + oCtx[rank++]]!);
    } else {
      let t = nl.text;
      if (tier === 2 && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the tree

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
  move(oldP: string, newP: string, content: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, content);
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------- format detection (SPEC section 4)

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- JSON edits (SPEC section 9)

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const doc = parseFile(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const lines = [...doc.lines];
      lines.splice(line, 0, ...add);
      tree.set(p, renderFile({ lines, br: doc.br, finalBreak: doc.finalBreak }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- unified diffs (SPEC section 6)

interface UHunk {
  /** The -A of the hunk header: where the hunk claims to start. */
  a: number;
  /** Context and `-` lines, in body order. */
  o: PLine[];
  /** Context and `+` lines, in body order. */
  n: PLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  lastNoBreak: boolean;
  /** A `\` line follows the hunk's last `+` line, or null when it has none. */
  lastPlusNoBreak: boolean | null;
}

interface USection {
  /** Null means /dev/null: no file on that side. */
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `--- `/`+++ ` line names, or null for /dev/null. */
function diffPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** The two paths a `diff --git a/<X> b/<Y>` line names, or null when it is not of that form. */
function diffGitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let sec: {
    pairOld?: string | null;
    pairNew?: string | null;
    renameOld?: string;
    renameNew?: string;
    diffOld?: string;
    diffNew?: string;
    create: boolean;
    remove: boolean;
    hunks: UHunk[];
  } | null = null;
  let state: 'outside' | 'header' | 'between' = 'outside';

  const finish = (): void => {
    if (sec === null) return;
    const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.diffOld !== undefined ? sec.diffOld : null;
    const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.diffNew !== undefined ? sec.diffNew : null;
    sections.push({ oldPath, newPath, create: sec.create, remove: sec.remove, hunks: sec.hunks });
    sec = null;
  };

  const startSection = (diff: [string, string] | null): void => {
    finish();
    sec = { create: false, remove: false, hunks: [] };
    if (diff !== null) {
      sec.diffOld = diff[0];
      sec.diffNew = diff[1];
    }
    state = 'header';
  };

  /** Parse a hunk starting at `at` (a valid `@@` header line); returns the index after its body. */
  const parseHunk = (at: number): number => {
    const m = HUNK_RE.exec(lines[at]!);
    const a = Number(m![1]);
    let j = at + 1;
    const body: { kind: 'ctx' | 'old' | 'new'; text: string; noBreak: boolean; empty: boolean }[] = [];
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l === '') {
        body.push({ kind: 'ctx', text: '', noBreak: false, empty: true });
        j++;
        continue;
      }
      const c = l[0]!;
      if (c === ' ') {
        body.push({ kind: 'ctx', text: l.slice(1), noBreak: false, empty: false });
        j++;
        continue;
      }
      if (c === '-') {
        body.push({ kind: 'old', text: l.slice(1), noBreak: false, empty: false });
        j++;
        continue;
      }
      if (c === '+') {
        body.push({ kind: 'new', text: l.slice(1), noBreak: false, empty: false });
        j++;
        continue;
      }
      if (c === '\\') {
        if (body.length > 0) body[body.length - 1]!.noBreak = true;
        j++;
        continue;
      }
      break;
    }
    while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
    const o: PLine[] = [];
    const n: PLine[] = [];
    for (const b of body) {
      if (b.kind !== 'new') o.push({ text: b.text, ctx: b.kind === 'ctx' });
      if (b.kind !== 'old') n.push({ text: b.text, ctx: b.kind === 'ctx' });
    }
    let lastNoBreak = false;
    for (let k = body.length - 1; k >= 0; k--) {
      const b = body[k]!;
      if (b.kind === 'ctx' || b.kind === 'new') {
        lastNoBreak = b.noBreak;
        break;
      }
    }
    let lastPlusNoBreak: boolean | null = null;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.kind === 'new') {
        lastPlusNoBreak = body[k]!.noBreak;
        break;
      }
    }
    sec!.hunks.push({ a, o, n, lastNoBreak, lastPlusNoBreak });
    return j;
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const diff = diffGitPaths(l);
      if (diff === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(diff);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (state === 'outside') throw new Exit2(`error: parse ${i + 1}`);
      if (!HUNK_RE.test(l)) throw new Exit2(`error: parse ${i + 1}`);
      i = parseHunk(i);
      state = 'between';
      continue;
    }
    if (state === 'header' && l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        sec!.pairOld = diffPath(l);
        sec!.pairNew = diffPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (state !== 'header' && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection(null);
      sec!.pairOld = diffPath(l);
      sec!.pairNew = diffPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (state === 'header') {
      if (l.startsWith('rename from ')) sec!.renameOld = l.slice('rename from '.length);
      else if (l.startsWith('rename to ')) sec!.renameNew = l.slice('rename to '.length);
      else if (l.startsWith('new file mode')) sec!.create = true;
      else if (l.startsWith('deleted file mode')) sec!.remove = true;
      // every other header line is ignored
      i++;
      continue;
    }
    // outside a section, or between hunks: prose and anything else is ignored
    i++;
  }
  finish();
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply a section's hunks to a file's lines, in order. */
function applyHunks(doc: FileDoc, hunks: UHunk[], strict: boolean, path: string): FileDoc {
  let lines = [...doc.lines];
  let finalBreak = doc.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const oTexts = h.o.map((l) => l.text);
    if (oTexts.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      if (at === lines.length) finalBreak = !h.lastNoBreak;
      lines.splice(at, 0, ...h.n.map((l) => l.text));
      d += h.n.length;
      continue;
    }
    const found = findTier(lines, oTexts, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.at[0]!;
    for (const p of found.at) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    if (best + oTexts.length === lines.length) finalBreak = !h.lastNoBreak;
    const repl = buildReplacement(lines, best, h.o, h.n, found.tier);
    lines.splice(best, oTexts.length, ...repl);
    d += h.n.length - h.o.length;
  }
  return { lines, br: doc.br, finalBreak };
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = sec.create || oldP === null;
    const isRemove = !isCreate && (sec.remove || newP === null);
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlusNoBreak = false;
      for (const h of sec.hunks) {
        for (const l of h.n) if (!l.ctx) plus.push(l.text);
        if (h.lastPlusNoBreak !== null) lastPlusNoBreak = h.lastPlusNoBreak;
      }
      tree.set(newP, renderFile({ lines: plus, br: '\n', finalBreak: !lastPlusNoBreak }));
      return;
    }
    if (isRemove) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.move(oldP, newP, renderFile(applyHunks(parseFile(before), sec.hunks, strict, oldP)));
      return;
    }
    const p = oldP ?? newP;
    if (p === null) return;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.set(p, renderFile(applyHunks(parseFile(before), sec.hunks, strict, p)));
  };
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks (SPEC section 7)

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    let path: string | null = null;
    for (let k = i - 1; k >= prevEnd; k--) {
      const cand = lines[k]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let eq = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.set(b.path, renderFile({ lines: [...b.newLines], br: '\n', finalBreak: b.newLines.length > 0 }));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const doc = parseFile(before);
    const found = findTier(doc.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.at.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.at[0]!;
    const o: PLine[] = b.oldLines.map((t) => ({ text: t, ctx: false }));
    const n: PLine[] = b.newLines.map((t) => ({ text: t, ctx: false }));
    const repl = buildReplacement(doc.lines, pos, o, n, found.tier);
    const lines = [...doc.lines];
    lines.splice(pos, b.oldLines.length, ...repl);
    tree.set(b.path, renderFile({ lines, br: doc.br, finalBreak: doc.finalBreak }));
  };
}

// ---------------------------------------------------------------- V4A patches (SPEC section 8)

interface VChunk {
  anchor: string | null;
  o: PLine[];
  n: PLine[];
  eof: boolean;
}

type VSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[] };

function vSecKind(l: string): 'add' | 'delete' | 'update' | null {
  if (l.startsWith('*** Add File: ')) return 'add';
  if (l.startsWith('*** Delete File: ')) return 'delete';
  if (l.startsWith('*** Update File: ')) return 'update';
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const kind = vSecKind(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = trimSpaces(l.slice(prefix.length));
    i++;
    const raw: { text: string; no: number }[] = [];
    while (i < last && vSecKind(lines[i]!) === null) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const flines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) flines.push(r.text.slice(1));
        else if (r.text === '') flines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      sections.push({ kind: 'add', path, lines: flines });
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
      }
      sections.push({ kind: 'delete', path });
    } else {
      sections.push(parseVUpdate(path, raw, headerLine));
    }
  }
  return sections.map((s) => vEdit(s, strict));
}

/** Parse the raw lines of an Update File section (trailing blanks already removed). */
function parseVUpdate(path: string, raw: { text: string; no: number }[], headerLine: number): VSection {
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; o: PLine[]; n: PLine[] } | null = null;
  let seenFirst = false;
  const closeChunk = (eof: boolean): void => {
    if (cur === null) return;
    chunks.push({ anchor: cur.anchor, o: cur.o, n: cur.n, eof });
    cur = null;
  };
  for (const r of raw) {
    const l = r.text;
    if (cur === null && blank(l)) continue;
    if (!seenFirst && cur === null && moveTo === null && l.startsWith('*** Move to: ')) {
      moveTo = trimSpaces(l.slice('*** Move to: '.length));
      continue;
    }
    if (l.startsWith('@@')) {
      closeChunk(false);
      const anchor = trimSpaces(l.slice(2));
      cur = { anchor: anchor === '' ? null : anchor, o: [], n: [] };
      seenFirst = true;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.no}`);
      closeChunk(true);
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (seenFirst) throw new Exit2(`error: parse ${r.no}`);
        cur = { anchor: null, o: [], n: [] };
        seenFirst = true;
      }
      if (l === '') {
        cur.o.push({ text: '', ctx: true });
        cur.n.push({ text: '', ctx: true });
      } else if (l.startsWith(' ')) {
        cur.o.push({ text: l.slice(1), ctx: true });
        cur.n.push({ text: l.slice(1), ctx: true });
      } else if (l.startsWith('-')) {
        cur.o.push({ text: l.slice(1), ctx: false });
      } else {
        cur.n.push({ text: l.slice(1), ctx: false });
      }
      continue;
    }
    throw new Exit2(`error: parse ${r.no}`);
  }
  closeChunk(false);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return { kind: 'update', path, moveTo, chunks };
}

/** The first line at or after `from` equal to the anchor at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(anchor, t);
    for (let i = Math.max(0, from); i < lines.length; i++) {
      if (normLine(lines[i]!, t) === want) return i;
    }
  }
  return null;
}

function vEdit(sec: VSection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.set(sec.path, renderFile({ lines: [...sec.lines], br: '\n', finalBreak: sec.lines.length > 0 }));
    };
  }
  if (sec.kind === 'delete') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.set(sec.path, null);
    };
  }
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const doc = parseFile(before);
    let lines = [...doc.lines];
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const oTexts = ch.o.map((l) => l.text);
      if (oTexts.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const repl = ch.n.map((l) => l.text);
        lines.splice(at, 0, ...repl);
        cursor = at + repl.length;
        continue;
      }
      const found = findTier(lines, oTexts, strict, cursor);
      if (found === null) throw new Fail('no-match', sec.path);
      let occ = found.at;
      if (ch.eof) occ = occ.filter((p) => p + oTexts.length === lines.length);
      if (occ.length === 0) throw new Fail('no-match', sec.path);
      const pos = occ[0]!;
      const repl = buildReplacement(lines, pos, ch.o, ch.n, found.tier);
      lines.splice(pos, oTexts.length, ...repl);
      cursor = pos + repl.length;
    }
    const out = renderFile({ lines, br: doc.br, finalBreak: doc.finalBreak });
    if (sec.moveTo !== null) tree.move(sec.path, sec.moveTo, out);
    else tree.set(sec.path, out);
  };
}

// ---------------------------------------------------------------- the run (SPEC sections 1, 2, 10)

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // Rows: one per changed path, in byte order; a move prints `R old -> new`
  // (sorted by the new path) in place of that pair's D and A lines.
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => {
    const c = Buffer.compare(Buffer.from(a.key), Buffer.from(b.key));
    return c !== 0 ? c : Buffer.compare(Buffer.from(a.line), Buffer.from(b.line));
  });
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
