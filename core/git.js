// Thin wrapper over the git CLI, using plumbing commands so no working tree is needed.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function git(args, { gitDir, input, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { env: { ...process.env, ...(gitDir && { GIT_DIR: gitDir }), ...env } });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.on('close', code => code === 0
      ? resolve(Buffer.concat(out).toString('utf8'))
      : reject(new Error(Buffer.concat(err).toString().trim() || 'git failed')));
    p.stdin.end(input ?? '');
  });
}

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

module.exports = { git, tryGit, commitFile };
