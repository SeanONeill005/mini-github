// Plugin: commit history + restore. Adds a History tab (see client.js).
// Restoring never rewrites history: it adds a NEW commit whose files match the chosen commit.
const fs = require('fs');
const path = require('path');
const { git, tryGit } = require('../../core/git');

const PAGE = 30;

module.exports = app => {
  const { httpError } = app;
  const reposDir = path.join(app.dataDir, 'repos');
  const author = app.config.author || { name: 'you', email: 'you@forge.local' };
  const authorFor = user => (user ? { name: user.username, email: user.email } : author);

  function repoDir(name) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name || '') || name.endsWith('.git')) throw httpError(400, 'Invalid repository name');
    const dir = path.join(reposDir, name + '.git');
    if (!fs.existsSync(dir)) throw httpError(404, 'Repository not found');
    return dir;
  }
  function validRef(ref) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref || '') || ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) throw httpError(400, 'Invalid branch name');
    return ref;
  }
  const validSha = sha => { if (!/^[0-9a-f]{40}$/.test(sha || '')) throw httpError(400, 'Invalid commit id'); return sha; };

  async function head(dir, ref) {
    const sha = await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${validRef(ref)}^{commit}`], { gitDir: dir });
    if (!sha) throw httpError(404, 'Branch not found');
    return sha.trim();
  }
  // The commit must exist and be part of this branch's history.
  async function onBranch(dir, branchHead, sha) {
    if (await tryGit(['merge-base', '--is-ancestor', validSha(sha), branchHead], { gitDir: dir }) === null) {
      throw httpError(404, 'Commit not found on this branch');
    }
  }

  // GET /api/repos/:name/history?ref=main&skip=0  ->  { commits: [...], hasMore }
  app.route('GET', '/api/repos/:name/history', async ({ params, query }) => {
    const dir = repoDir(params.name);
    const tip = await head(dir, query.get('ref') || 'main');
    const skip = Math.max(0, parseInt(query.get('skip'), 10) || 0);
    const out = await git(['log', `--skip=${skip}`, '-n', String(PAGE + 1), '--format=%H%x1f%an%x1f%aI%x1f%s%x1f%P', tip], { gitDir: dir });
    const rows = out.split('\n').filter(Boolean).map(l => {
      const [sha, by, date, message, parents] = l.split('\x1f');
      return { sha, short: sha.slice(0, 7), by, date, message, merge: parents.split(' ').filter(Boolean).length > 1 };
    });
    return { commits: rows.slice(0, PAGE), hasMore: rows.length > PAGE, head: tip };
  });

  // What to compare a commit against: its (first) parent, or the empty tree for the very first commit.
  // A merge is therefore shown as what it brought into the branch.
  async function diffBase(dir, sha) {
    const parents = (await git(['rev-list', '--parents', '-n', '1', sha], { gitDir: dir })).trim().split(' ').slice(1);
    return parents.length ? [parents[0], sha] : ['--root', sha];
  }

  // GET /api/repos/:name/commits/:sha?ref=main  ->  the changelog: message, and per file status + lines added/deleted
  app.route('GET', '/api/repos/:name/commits/:sha', async ({ params, query }) => {
    const dir = repoDir(params.name);
    await onBranch(dir, await head(dir, query.get('ref') || 'main'), params.sha);
    const base = await diffBase(dir, params.sha);
    const dt = flag => git(['diff-tree', '-r', '-z', '--no-commit-id', flag, ...base], { gitDir: dir });
    const [names, nums, meta] = await Promise.all([
      dt('--name-status'), dt('--numstat'),
      git(['log', '-1', '--format=%an%x1f%aI%x1f%B', params.sha], { gitDir: dir }),
    ]);
    // numstat -z records are "added<TAB>deleted<TAB>path" ("-" for binary files); renames are off, so one record per file.
    const counts = new Map();
    for (const rec of nums.split('\0').filter(Boolean)) {
      const [a, d, ...p] = rec.split('\t');
      counts.set(p.join('\t'), { binary: a === '-', additions: a === '-' ? 0 : +a, deletions: d === '-' ? 0 : +d });
    }
    const parts = names.split('\0').filter(Boolean), files = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      files.push({ status: parts[i][0], path: parts[i + 1], binary: false, additions: 0, deletions: 0, ...counts.get(parts[i + 1]) });
    }
    const [by, date, ...msg] = meta.split('\x1f');
    const [subject, ...rest] = msg.join('\x1f').replace(/\s+$/, '').split('\n');
    return {
      sha: params.sha, by, date, subject, body: rest.join('\n').trim(), files,
      additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0),
    };
  });

  // GET /api/repos/:name/commits/:sha/diff?path=src/a.js&ref=main
  //   -> { path, binary, truncated, lines: [{ t: ' ' | '+' | '-', o: oldLine, n: newLine, s: text }] }
  // Always the WHOLE file with every changed line marked, so the client can show the full contents or fold
  // the unchanged parts away. Long files are cut at MAX_LINES.
  const MAX_LINES = 5000;
  app.route('GET', '/api/repos/:name/commits/:sha/diff', async ({ params, query }) => {
    const dir = repoDir(params.name);
    await onBranch(dir, await head(dir, query.get('ref') || 'main'), params.sha);
    const file = String(query.get('path') || '');
    if (!file) throw httpError(400, 'File path required');
    if (file.includes('\0') || file.startsWith('/') || file.split('/').some(s => s === '' || s === '.' || s === '..')) throw httpError(400, 'Invalid path');
    const base = await diffBase(dir, params.sha);
    const out = await git([
      '--literal-pathspecs', 'diff-tree', '-p', '--no-color', '--no-ext-diff', '--no-textconv', '-U1000000',
      '-r', '--no-commit-id', ...base, '--', file,
    ], { gitDir: dir });

    const lines = [];
    let o = 0, n = 0, inHunk = false, binary = false, truncated = false;
    for (const l of out.split('\n')) {
      if (!inHunk && (l.startsWith('Binary files') || l.startsWith('GIT binary patch'))) { binary = true; break; }
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (h) { o = +h[1]; n = +h[2]; inHunk = true; continue; }
      if (!inHunk || l === '' || l[0] === '\\') continue; // header lines, and "\ No newline at end of file"
      if (lines.length >= MAX_LINES) { truncated = true; break; }
      const s = l.slice(1).replace(/\r$/, '');
      if (l[0] === '+') lines.push({ t: '+', n: n++, s });
      else if (l[0] === '-') lines.push({ t: '-', o: o++, s });
      else lines.push({ t: ' ', o: o++, n: n++, s });
    }
    return { path: file, binary, truncated, lines };
  });

  // POST /api/repos/:name/restore { ref, sha }  ->  { sha }   (new commit on top of the branch)
  app.route('POST', '/api/repos/:name/restore', async ({ params, body, user }) => {
    const dir = repoDir(params.name);
    const branch = validRef(body.ref || 'main');
    const tip = await head(dir, branch);
    const target = validSha(body.sha);
    await onBranch(dir, tip, target);
    if (target === tip) throw httpError(400, 'That is already the latest commit');

    const subject = (await git(['log', '-1', '--format=%s', target], { gitDir: dir })).trim();
    const tree = (await git(['rev-parse', `${target}^{tree}`], { gitDir: dir })).trim();
    if (tree === (await git(['rev-parse', `${tip}^{tree}`], { gitDir: dir })).trim()) throw httpError(400, 'Branch already matches that commit');

    const who = authorFor(user);
    const env = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
    const commit = (await git(['commit-tree', tree, '-p', tip, '-m', `Restore to ${target.slice(0, 7)}: ${subject}`], { gitDir: dir, env })).trim();
    // Compare-and-swap: fails if someone committed to the branch in the meantime.
    await git(['update-ref', `refs/heads/${branch}`, commit, tip], { gitDir: dir }).catch(() => { throw httpError(409, 'Branch changed while restoring; reload and try again'); });
    await app.emit('commit', { repo: params.name, branch, sha: commit, path: null });
    return { sha: commit };
  });
};
