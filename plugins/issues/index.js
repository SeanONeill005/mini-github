// Example plugin: issue tracking. Adds API routes + (via client.js) a repository tab.
module.exports = app => {
  const store = app.store('issues');
  const list = repo => store.get(repo, []);

  app.decorate('repo', repo => ({ openIssues: list(repo.name).filter(i => i.open).length }));

  app.route('GET', '/api/repos/:name/issues', ({ params }) => list(params.name));

  app.route('POST', '/api/repos/:name/issues', ({ params, body }) => {
    const title = String(body.title || '').trim();
    if (!title) throw app.httpError(400, 'Title required');
    const issues = list(params.name);
    const issue = { id: issues.length + 1, title, by: 'you', open: true, created: new Date().toISOString() };
    store.set(params.name, [...issues, issue]);
    app.emit('issue:created', { repo: params.name, issue });
    return issue;
  });

  app.route('PATCH', '/api/repos/:name/issues/:id', ({ params, body }) => {
    const issues = list(params.name);
    const issue = issues.find(i => i.id === Number(params.id));
    if (!issue) throw app.httpError(404, 'Issue not found');
    issue.open = !!body.open;
    store.set(params.name, issues);
    return issue;
  });
};
