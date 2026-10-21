// Chat plugin: a private message thread per repo for the owner and its collaborators.
//
// Access: "member" = anyone who can push (the owner, plus collaborators once that plugin has wrapped app.can).
// Reading is member-only too (the auth plugin leaves GETs public, so this plugin checks for itself); posting
// is already member-only through the auth plugin's deny-by-default guard, and is re-checked here.
// Authors can delete their own messages; the owner can delete anyone's. Emits `chat:message`.
const LIMITS = { message: 2000, kept: 1000, page: 200 };

module.exports = app => {
  const { httpError } = app;
  const store = app.store('chat');
  const list = repo => store.get(repo, []);
  app.on('repo:deleted', ({ name }) => store.delete(name)); // a new repo with the same name starts with an empty room

  const member = (user, repo) => !!user && app.can(user, 'push', repo);
  const need = (user, repo) => {
    if (!user) throw httpError(401, 'Log in to read the chat');
    if (!member(user, repo)) throw httpError(403, 'Chat is only for the owner and collaborators');
  };
  const ownerOf = async name => (await app.decorated('repo', { name })).owner;

  // Messages with id > ?after (oldest first). With no cursor: the latest page.
  app.route('GET', '/api/repos/:name/chat', ({ params, query, user }) => {
    need(user, params.name);
    const all = list(params.name), after = Number(query.get('after'));
    return after > 0 ? all.filter(m => m.id > after) : all.slice(-LIMITS.page);
  });

  app.route('POST', '/api/repos/:name/chat', ({ params, body, user }) => {
    need(user, params.name);
    const text = String(body.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, LIMITS.message);
    if (!text) throw httpError(400, 'Write a message first');
    const all = list(params.name);
    const msg = { id: (all.at(-1)?.id || 0) + 1, by: user.username, body: text, created: new Date().toISOString() };
    store.set(params.name, [...all, msg].slice(-LIMITS.kept));
    app.emit('chat:message', { repo: params.name, message: msg });
    return msg;
  });

  app.route('DELETE', '/api/repos/:name/chat/:id', async ({ params, user }) => {
    need(user, params.name);
    const all = list(params.name), msg = all.find(m => m.id === Number(params.id));
    if (!msg) throw httpError(404, 'Message not found');
    if (msg.by !== user.username && user.username !== await ownerOf(params.name)) throw httpError(403, 'You can only delete your own messages');
    store.set(params.name, all.filter(m => m !== msg));
    return { id: msg.id };
  });
};
