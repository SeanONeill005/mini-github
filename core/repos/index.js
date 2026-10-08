// Core plugin: repositories, branches, trees, files and history, backed by real bare git repos.
const fs = require('fs');
const path = require('path');
const { git, tryGit, commitFile } = require('../git');

module.exports = app => {
  const { httpError } = app;
  const reposDir = path.join(app.dataDir, 'repos');
  const author = app.config.author || { name: 'you', email: 'you@forge.local' };
  fs.mkdirSync(reposDir, { recursive: true });

  const gitDir = name => path.join(reposDir, name + '.git');

  function validName(name) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name || '') || name.endsWith('.git')) throw httpError(400, 'Invalid repository name');
    return name;
  }
  function validRef(ref) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref || '') || ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) throw httpError(400, 'Invalid branch name');
    return ref;
  }
  function cleanPath(p = '') {
    const parts = p.split('/').filter(Boolean);
    if (parts.some(s => s === '.' || s === '..' || s === '.git')) throw httpError(400, 'Invalid path');
    return parts.join('/');
  }
  function existing(name) {
    validName(name);
    if (!fs.existsSync(gitDir(name))) throw httpError(404, 'Repository not found');
    return gitDir(name);
  }
  async function resolve(dir, ref) {
    const sha = await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${validRef(ref)}^{commit}`], { gitDir: dir });
    if (!sha) throw httpError(404, 'Branch not found');
    return sha.trim();
  }

  async function describe(name) {
    const dir = gitDir(name);
    const desc = fs.readFileSync(path.join(dir, 'description'), 'utf8').trim();
    return app.decorated('repo', {
      name,
      description: desc.startsWith('Unnamed repository') ? '' : desc,
      defaultBranch: 'main',
    });
  }

  app.route('GET', '/api/repos', async () => {
    const names = fs.readdirSync(reposDir).filter(f => f.endsWith('.git')).map(f => f.slice(0, -4));
    return Promise.all(names.map(describe));
  });

  app.route('POST', '/api/repos', async ({ body }) => {
    const name = validName(String(body.name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-'));
    if (fs.existsSync(gitDir(name))) throw httpError(409, `A repository named "${name}" already exists`);
    const description = String(body.description || '').trim();
    await git(['init', '--bare', '-b', 'main', gitDir(name)]);
    fs.writeFileSync(path.join(gitDir(name), 'description'), description || 'Unnamed repository');
    await commitFile(gitDir(name), {
      branch: 'main', filePath: 'README.md', author, message: 'Initial commit',
      content: `# ${name}\n\n${description || 'Add a description to your project.'}\n`,
    });
    const repo = await describe(name);
    await app.emit('repo:created', repo);
    return repo;
  });

  app.route('GET', '/api/repos/:name', async ({ params }) => { existing(params.name); return describe(params.name); });

  app.route('GET', '/api/repos/:name/branches', async ({ params }) => {
    const out = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { gitDir: existing(params.name) });
    return out.split('\n').filter(Boolean);
  });

  app.route('POST', '/api/repos/:name/branches', async ({ params, body }) => {
    const dir = existing(params.name);
    const name = validRef(String(body.name || '').trim().toLowerCase().replace(/[^a-z0-9._/-]+/g, '-'));
    if (await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { gitDir: dir })) throw httpError(409, `Branch "${name}" already exists`);
    await git(['update-ref', `refs/heads/${name}`, await resolve(dir, body.from || 'main')], { gitDir: dir });
    return { name };
  });

  app.route('DELETE', '/api/repos/:name/branches/:branch', async ({ params }) => {
    const dir = existing(params.name);
    if (params.branch === 'main') throw httpError(400, 'Cannot delete the default branch');
    await resolve(dir, params.branch);
    await git(['update-ref', '-d', `refs/heads/${params.branch}`], { gitDir: dir });
  });

  app.route('GET', '/api/repos/:name/tree', async ({ params, query }) => {
    const dir = existing(params.name);
    const sha = await resolve(dir, query.get('ref') || 'main');
    const out = await git(['ls-tree', '-z', `${sha}:${cleanPath(query.get('path') || '')}`], { gitDir: dir }).catch(() => { throw httpError(404, 'Path not found'); });
    return out.split('\0').filter(Boolean).map(line => {
      const [meta, name] = line.split('\t');
      return { name, type: meta.split(' ')[1] === 'tree' ? 'dir' : 'file' };
    });
  });

  app.route('GET', '/api/repos/:name/blob', async ({ params, query }) => {
    const dir = existing(params.name);
    const spec = `${await resolve(dir, query.get('ref') || 'main')}:${cleanPath(query.get('path'))}`;
    if ((await tryGit(['cat-file', '-t', spec], { gitDir: dir }))?.trim() !== 'blob') throw httpError(404, 'File not found');
    return { content: await git(['cat-file', 'blob', spec], { gitDir: dir }) };
  });

  app.route('GET', '/api/repos/:name/log', async ({ params, query }) => {
    const dir = existing(params.name);
    const out = await git(['log', '-n', '50', '--format=%H%x1f%an%x1f%aI%x1f%s', await resolve(dir, query.get('ref') || 'main')], { gitDir: dir });
    return out.split('\n').filter(Boolean).map(l => {
      const [sha, by, date, message] = l.split('\x1f');
      return { sha, by, date, message };
    });
  });

  // Create or update a file on a branch as a single commit.
  app.route('PUT', '/api/repos/:name/file', async ({ params, body }) => {
    const dir = existing(params.name);
    const filePath = cleanPath(body.path);
    if (!filePath) throw httpError(400, 'File name required');
    const branch = validRef(body.ref || 'main');
    const head = await resolve(dir, branch);
    if (body.isNew && await tryGit(['cat-file', '-e', `${head}:${filePath}`], { gitDir: dir }) !== null) {
      throw httpError(409, `"${filePath}" already exists on ${branch}`);
    }
    const sha = await commitFile(dir, {
      branch, filePath, author,
      content: String(body.content ?? ''),
      message: String(body.message || '').trim() || `${body.isNew ? 'Add' : 'Update'} ${filePath.split('/').pop()}`,
    });
    await app.emit('commit', { repo: params.name, branch, sha, path: filePath });
    return { sha };
  });
};
