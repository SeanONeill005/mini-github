// Profile plugin: per-user repo ordering, short repo blurbs, a bio and an avatar. Stores prefs only;
// the client merges them with /api/repos (which already carries each repo's owner).
module.exports = app => {
  const store = app.store('profile');
  const empty = () => ({ order: [], notes: {}, bio: '', avatar: '' });
  const get = user => ({ ...empty(), ...store.get(user, {}) });

  app.on('repo:deleted', ({ name }) => {
    for (const u of store.keys()) {
      const p = get(u);
      if (!p.order.includes(name) && !(name in p.notes)) continue;
      store.set(u, { ...p, order: p.order.filter(n => n !== name), notes: Object.fromEntries(Object.entries(p.notes).filter(([n]) => n !== name)) });
    }
  });

  // Only small raster data URLs are accepted (the browser resizes to 256px). SVG is refused: it can carry scripts.
  const avatarOk = v => typeof v === 'string' && v.length <= 200000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v);

  app.route('GET', '/api/users/:user/profile', ({ params }) => get(params.user));

  app.route('PUT', '/api/users/:user/profile', ({ params, body, user }) => {
    if (!user || user.username !== params.user) throw app.httpError(403, 'You can only edit your own profile');
    const prev = get(params.user), profile = { ...prev };
    if ('order' in body) profile.order = [...new Set((Array.isArray(body.order) ? body.order : []).filter(n => typeof n === 'string'))].slice(0, 500);
    if ('notes' in body) {
      profile.notes = {};
      const given = body.notes && typeof body.notes === 'object' ? Object.entries(body.notes).slice(0, 500) : [];
      for (const [name, text] of given) {
        const t = String(text).trim().slice(0, 160);
        if (t) profile.notes[name] = t;
      }
    }
    if ('bio' in body) profile.bio = String(body.bio || '').trim().slice(0, 280);
    if ('avatar' in body) {
      if (body.avatar === null || body.avatar === '') profile.avatar = '';
      else if (avatarOk(body.avatar)) profile.avatar = body.avatar;
      else throw app.httpError(400, 'The image must be a PNG, JPEG or WebP under 150 KB');
    }
    store.set(params.user, profile);
    return profile;
  });
};
