// Example plugin: starring. Shows how a plugin decorates core objects and contributes UI slots.
module.exports = app => {
  const store = app.store('stars');
  const get = repo => store.get(repo, { count: 0, starred: false });

  app.decorate('repo', repo => get(repo.name));

  app.route('POST', '/api/repos/:name/star', ({ params }) => {
    const s = get(params.name);
    const next = { starred: !s.starred, count: Math.max(0, s.count + (s.starred ? -1 : 1)) };
    store.set(params.name, next);
    return next;
  });
};
