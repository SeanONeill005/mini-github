// Accounts for Forge: sign up / log in (cookie sessions), personal access tokens for `git push`,
// and ownership rules for anything that writes.
//
// Rules:
//   - reading stays public (browse, clone)
//   - every other /api write needs a logged-in user
//   - writing to a repo (commit a file, create/delete branches, git push) needs to be its owner
//   - repos that existed before accounts belong to the first account that signs up
//
// config.json (optional): { "registration": false } closes sign-up once your own account exists.
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

module.exports = app => {
  const { httpError } = app;
  const store = app.store('auth');

  const COOKIE = 'forge_session';
  const SESSION_MS = 30 * 24 * 3600 * 1000;
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  const secret = prefix => prefix + crypto.randomBytes(32).toString('base64url');

  // ---------- data (only hashes of passwords and tokens are ever stored) ----------
  const users = () => store.get('users', {});
  const sessions = () => store.get('sessions', {});
  const tokens = () => store.get('tokens', {});
  const ownerOf = repo => store.get('owners', {})[repo] || store.get('admin', null);

  async function hashPassword(password, salt = crypto.randomBytes(16)) {
    return { salt: salt.toString('hex'), hash: (await scrypt(password, salt, 64)).toString('hex') };
  }
  async function checkPassword(user, password) {
    // Unknown users still pay the scrypt cost so response time doesn't reveal which usernames exist.
    const rec = user || { salt: '00'.repeat(16), hash: '00'.repeat(64) };
    const { hash } = await hashPassword(password, Buffer.from(rec.salt, 'hex'));
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(rec.hash, 'hex')) && !!user;
  }

  // ---------- who is calling? ----------
  const publicUser = (username, via) => ({ username, email: users()[username]?.email, via });

  function cookieToken(req) {
    for (const part of (req.headers.cookie || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  }

  // Accepts: a session cookie (browser), `Authorization: Bearer <token>` (scripts),
  // or HTTP Basic with the token as the password (git).
  app.identify(req => {
    const auth = req.headers.authorization || '';
    let token = null, claimed = null;
    if (auth.startsWith('Bearer ')) token = auth.slice(7).trim();
    else if (auth.startsWith('Basic ')) {
      const [name, ...pw] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      claimed = name; token = pw.join(':');
    }
    if (token) {
      const rec = tokens()[sha(token)];
      if (rec && users()[rec.user] && (!claimed || claimed.toLowerCase() === rec.user)) return publicUser(rec.user, 'token');
      return null;
    }
    const sid = cookieToken(req);
    const s = sid && sessions()[sha(sid)];
    return s && s.expires > Date.now() && users()[s.user] ? publicUser(s.user, 'session') : null;
  });

  app.can = (user, action, repo) => !!user && action === 'push' && ownerOf(repo) === user.username;

  // ---------- guards ----------
  const REPO_WRITE = /^\/api\/repos\/[^/]+\/(file|branches)(\/|$)/;

  app.before(({ req, method, pathname, params, user }) => {
    if (method === 'GET') return;
    // A browser on another site can't make us act on its behalf: cookie requests must come from this origin.
    const origin = req.headers.origin;
    if (origin && !req.headers.authorization) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* Origin: null */ }
      if (host !== req.headers.host) throw httpError(403, 'Cross-site request refused');
    }
    if (pathname.startsWith('/api/auth/')) return; // these check for themselves
    if (!user) throw httpError(401, 'Log in to do that');
    if (REPO_WRITE.test(pathname) && !app.can(user, 'push', params.name)) {
      throw httpError(403, `Only ${ownerOf(params.name)} can change ${params.name}`);
    }
  });

  app.decorate('repo', repo => ({ owner: ownerOf(repo.name) }));

  app.on('repo:created', repo => {
    if (!repo.creator) return;
    const owners = store.get('owners', {});
    owners[repo.name] = repo.creator;
    store.set('owners', owners);
  });

  // ---------- sessions ----------
  function startSession(req, res, username) {
    const all = sessions(), now = Date.now();
    for (const [k, s] of Object.entries(all)) if (s.expires < now) delete all[k];
    const sid = secret('');
    all[sha(sid)] = { user: username, expires: now + SESSION_MS };
    store.set('sessions', all);
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
  }

  // Slow down password guessing: 8 failures per username+IP per 10 minutes.
  const failures = new Map();
  const throttleKey = (req, name) => `${req.socket.remoteAddress}|${name}`;
  function checkThrottle(key) {
    const f = (failures.get(key) || []).filter(t => t > Date.now() - 600e3);
    failures.set(key, f);
    if (f.length >= 8) throw httpError(429, 'Too many attempts. Try again in a few minutes.');
  }

  // ---------- routes ----------
  const USERNAME = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
  const need = user => { if (!user) throw httpError(401, 'Log in to do that'); return user; };

  app.route('POST', '/api/auth/register', async ({ req, res, body }) => {
    if (app.config.registration === false && store.get('admin', null)) throw httpError(403, 'Sign-up is closed');
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const email = String(body.email || '').trim() || `${username}@forge.local`;
    if (!USERNAME.test(username)) throw httpError(400, 'Username must be 3-32 characters: letters, numbers and dashes');
    if (password.length < 8 || password.length > 200) throw httpError(400, 'Password must be 8-200 characters');
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(email) || email.length > 120) throw httpError(400, 'Enter a valid email address');
    const all = users();
    if (all[username]) throw httpError(409, 'That username is taken');
    all[username] = { ...(await hashPassword(password)), email, created: new Date().toISOString() };
    store.set('users', all);
    if (!store.get('admin', null)) store.set('admin', username);
    startSession(req, res, username);
    return publicUser(username, 'session');
  });

  app.route('POST', '/api/auth/login', async ({ req, res, body }) => {
    const username = String(body.username || '').trim().toLowerCase();
    const key = throttleKey(req, username);
    checkThrottle(key);
    if (!(await checkPassword(users()[username], String(body.password || '').slice(0, 200)))) {
      failures.get(key).push(Date.now());
      throw httpError(401, 'Invalid username or password');
    }
    failures.delete(key);
    startSession(req, res, username);
    return publicUser(username, 'session');
  });

  app.route('POST', '/api/auth/logout', ({ req, res }) => {
    const sid = cookieToken(req);
    if (sid) { const all = sessions(); delete all[sha(sid)]; store.set('sessions', all); }
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  });

  app.route('GET', '/api/auth/me', ({ user }) => (user ? { username: user.username, email: user.email } : null));

  // Personal access tokens: what `git push` uses as its password. Shown once, stored hashed.
  app.route('GET', '/api/auth/tokens', ({ user }) => {
    need(user);
    return Object.entries(tokens()).filter(([, t]) => t.user === user.username)
      .map(([h, t]) => ({ id: h.slice(0, 12), name: t.name, created: t.created }));
  });

  app.route('POST', '/api/auth/tokens', ({ user, body }) => {
    need(user);
    const name = String(body.name || '').trim().slice(0, 60) || 'token';
    const token = secret('forge_pat_');
    const all = tokens();
    all[sha(token)] = { user: user.username, name, created: new Date().toISOString() };
    store.set('tokens', all);
    return { id: sha(token).slice(0, 12), name, token };
  });

  app.route('DELETE', '/api/auth/tokens/:id', ({ user, params }) => {
    need(user);
    const all = tokens();
    const hash = Object.keys(all).find(h => h.startsWith(params.id) && all[h].user === user.username);
    if (!hash) throw httpError(404, 'Token not found');
    delete all[hash];
    store.set('tokens', all);
  });
};
