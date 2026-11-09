// Knowledge index for the Codex crystal at the galactic center.
//
// Lists what the owner's sessions have learned and saved on this Mac:
//   memory     ~/.claude/projects/<folder>/memory/*.md   (not the MEMORY.md index)
//   skill      ~/.claude/skills/<name>/SKILL.md
//   rules      CLAUDE.md at the root of each known project
//   decisions  DECISIONS.md / *playbook*.md in a project or its docs/ folder
//   kit        rows of ~/.claude/kit.md (mods, connectors, apps, local copies,
//              scheduled tasks, plugins, tools; skills are already counted above)
//
// READ-ONLY. Only names, one-line descriptions (frontmatter `description`, else
// the first heading) and modification times leave this module; never file bodies.
// Results are cached for CACHE_S so the endpoint stays cheap.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CACHE_S = 30;
const MAX_ITEMS = 600;
const HEAD_BYTES = 4096;

/** Read the start of a file and pull out name / description. */
function headOf(file) {
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      text = buf.toString('utf8', 0, n);
    } finally { fs.closeSync(fd); }
  } catch { return {}; }
  const out = {};
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (fm) {
    const name = /^name:\s*(.+)$/m.exec(fm[1]);
    const desc = /^description:\s*(.+)$/m.exec(fm[1]);
    if (name) out.name = clean(name[1]);
    if (desc) out.description = clean(desc[1]);
  }
  if (!out.description) {
    const h = /^#\s+(.+)$/m.exec(fm ? text.slice(fm[0].length) : text);
    if (h) out.description = clean(h[1]);
  }
  return out;
}
function clean(s) {
  return String(s).trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').slice(0, 200);
}
function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs / 1000; } catch { return null; }
}
function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
/** Claude Code names a project folder after its cwd with every non-alphanumeric char as '-'. */
export function encodeProjectDir(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * createKnowledge({ claudeHome, projectRoots }) -> { list() }
 * projectRoots: () => array of absolute project folders (the galaxy's arm keys).
 */
export function createKnowledge({ claudeHome = path.join(os.homedir(), '.claude'), projectRoots = () => [], clock = () => Date.now() / 1000 } = {}) {
  let cache = null;
  let cacheAt = -Infinity;

  function projectFor(folderName, roots) {
    for (const r of roots) if (encodeProjectDir(r) === folderName) return r;
    return null;
  }

  let lastRoots = 0;
  function scan() {
    const roots = [...new Set(projectRoots().filter((r) => typeof r === 'string' && r.startsWith('/')))];
    lastRoots = roots.length;
    const items = [];
    const add = (kind, file, project, fallbackName) => {
      const mt = mtimeOf(file);
      if (mt == null) return;
      const h = headOf(file);
      items.push({
        id: `${kind}:${file}`,
        kind,
        name: h.name || fallbackName,
        description: h.description || '',
        project: project || null,
        projectName: project ? path.basename(project) : null,
        mtime: mt,
        path: file,
      });
    };

    // Memories, per project folder.
    const projectsDir = path.join(claudeHome, 'projects');
    for (const d of listDir(projectsDir)) {
      if (!d.isDirectory()) continue;
      const memDir = path.join(projectsDir, d.name, 'memory');
      const project = projectFor(d.name, roots);
      for (const f of listDir(memDir)) {
        if (!f.isFile() || !f.name.endsWith('.md') || f.name === 'MEMORY.md') continue;
        add('memory', path.join(memDir, f.name), project, f.name.replace(/\.md$/, ''));
      }
    }
    // Skills (global).
    const skillsDir = path.join(claudeHome, 'skills');
    for (const d of listDir(skillsDir)) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      const f = path.join(skillsDir, d.name, 'SKILL.md');
      if (fs.existsSync(f)) add('skill', f, null, d.name);
    }
    // Project rules and decision logs.
    for (const r of roots) {
      const rules = path.join(r, 'CLAUDE.md');
      if (fs.existsSync(rules)) add('rules', rules, r, `${path.basename(r)} rules`);
      for (const dir of [r, path.join(r, 'docs')]) {
        for (const f of listDir(dir)) {
          if (!f.isFile()) continue;
          if (f.name === 'DECISIONS.md' || /playbook.*\.md$/i.test(f.name)) add('decisions', path.join(dir, f.name), r, f.name.replace(/\.md$/, ''));
        }
      }
    }
    // Kit registry: one shard per installed thing that is not a skill.
    const kitFile = path.join(claudeHome, 'kit.md');
    let kitText = '';
    try { kitText = fs.readFileSync(kitFile, 'utf8'); } catch { /* no kit yet */ }
    for (const line of kitText.split('\n')) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 6 || !cells[1] || cells[1] === 'Name' || /^-+$/.test(cells[1])) continue;
      const [name, kind, added, why] = [cells[1], cells[2].toLowerCase(), cells[3], cells[4]];
      if (kind === 'skill') continue;
      const t = Date.parse(added);
      items.push({
        id: `kit:${name}`, kind: 'kit', name: clean(name), description: clean(`${kind}: ${why}`),
        project: null, projectName: null, mtime: Number.isFinite(t) ? t / 1000 + 43200 : null, path: kitFile,
      });
    }
    // De-duplicate (a project nested in another can list the same file twice).
    const seen = new Set();
    const out = items.filter((it) => (seen.has(it.id) ? false : seen.add(it.id)));
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, MAX_ITEMS);
  }

  return {
    /** `fresh` rescans now (at most every 2 s), e.g. right after a session saved knowledge. */
    list({ fresh = false } = {}) {
      const now = clock();
      // Before the sessions have loaded there are no project folders yet: rescan soon instead of caching.
      const maxAge = fresh || lastRoots === 0 ? 2 : CACHE_S;
      if (!cache || now - cacheAt > maxAge) { cache = scan(); cacheAt = now; }
      const counts = { memory: 0, skill: 0, rules: 0, decisions: 0, kit: 0 };
      for (const it of cache) counts[it.kind]++;
      return { asOf: cacheAt, counts, items: cache };
    },
  };
}
