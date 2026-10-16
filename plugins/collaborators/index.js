// Collaborators plugin: the owner can give other accounts write access to a repo.
// It wraps app.can (so web commits, branches, pull requests and git push all honour it)
// and decorates repos with `collaborators`. Managing the list stays owner-only.
module.exports = app => {
  const { httpError } = app, store = app.store('collaborators');
  const list = repo => store.get(repo, []);
  app.on('repo:deleted', ({ name }) => store.delete(name)); // a new repo with the same name must not inherit access

  const prevCan = app.can;
  app.can = (user, action, repo) => prevCan(user, action, repo) || (!!user && action === 'push' && list(repo).includes(user.username));
  app.decorate('repo', repo => ({ collaborators: list(repo.name) }));

  const ownerOf = async name => (await app.decorated('repo', { name })).owner;

  app.route('POST', '/api/repos/:name/collaborators', async ({ params, body, user }) => {
    const owner = await ownerOf(params.name);
    if (!user || user.username !== owner) throw httpError(403, `Only ${owner} can manage collaborators`);
    const who = String(body.username || '').trim();
    if (!who) throw httpError(400, 'Enter a username');
    if (who === owner) throw httpError(400, `${who} already owns this repository`);
    if (app.userExists && !app.userExists(who)) throw httpError(404, `No user named "${who}"`);
    const cur = list(params.name);
    if (cur.includes(who)) throw httpError(409, `${who} is already a collaborator`);
    if (cur.length >= 50) throw httpError(400, 'Collaborator limit reached (50)');
    store.set(params.name, [...cur, who]);
    return { collaborators: [...cur, who] };
  });

  // The owner can remove anyone; a collaborator can remove themselves (leave).
  app.route('DELETE', '/api/repos/:name/collaborators/:who', async ({ params, user }) => {
    const owner = await ownerOf(params.name);
    if (!user || (user.username !== owner && user.username !== params.who)) throw httpError(403, `Only ${owner} can remove collaborators`);
    const next = list(params.name).filter(u => u !== params.who);
    store.set(params.name, next);
    return { collaborators: next };
  });
};
