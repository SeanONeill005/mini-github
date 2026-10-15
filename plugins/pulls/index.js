// Plugin: branch merging + pull requests.
// Merges are computed with `git merge-tree`, so no working tree is needed, and are recorded as real merge commits.
// PR metadata (title, state, branches) lives in the plugin store; the commits/diff are always read from git.
// Permissions: every write route here is owner-only through the auth plugin's deny-by-default guard.
const fs = require('fs');
const path = require('path');
const { git, gitResult, tryGit } = require('../../core/git');

const MAX_DIFF = 300 * 1024;

module.exports = app => {
  const { httpError } = app;
  const reposDir = path.join(app.dataDir, 'repos');
  const fallbackAuthor = app.config.author || { name: 'you', email: 'you@forge.local' };
  // Merge commits and PRs are attributed to the logged-in user (same rule as web commits in core/repos).
  const authorFor = user => (user ? { name: user.username, email: user.email } : fallbackAuthor);
  const store = app.store('pulls');
  const all = repo => store.get(repo, []);

  app.decorate('repo', repo => ({ openPulls: all(repo.name).filter(p => p.state === 'open').length }));

  // ---------- validation ----------
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
  async function branchSha(dir, ref) {
    const sha = await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${validRef(ref)}^{commit}`], { gitDir: dir });
    if (!sha) throw httpError(404, `Branch "${ref}" not found`);
    return sha.trim();
  }
  const tryBranch = (dir, ref) => branchSha(dir, ref).catch(() => null);
  const text = (v, max) => String(v ?? '').trim().slice(0, max);

  function findPull(repo, id) {
    const pr = all(repo).find(p => p.id === Number(id));
    if (!pr) throw httpError(404, 'Pull request not found');
    return pr;
  }
  function updatePull(repo, id, patch) {
    const list = all(repo), pr = list.find(p => p.id === id);
    Object.assign(pr, patch, { updated: new Date().toISOString() });
    store.set(repo, list);
    return pr;
  }

  // ---------- git helpers ----------
  // How two commits relate, and whether merging head into base would conflict.
  async function compareShas(dir, baseSha, headSha) {
    const [behind, ahead] = (await git(['rev-list', '--left-right', '--count', `${baseSha}...${headSha}`], { gitDir: dir })).trim().split(/\s+/).map(Number);
    const info = { baseSha, headSha, ahead, behind, mergeable: false, upToDate: false, unrelated: false, conflicts: [], tree: null };
    if (!(await tryGit(['merge-base', baseSha, headSha], { gitDir: dir }))?.trim()) return { ...info, unrelated: true };
    if (ahead === 0) return { ...info, upToDate: true, mergeable: true };

    const r = await gitResult(['merge-tree', '--write-tree', '--name-only', baseSha, headSha], { gitDir: dir });
    if (r.code !== 0 && r.code !== 1) throw new Error(r.err || 'merge-tree failed');
    const lines = r.out.split('\n');
    info.tree = lines[0].trim();
    if (r.code === 1) {
      // Output: tree id, conflicted file names, blank line, informational messages.
      const end = lines.indexOf('', 1);
      info.conflicts = [...new Set(lines.slice(1, end < 0 ? undefined : end).filter(Boolean))];
      return info;
    }
    return { ...info, mergeable: true };
  }
  const publicStatus = ({ tree, ...rest }) => rest;

  // Merge `headSha` into branch `base` as a merge commit. Throws if there is nothing to merge or it conflicts.
  async function mergeInto(dir, base, headSha, message, who) {
    const baseSha = await branchSha(dir, base);
    const cmp = await compareShas(dir, baseSha, headSha);
    if (cmp.unrelated) throw httpError(409, 'These branches have no common history');
    if (cmp.upToDate) throw httpError(400, `Nothing to merge: ${base} already contains these commits`);
    if (!cmp.mergeable) throw httpError(409, `Merge conflicts in: ${cmp.conflicts.join(', ')}`);
    const env = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
    const sha = (await git(['commit-tree', cmp.tree, '-p', baseSha, '-p', headSha, '-m', message], { gitDir: dir, env })).trim();
    // Compare-and-swap: fails if the branch moved while we were merging.
    await git(['update-ref', `refs/heads/${base}`, sha, baseSha], { gitDir: dir })
      .catch(() => { throw httpError(409, `${base} changed while merging; reload and try again`); });
    return { sha, baseSha, headSha };
  }

  // Commits, changed files and unified diff for baseSha...headSha.
  async function details(dir, baseSha, headSha) {
    const log = await tryGit(['log', '-n', '100', '--format=%H%x1f%an%x1f%aI%x1f%s', `${baseSha}..${headSha}`], { gitDir: dir }) ?? '';
    const commits = log.split('\n').filter(Boolean).map(l => {
      const [sha, by, date, message] = l.split('\x1f');
      return { sha, short: sha.slice(0, 7), by, date, message };
    });
    const range = `${baseSha}...${headSha}`;
    const names = (await tryGit(['diff', '--no-renames', '--name-status', '-z', range], { gitDir: dir }) ?? '').split('\0').filter(Boolean);
    const files = [];
    for (let i = 0; i + 1 < names.length; i += 2) files.push({ status: names[i][0], path: names[i + 1] });
    let diff = await tryGit(['diff', '--no-renames', '--no-color', '-U3', range], { gitDir: dir }) ?? '';
    const truncated = diff.length > MAX_DIFF;
    if (truncated) diff = diff.slice(0, MAX_DIFF);
    return { commits, files, diff, truncated };
  }

  function markMerged(repo, pr, { sha, baseSha, headSha }, by) {
    const out = updatePull(repo, pr.id, { state: 'merged', mergeSha: sha, baseSha, headSha, mergedBy: by, mergedAt: new Date().toISOString() });
    app.emit('pull:merged', { repo, pull: out });
    return out;
  }

  // ---------- branch comparison + direct merge ----------
  app.route('GET', '/api/repos/:name/compare', async ({ params, query }) => {
    const dir = repoDir(params.name);
    const base = query.get('base'), head = query.get('head');
    return publicStatus(await compareShas(dir, await branchSha(dir, base), await branchSha(dir, head)));
  });

  // POST { from, into }: merge branch `from` into branch `into`.
  app.route('POST', '/api/repos/:name/merge', async ({ params, body, user }) => {
    const dir = repoDir(params.name);
    const from = validRef(body.from), into = validRef(body.into);
    if (from === into) throw httpError(400, 'Choose two different branches');
    const headSha = await branchSha(dir, from);
    const result = await mergeInto(dir, into, headSha, `Merge branch '${from}' into ${into}`, authorFor(user));
    app.emit('commit', { repo: params.name, branch: into, sha: result.sha, path: null, by: user?.username });
    // Any open PR for this exact pair is now merged too.
    for (const pr of all(params.name)) if (pr.state === 'open' && pr.head === from && pr.base === into) markMerged(params.name, pr, result, user?.username);
    return { sha: result.sha };
  });

  // ---------- pull requests ----------
  app.route('GET', '/api/repos/:name/pulls', ({ params }) => {
    repoDir(params.name);
    return [...all(params.name)].reverse();
  });

  app.route('POST', '/api/repos/:name/pulls', async ({ params, body, user }) => {
    const dir = repoDir(params.name);
    const base = validRef(body.base || 'main'), head = validRef(body.head);
    if (base === head) throw httpError(400, 'Choose two different branches');
    const cmp = await compareShas(dir, await branchSha(dir, base), await branchSha(dir, head));
    if (cmp.unrelated) throw httpError(400, 'These branches have no common history');
    if (cmp.upToDate) throw httpError(400, `Nothing to compare: ${base} already contains every commit on ${head}`);
    const list = all(params.name);
    if (list.some(p => p.state === 'open' && p.base === base && p.head === head)) throw httpError(409, `An open pull request for ${head} → ${base} already exists`);
    const title = text(body.title, 200) || head;
    const now = new Date().toISOString();
    const pr = { id: Math.max(0, ...list.map(p => p.id)) + 1, title, body: text(body.body, 10000), base, head, state: 'open', by: user?.username || fallbackAuthor.name, created: now, updated: now };
    store.set(params.name, [...list, pr]);
    app.emit('pull:created', { repo: params.name, pull: pr });
    return pr;
  });

  app.route('GET', '/api/repos/:name/pulls/:id', async ({ params }) => {
    const dir = repoDir(params.name);
    const pr = findPull(params.name, params.id);
    if (pr.state !== 'open') return { ...pr, ...(await details(dir, pr.baseSha, pr.headSha)), status: null, problem: null };

    const [baseSha, headSha] = await Promise.all([tryBranch(dir, pr.base), tryBranch(dir, pr.head)]);
    const missing = !baseSha ? pr.base : !headSha ? pr.head : null;
    if (missing) return { ...pr, commits: [], files: [], diff: '', truncated: false, status: null, problem: `Branch "${missing}" no longer exists` };
    const status = await compareShas(dir, baseSha, headSha);
    return { ...pr, ...(await details(dir, baseSha, headSha)), status: publicStatus(status), problem: null };
  });

  // PATCH { title?, body?, state?: 'open' | 'closed' }
  app.route('PATCH', '/api/repos/:name/pulls/:id', async ({ params, body }) => {
    const dir = repoDir(params.name);
    const pr = findPull(params.name, params.id);
    const patch = {};
    if (body.title !== undefined) patch.title = text(body.title, 200) || pr.title;
    if (body.body !== undefined) patch.body = text(body.body, 10000);

    if (body.state !== undefined && body.state !== pr.state) {
      if (pr.state === 'merged') throw httpError(400, 'A merged pull request cannot be changed');
      if (body.state === 'closed') {
        const [baseSha, headSha] = await Promise.all([tryBranch(dir, pr.base), tryBranch(dir, pr.head)]);
        Object.assign(patch, { state: 'closed', baseSha: baseSha || pr.baseSha, headSha: headSha || pr.headSha, closedAt: new Date().toISOString() });
        if (!patch.baseSha || !patch.headSha) throw httpError(409, 'Cannot close: a branch was deleted');
      } else if (body.state === 'open') {
        await branchSha(dir, pr.base); await branchSha(dir, pr.head);
        if (all(params.name).some(p => p.id !== pr.id && p.state === 'open' && p.base === pr.base && p.head === pr.head)) throw httpError(409, 'Another open pull request already covers these branches');
        Object.assign(patch, { state: 'open', baseSha: undefined, headSha: undefined, closedAt: undefined });
      } else throw httpError(400, 'state must be "open" or "closed"');
    }
    return updatePull(params.name, pr.id, patch);
  });

  // POST { deleteBranch?: boolean }
  app.route('POST', '/api/repos/:name/pulls/:id/merge', async ({ params, body, user }) => {
    const dir = repoDir(params.name);
    const pr = findPull(params.name, params.id);
    if (pr.state !== 'open') throw httpError(400, `This pull request is ${pr.state}`);
    const headSha = await branchSha(dir, pr.head);
    const result = await mergeInto(dir, pr.base, headSha, `Merge pull request #${pr.id} from ${pr.head}\n\n${pr.title}`, authorFor(user));
    app.emit('commit', { repo: params.name, branch: pr.base, sha: result.sha, path: null, by: user?.username });
    const merged = markMerged(params.name, pr, result, user?.username);
    if (body?.deleteBranch && pr.head !== 'main' && pr.head !== pr.base) {
      await git(['update-ref', '-d', `refs/heads/${pr.head}`], { gitDir: dir });
    }
    return merged;
  });
};
