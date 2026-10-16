// Profile page at #/~username: avatar, bio and the user's repos in their chosen order, each with a short blurb.
export default forge => {
  const { api, esc, html, link } = forge;
  const href = u => `#/~${encodeURIComponent(u)}`;

  forge.contribute('header', async () => {
    const me = await api('GET', '/api/auth/me').catch(() => null);
    return me ? html(`<a class="btn" href="${href(me.username)}">Profile</a>`) : null;
  });

  // Centre-crop to a square, shrink to 256px and re-encode as JPEG so the stored image stays small.
  async function toAvatar(file) {
    if (!file.type.startsWith('image/')) throw new Error('Choose an image file');
    if (file.size > 8e6) throw new Error('That image is too large (max 8 MB)');
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { throw new Error('Could not read that image. Try a PNG, JPEG or WebP.'); }
    const s = Math.min(bmp.width, bmp.height), c = document.createElement('canvas'), x = c.getContext('2d');
    c.width = c.height = 256;
    x.fillStyle = '#fff'; x.fillRect(0, 0, 256, 256);
    x.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 256, 256);
    return c.toDataURL('image/jpeg', 0.85);
  }

  forge.registerPage({
    match: name => name.startsWith('~'),
    async render(el, { name }) {
      const username = name.slice(1), base = `/api/users/${encodeURIComponent(username)}/profile`;
      const [repos, prefs, me] = await Promise.all([api('GET', '/api/repos'), api('GET', base), api('GET', '/api/auth/me').catch(() => null)]);
      const mine = repos.filter(r => r.owner === username), byName = Object.fromEntries(mine.map(r => [r.name, r]));
      const rank = n => { const i = prefs.order.indexOf(n); return i < 0 ? Infinity : i; };
      let list = mine.map(r => r.name).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      let notes = { ...prefs.notes }, bio = prefs.bio || '', avatar = prefs.avatar || '';
      const canEdit = !!me && me.username === username;

      const pic = px => avatar
        ? `<img src="${avatar}" alt="${esc(username)}'s avatar" width="${px}" height="${px}" style="border-radius:50%;object-fit:cover;flex:none">`
        : `<div aria-hidden="true" style="width:${px}px;height:${px}px;border-radius:50%;background:var(--accbg);color:var(--acc);display:grid;place-items:center;font-size:${Math.round(px * .43)}px;font-weight:600;flex:none">${esc(username[0]?.toUpperCase() || '?')}</div>`;

      async function view() {
        el.innerHTML = `<div style="display:flex;gap:16px;align-items:center;margin:8px 0 16px;flex-wrap:wrap">${pic(72)}
          <div style="flex:1;min-width:200px"><h2 class="title" style="margin:0">${esc(username)}</h2>
          ${bio ? `<p style="margin:4px 0;white-space:pre-line">${esc(bio)}</p>` : canEdit ? '<p class="mute sm" style="margin:4px 0">Add a short bio so people know who you are.</p>' : ''}
          <div class="mute sm">${mine.length} repositor${mine.length === 1 ? 'y' : 'ies'}</div></div>
          ${canEdit ? '<button class="btn" id="pe">Edit profile</button>' : ''}</div><div class="box" id="pl"></div>`;
        const box = el.querySelector('#pl');
        if (!list.length) box.innerHTML = `<div class="empty">${canEdit ? 'You have no repositories yet. Create one and it will appear here.' : `${esc(username)} has no repositories yet.`}</div>`;
        for (const [i, n] of list.entries()) {
          const r = byName[n];
          box.append(html(`<div class="row h"><span class="pill" title="Priority">#${i + 1}</span><div style="flex:1;min-width:0"><a href="${link(n, 'code')}"><b>${esc(n)}</b></a>
            <div class="mute sm">${esc(notes[n] || r.description) || 'No description'}</div></div><span class="actions"></span></div>`));
          await forge.fillSlot('repo-actions', { repo: r }, box.lastElementChild.querySelector('.actions'));
        }
        const b = el.querySelector('#pe');
        if (b) b.onclick = edit;
      }

      function edit(msg = '') {
        const sync = () => {
          bio = el.querySelector('#pb')?.value.trim() ?? bio;
          el.querySelectorAll('textarea[data-n]').forEach(t => { const v = t.value.trim(); v ? notes[t.dataset.n] = v : delete notes[t.dataset.n]; });
        };
        const move = (i, d) => { sync(); [list[i], list[i + d]] = [list[i + d], list[i]]; edit(); };
        el.innerHTML = `<h2 class="title">Edit profile</h2>
          <div class="box" style="padding:16px;margin:12px 0"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">${pic(72)}
            <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="pu" type="button">Upload image</button>${avatar ? '<button class="btn" id="pd" type="button">Remove image</button>' : ''}</div>
            <input type="file" id="pf" accept="image/*" hidden></div>
            <p class="err" id="pm">${esc(msg)}</p>
            <label for="pb">Bio</label><textarea id="pb" class="field" rows="3" maxlength="280" placeholder="A few words about you">${esc(bio)}</textarea>
            <div class="mute sm" id="pbc">${bio.length}/280</div></div>
          ${list.length ? `<p class="mute sm">Reorder your repositories with the arrows. Repos at the top are shown first. A short note replaces the repository description on your profile only.</p>
          <div class="box">${list.map((n, i) => `<div class="row" style="align-items:flex-start">
            <div style="display:flex;flex-direction:column;gap:4px"><button class="btn sm" data-up="${i}" aria-label="Move ${esc(n)} up" ${i === 0 ? 'disabled' : ''}>↑</button><button class="btn sm" data-dn="${i}" aria-label="Move ${esc(n)} down" ${i === list.length - 1 ? 'disabled' : ''}>↓</button></div>
            <div style="flex:1;min-width:0"><b>${esc(n)}</b> <span class="pill">#${i + 1}</span>
              <textarea class="field" rows="2" maxlength="160" data-n="${esc(n)}" aria-label="Description for ${esc(n)}" placeholder="${esc(byName[n].description) || 'Brief description (optional)'}" style="margin-top:6px">${esc(notes[n] || '')}</textarea>
              <div class="mute sm" data-c="${esc(n)}">${(notes[n] || '').length}/160</div></div></div>`).join('')}</div>` : ''}
          <p class="err" id="pr"></p>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button class="btn" id="pc">Cancel</button><button class="btn p" id="ps">Save profile</button></div>`;
        const file = el.querySelector('#pf');
        el.querySelector('#pu').onclick = () => file.click();
        file.onchange = async () => {
          if (!file.files[0]) return;
          sync();
          try { avatar = await toAvatar(file.files[0]); edit(); } catch (e) { edit(e.message); }
        };
        const rm = el.querySelector('#pd');
        if (rm) rm.onclick = () => { sync(); avatar = ''; edit(); };
        el.querySelector('#pb').oninput = e => { el.querySelector('#pbc').textContent = `${e.target.value.length}/280`; };
        el.querySelectorAll('[data-up]').forEach(b => b.onclick = () => move(+b.dataset.up, -1));
        el.querySelectorAll('[data-dn]').forEach(b => b.onclick = () => move(+b.dataset.dn, 1));
        el.querySelectorAll('textarea[data-n]').forEach(t => t.oninput = () => { el.querySelector(`[data-c="${CSS.escape(t.dataset.n)}"]`).textContent = `${t.value.length}/160`; });
        el.querySelector('#pc').onclick = () => forge.refresh();
        el.querySelector('#ps').onclick = async () => {
          sync();
          try { await api('PUT', base, { order: list, notes, bio, avatar: avatar || null }); forge.refresh(); }
          catch (e) { el.querySelector('#pr').textContent = e.message; }
        };
      }
      await view();
    },
  });
};
