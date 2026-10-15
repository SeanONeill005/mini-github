// Thin wrapper over the git CLI, using plumbing commands so no working tree is needed.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Runs git and always resolves with { code, out, err } (use when a non-zero exit is meaningful, e.g. merge-tree conflicts).
function gitResult(args, { gitDir, input, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { env: { ...process.env, ...(gitDir && { GIT_DIR: gitDir }), ...env } });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.stdin.on('error', () => {}); // git may exit before reading stdin (EPIPE); the exit code tells the story
    p.on('close', code => resolve({ code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString().trim() }));
    p.stdin.end(input ?? '');
  });
}

// Like gitResult, but rejects on a non-zero exit and resolves with stdout.
const git = (args, opts) => gitResult(args, opts).then(r => {
  if (r.code !== 0) throw new Error(r.err || 'git failed');
  return r.out;
});

const tryGit = (...a) => git(...a).catch(() => null);

// Write one file to a branch as a new commit, without touching any working directory.
async function commitFile(gitDir, { branch, filePath, content, message, author }) {
  const parent = (await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { gitDir }))?.trim();
  const index = path.join(os.tmpdir(), 'forge-idx-' + Math.random().toString(36).slice(2));
  const env = {
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
  };
  try {
    if (parent) await git(['read-tree', parent], { gitDir, env });
    const blob = (await git(['hash-object', '-w', '--stdin'], { gitDir, input: content })).trim();
    await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${filePath}`], { gitDir, env });
    const tree = (await git(['write-tree'], { gitDir, env })).trim();
    const commit = (await git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { gitDir, env })).trim();
    await git(['update-ref', `refs/heads/${branch}`, commit], { gitDir });
    return commit;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

module.exports = { git, gitResult, tryGit, commitFile };
