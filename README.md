# Forge — a mini GitHub

Real bare git repos on disk (via git plumbing, no working trees), a tiny kernel, and everything else as plugins.
Requires Node 18+ and `git` on PATH. No dependencies.

```
npm start            # http://localhost:3000   (PORT, FORGE_DATA env vars supported)
```

Data lives in `data/` (`repos/*.git`, `plugins/*.json`, optional `config.json`:
`{ "author": {"name","email"}, "disabledPlugins": ["stars"] }`).

## Layout

| Path | Role |
|---|---|
| `core/app.js` | Kernel: routes, events, decorators, plugin KV store, plugin loader, static server |
| `core/repos/` | Built-in plugin: repos, branches, tree, blob, log, commit-a-file |
| `plugins/<id>/index.js` | Server side of a plugin: `module.exports = app => {...}` |
| `plugins/<id>/client.js` | Optional UI side: `export default forge => {...}` |
| `public/app.js` | UI kernel: router, Code tab, plugin host |

## Writing a plugin

Drop a folder in `plugins/` — it is auto-loaded (restart the server).

Server (`app`): `route(method, '/api/x/:id', ({params, query, body}) => json)`,
`on/emit(event)` (core emits `repo:created`, `commit`), `decorate('repo', repo => ({extra}))`,
`store(ns).get/set` for persistence, `httpError(status, msg)`.

Client (`forge`): `registerTab({id, label, order, render(el, {repo, query})})`,
`contribute('repo-actions', ({repo}) => node | html)`, `registerRenderer({match, render})`,
`api()`, `refresh()`, `navigate()`.

See `plugins/issues` (new tab + routes) and `plugins/stars` (decorator + UI slot).

`Forge.html` is the original hardcoded prototype, kept for reference.
