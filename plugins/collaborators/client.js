// Collaborators tab + makes the UI treat collaborators as writers (edit buttons, PR actions).
export default async forge => {
  const { api, esc } = forge;
  let me = null;
  const load = async () => { me = await api('GET', '/api/auth/me').catch(() => null); };
  await load();

  const owner = forge.canWrite;
  forge.canWrite = repo => owner(repo) || (!!me && !!repo && (repo.collaborators || []).includes(me.username));
  forge.contribute('header', async () => { await load(); return null; }); // keep `me` fresh after login/logout

  forge.registerTab({
    id: 'collaborators', order: 60,
    label: r => `Collaborators (${(r.collaborators || []).length})`,
    async render(el, { repo }) {
      await load();
      const base = `/api/repos/${encodeURIComponent(repo.name)}/collaborators`, list = repo.collaborators || [];
      const isOwner = !!me && me.username === repo.owner;
      el.innerHTML = `<p class="mute sm">Collaborators can commit, create branches, open and merge pull requests, and push with a token. Only the owner can add or remove people.</p>
        <div class="box"><div class="row"><b>${esc(repo.owner || 'unknown')}</b><span class="pill">Owner</span></div>
        ${list.map(u => `<div class="row"><b>${esc(u)}</b><span class="pill">Collaborator</span><span class="sp"></span>${isOwner || me?.username === u ? `<button class="btn sm" data-rm="${esc(u)}">${isOwner ? 'Remove' : 'Leave'}</button>` : ''}</div>`).join('')}
        ${list.length ? '' : '<div class="empty">No collaborators yet.</div>'}</div>
        ${isOwner ? `<form id="cf" style="display:flex;gap:8px;margin-top:14px"><input class="field" id="cu" placeholder="Username" aria-label="Collaborator username" autocomplete="off"><button class="btn p">Add collaborator</button></form>` : ''}
        <p class="err" id="ce"></p>`;
      const fail = e => { el.querySelector('#ce').textContent = e.message; };
      el.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
        if (!confirm(`${isOwner ? 'Remove' : 'Leave as'} ${b.dataset.rm}?`)) return;
        try { await api('DELETE', `${base}/${encodeURIComponent(b.dataset.rm)}`); forge.refresh(); } catch (e) { fail(e); }
      });
      const f = el.querySelector('#cf');
      if (f) f.onsubmit = async e => {
        e.preventDefault();
        try { await api('POST', base, { username: f.querySelector('#cu').value }); forge.refresh(); } catch (err) { fail(err); }
      };
    },
  });
};
