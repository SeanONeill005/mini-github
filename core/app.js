// The extension kernel: routing, events, UI registry, plugin storage and plugin loading.
// Everything else (repos, issues, stars...) is a plugin built on this surface.
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const httpError = (status, message) => Object.assign(new Error(message), { status });

function createApp({ dataDir, pluginsDir, publicDir, config = {} }) {
  const routes = [], listeners = {}, decorators = {}, clients = [];

  const app = {
    dataDir, config, httpError,

    // route('GET', '/api/repos/:name', async ({params, query, body}) => json)
    route(method, pattern, handler) {
      const keys = [];
      const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
      routes.push({ method, re, keys, handler });
    },

    on(event, fn) { (listeners[event] ||= []).push(fn); },
    async emit(event, payload) { for (const fn of listeners[event] || []) await fn(payload); },

    // Plugins add fields to core objects (e.g. 'repo') without core knowing about them.
    decorate(kind, fn) { (decorators[kind] ||= []).push(fn); },
    async decorated(kind, obj) {
      for (const fn of decorators[kind] || []) Object.assign(obj, await fn(obj));
      return obj;
    },

    // Tiny persistent JSON key-value store, one file per namespace.
    store(ns) {
      const file = path.join(dataDir, 'plugins', ns + '.json');
      let data = {};
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
      return {
        get: (key, fallback) => (key in data ? data[key] : fallback),
        set(key, value) {
          data[key] = value;
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify(data, null, 2));
        },
      };
    },
  };

  function loadPlugin(id, dir) {
    require(path.join(dir, 'index.js'))(app);
    if (fs.existsSync(path.join(dir, 'client.js'))) clients.push(id);
    console.log('plugin loaded:', id);
  }

  app.loadPlugins = () => {
    loadPlugin('core', path.join(__dirname, 'repos'));
    const disabled = new Set(config.disabledPlugins || []);
    for (const id of fs.existsSync(pluginsDir) ? fs.readdirSync(pluginsDir) : []) {
      const dir = path.join(pluginsDir, id);
      if (!disabled.has(id) && fs.existsSync(path.join(dir, 'index.js'))) loadPlugin(id, dir);
    }
  };

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };

  const readBody = req => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) { reject(httpError(413, 'Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(httpError(400, 'Invalid JSON')); } });
  });

  function staticFile(pathname) {
    const plugin = /^\/plugins\/([\w-]+)\/client\.js$/.exec(pathname);
    if (plugin) return clients.includes(plugin[1]) ? path.join(pluginsDir, plugin[1], 'client.js') : null;
    const file = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
    return file.startsWith(publicDir + path.sep) && fs.existsSync(file) ? file : null;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/manifest') return send(res, 200, { plugins: clients });
      if (url.pathname.startsWith('/api/')) {
        for (const r of routes) {
          const m = r.method === req.method && r.re.exec(url.pathname);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
          const out = await r.handler({ params, query: url.searchParams, body, req });
          return out === undefined ? (res.writeHead(204), res.end()) : send(res, 200, out);
        }
        throw httpError(404, 'Not found');
      }
      const file = staticFile(url.pathname);
      if (!file) throw httpError(404, 'Not found');
      send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    } catch (e) {
      if (!e.status) console.error(e);
      send(res, e.status || 500, { error: e.status ? e.message : 'Internal error' });
    }
  }

  app.listen = port => http.createServer(handle).listen(port, () => console.log(`Forge running at http://localhost:${port}`));
  return app;
}

module.exports = { createApp, httpError };
