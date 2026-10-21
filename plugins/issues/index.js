// Plugin: issue tracking with descriptions, labels and comments.
//
// Permissions (the auth plugin already requires a login for every write; these rules are checked here because
// its guard lets any logged-in user reach /issues so that anyone can report a problem):
//   - anyone logged in: open an issue, comment, delete their own comment
//   - the issue's author, or anyone who can push to the repo: edit title/description, close/reopen
//   - only people who can push: change labels, delete other people's comments
const LIMITS = { title: 200, body: 20000, comment: 10000, label: 30, labels: 10 };

module.exports = app => {
  const { httpError } = app;
  const store = app.store('issues');
  const list = repo => store.get(repo, []);
  app.on('repo:deleted', ({ name }) => store.delete(name));

  app.decorate('repo', repo => ({ openIssues: list(repo.name).filter(i => i.open).length }));

  // ---------- helpers ----------
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  const who = user => user?.username || 'you';
  const isWriter = (user, repo) => !!user && (!app.hasIdentity() || app.can(user, 'push', repo));
  const canEdit = (user, repo, issue) => isWriter(user, repo) || (!!user && issue.by === user.username);
  const now = () => new Date().toISOString();

  function find(repo, id) {
    const issues = list(repo), issue = issues.find(i => i.id === Number(id));
    if (!issue) throw httpError(404, 'Issue not found');
    return { issues, issue };
  }
  const summary = ({ comments = [], body, ...i }) => ({ ...i, comments: comments.length });

  function cleanLabels(input) {
    if (!Array.isArray(input)) throw httpError(400, 'Labels must be a list');
    const out = [...new Set(input.map(l => text(l, LIMITS.label).toLowerCase().replace(/\s+/g, '-')).filter(Boolean))];
    if (out.length > LIMITS.labels) throw httpError(400, `At most ${LIMITS.labels} labels per issue`);
    return out;
  }

  // ---------- routes ----------
  app.route('GET', '/api/repos/:name/issues', ({ params }) => list(params.name).map(summary));

  app.route('GET', '/api/repos/:name/issues/:id', ({ params }) => find(params.name, params.id).issue);

  app.route('POST', '/api/repos/:name/issues', ({ params, body, user }) => {
    const title = text(body.title, LIMITS.title);
    if (!title) throw httpError(400, 'Title required');
    const labels = body.labels && isWriter(user, params.name) ? cleanLabels(body.labels) : [];
    const issues = list(params.name);
    const issue = {
      id: Math.max(0, ...issues.map(i => i.id)) + 1, title, body: text(body.body, LIMITS.body),
      by: who(user), open: true, labels, comments: [], created: now(), updated: now(),
    };
    store.set(params.name, [...issues, issue]);
    app.emit('issue:created', { repo: params.name, issue: summary(issue) });
    return issue;
  });

  app.route('PATCH', '/api/repos/:name/issues/:id', ({ params, body, user }) => {
    const { issues, issue } = find(params.name, params.id);
    if (!canEdit(user, params.name, issue)) throw httpError(403, 'Only the author or a collaborator can change this issue');
    const wasOpen = issue.open;
    if ('title' in body) {
      issue.title = text(body.title, LIMITS.title);
      if (!issue.title) throw httpError(400, 'Title required');
    }
    if ('body' in body) issue.body = text(body.body, LIMITS.body);
    if ('open' in body) {
      issue.open = !!body.open;
      issue.closedAt = issue.open ? undefined : now();
    }
    if ('labels' in body) {
      if (!isWriter(user, params.name)) throw httpError(403, 'Only collaborators can change labels');
      issue.labels = cleanLabels(body.labels);
    }
    issue.updated = now();
    store.set(params.name, issues);
    if (wasOpen !== issue.open) app.emit(issue.open ? 'issue:reopened' : 'issue:closed', { repo: params.name, issue: summary(issue) });
    return issue;
  });

  // `close` / `reopen` lets someone comment and change the state in one step.
  app.route('POST', '/api/repos/:name/issues/:id/comments', ({ params, body, user }) => {
    const { issues, issue } = find(params.name, params.id);
    const comment = { id: Math.max(0, ...issue.comments.map(c => c.id)) + 1, by: who(user), body: text(body.body, LIMITS.comment), created: now() };
    const state = body.state === 'closed' ? false : body.state === 'open' ? true : issue.open;
    if (!comment.body && state === issue.open) throw httpError(400, 'Write a comment first');
    if (state !== issue.open && !canEdit(user, params.name, issue)) throw httpError(403, 'Only the author or a collaborator can close or reopen this issue');
    if (comment.body) issue.comments.push(comment);
    const changed = state !== issue.open;
    issue.open = state;
    issue.closedAt = state ? undefined : changed ? now() : issue.closedAt;
    issue.updated = now();
    store.set(params.name, issues);
    if (comment.body) app.emit('issue:commented', { repo: params.name, issue: summary(issue), comment });
    if (changed) app.emit(state ? 'issue:reopened' : 'issue:closed', { repo: params.name, issue: summary(issue) });
    return issue;
  });

  app.route('DELETE', '/api/repos/:name/issues/:id/comments/:cid', ({ params, user }) => {
    const { issues, issue } = find(params.name, params.id);
    const c = issue.comments.find(x => x.id === Number(params.cid));
    if (!c) throw httpError(404, 'Comment not found');
    if (!(isWriter(user, params.name) || (user && c.by === user.username))) throw httpError(403, 'You can only delete your own comments');
    issue.comments = issue.comments.filter(x => x !== c);
    store.set(params.name, issues);
    return issue;
  });
};
