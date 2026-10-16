// Settings tab with a "danger zone". Deleting needs the repo name typed in, like GitHub.
export default forge => {
  const { api, esc } = forge;
  forge.registerTab({
    id: 'settings', label: 'Settings', order: 90,
    async render(el, { repo }) {
      const me = await api('GET', '/api/auth/me').catch(() => null);
      if (!me || me.username !== repo.owner) {
        el.innerHTML = `<div class="box"><div class="empty">Only ${esc(repo.owner || 'the owner')} can change settings for this repository.</div></div>`;
        return;
      }
      el.innerHTML = `<div class="box" style="border-color:var(--bad)"><div class="row" style="flex-direction:column;align-items:stretch;gap:6px">
        <b style="color:var(--bad)">Delete this repository</b>
        <p class="mute sm" style="margin:0">This permanently removes the code, branches, history, issues, pull requests and stars of <b>${esc(repo.name)}</b>. Collaborators lose access. This cannot be undone.</p>
        <label for="dc">Type <b>${esc(repo.name)}</b> to confirm</label>
        <input id="dc" class="field" autocomplete="off">
        <p class="err" id="de"></p>
        <div><button class="btn" id="dd" disabled style="border-color:var(--bad);color:var(--bad)">Delete this repository</button></div></div></div>`;
      const input = el.querySelector('#dc'), btn = el.querySelector('#dd');
      input.oninput = () => { btn.disabled = input.value !== repo.name; };
      btn.onclick = async () => {
        const n = encodeURIComponent(repo.name);
        try { await api('DELETE', `/api/repos/${n}?confirm=${n}`); forge.navigate('#/'); }
        catch (e) { el.querySelector('#de').textContent = e.message; }
      };
    },
  });
};
