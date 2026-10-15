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

  // GET /api/repos/:name/commits/:sha?ref=main  ->  files changed by that commit
  app.route('GET', '/api/repos/:name/commits/:sha', async ({ params, query }) => {
    const dir = repoDir(params.name);
    await onBranch(dir, await head(dir, query.get('ref') || 'main'), params.sha);
    const out = await git(['diff-tree', '--root', '-r', '-z', '--no-commit-id', '--name-status', params.sha], { gitDir: dir });
    const parts = out.split('\0').filter(Boolean), files = [];
    for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i][0], path: parts[i + 1] }); // renames are off by default, so pairs are stable
    return { sha: params.sha, files };
  });

  // POST /api/repos/:name/restore { ref, sha }  ->  { sha }   (new commit on top of the branch)
  app.route('POST', '/api/repos/:name/restore', async ({ params, body }) => {
    const dir = repoDir(params.name);
    const branch = validRef(body.ref || 'main');
    const tip = await head(dir, branch);
    const target = validSha(body.sha);
    await onBranch(dir, tip, target);
    if (target === tip) throw httpError(400, 'That is already the latest commit');

    const subject = (await git(['log', '-1', '--format=%s', target], { gitDir: dir })).trim();
    const tree = (await git(['rev-parse', `${target}^{tree}`], { gitDir: dir })).trim();
    if (tree === (await git(['rev-parse', `${tip}^{tree}`], { gitDir: dir })).trim()) throw httpError(400, 'Branch already matches that commit');

    const env = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
    const commit = (await git(['commit-tree', tree, '-p', tip, '-m', `Restore to ${target.slice(0, 7)}: ${subject}`], { gitDir: dir, env })).trim();
    // Compare-and-swap: fails if someone committed to the branch in the meantime.
    await git(['update-ref', `refs/heads/${branch}`, commit, tip], { gitDir: dir }).catch(() => { throw httpError(409, 'Branch changed while restoring; reload and try again'); });
    await app.emit('commit', { repo: params.name, branch, sha: commit, path: null });
    return { sha: commit };
  });
};
