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

`app.raw(/regex/, (req, res, url) => ...)` takes over a non-JSON route (used by `plugins/clone` for git smart HTTP).

`plugins/history` adds a History tab: browse a branch's commits (30 per page), see the files each commit changed, and **Restore** a branch to an earlier commit. Restoring adds a new commit whose files match the chosen one, so no history is lost.

`plugins/pulls` adds a Pull requests tab and branch merging. Merges are computed with `git merge-tree` (no working tree; needs git 2.38+) and recorded as real merge commits authored by the person who merged; conflicting merges are refused and the branch is left untouched. Pull requests (title, description, base/head, open/merged/closed) show commits, changed files and a diff, and can be merged (optionally deleting the branch), closed and reopened. **Merge branches** merges two branches directly, and also marks a matching open PR as merged. Reading is public; creating, merging and closing are owner-only (the auth plugin's deny-by-default rule), so the usual flow is `git push` a branch, then open a PR for it.

`plugins/profile` adds a profile page at `#/~username` (linked from the header and from a repo's owner name). It lists the user's repos in a priority order they choose, each with an optional brief description that is shown on the profile only (falls back to the repo description). Users can also upload a profile image (cropped and shrunk to 256 px in the browser, stored as a small JPEG data URL; PNG/JPEG/WebP only, never SVG) and write a bio of up to 280 characters. Only the owner can edit; prefs are stored in `data/plugins/profile.json`. Kernel addition: `forge.registerPage({ match, render })` for non-repo pages.

`plugins/collaborators` adds a Collaborators tab: the owner can give other accounts write access (web commits, branches, pull requests, `git push`). It wraps `app.can` and decorates repos with `collaborators`; only the owner manages the list, and a collaborator can leave. Stored in `data/plugins/collaborators.json`. `app.userExists(name)` (from auth) validates usernames.

**Deleting a repo:** the owner opens the repo's Settings tab and types its name to confirm (`DELETE /api/repos/:name?confirm=<name>`; collaborators can't). Core removes the bare repo and emits `repo:deleted`; stars, issues, pull requests, collaborators, owner records and profile entries clean themselves up, so a new repo with the same name starts fresh. Plugins that store per-repo data should listen for it (`app.store(ns).delete(key)` and `.keys()` exist for this).

`plugins/issues` adds an Issues tab: issues have a title, markdown description, labels and a comment thread. The list filters by open/closed, label and text; each issue has its own page (`?issue=N`). Anyone logged in can open issues and comment, and delete their own comments; the author or anyone who can push can edit and close/reopen; only people who can push set labels or delete others' comments. Emits `issue:created`, `issue:commented`, `issue:closed` and `issue:reopened`.

See `plugins/issues` (new tab + routes) and `plugins/stars` (decorator + UI slot), `plugins/clone` (raw protocol route + Clone button).

## Cloning

`git clone http://localhost:3000/<repo>.git` works for anyone. Pushing needs an account (below).

## Accounts, commit and push

Sign up in the header. Reading and cloning stay public; everything that writes needs a login, and changing a repo
(web commits, branches, `git push`) is limited to its owner. Repos created before accounts existed belong to the
first account that signs up.

To push: click **Tokens**, create one, then

```
git push http://localhost:3000/<repo>.git main     # username = your account, password = the token
```

Passwords and tokens are stored hashed in `data/plugins/auth.json`. Web commits are authored by your account
(username + the email you signed up with). Serve Forge behind HTTPS if it is ever reachable beyond your machine:
passwords and tokens are otherwise sent in clear. `config.json` can set `{ "registration": false }` to close sign-up
once your own account exists.

Kernel hooks the auth plugin uses (any plugin can): `app.identify(req => user)`, `app.before(ctx => {...})` to
veto an API call, `app.can(user, action, repo)`, and `user` / `res` passed to route handlers.

`Forge.html` is the original hardcoded prototype, kept for reference.
