export default forge => {
  const { api, esc } = forge;

  forge.registerTab({
    id: 'issues', order: 10,
    label: repo => `Issues (${repo.openIssues ?? 0})`,
    async render(el, { repo }) {
      const base = `/api/repos/${encodeURIComponent(repo.name)}/issues`;
      const issues = (await api('GET', base)).reverse();
      el.innerHTML = `<form class="box" style="padding:14px;margin-bottom:14px;display:flex;gap:8px">
          <input id="it" class="field" placeholder="Describe a bug or idea" aria-label="Issue title"><button class="btn p">New issue</button></form>
        <div class="box">${issues.length ? issues.map(i => `<div class="row h">
          <span class="state" style="background:${i.open ? 'var(--ok)' : 'var(--bad)'}"></span>
          <div style="flex:1"><b>${esc(i.title)}</b><div class="mute sm">#${i.id} by ${esc(i.by)} · ${i.open ? 'Open' : 'Closed'}</div></div>
          <button class="btn sm" data-id="${i.id}" data-open="${!i.open}">${i.open ? 'Close issue' : 'Reopen issue'}</button></div>`).join('')
          : '<div class="empty">No issues yet. Add the first one above.</div>'}</div>`;
      el.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        const title = el.querySelector('#it').value.trim();
        if (title) { await api('POST', base, { title }); forge.refresh(); }
      };
      el.querySelectorAll('button[data-id]').forEach(b => b.onclick = async () => {
        await api('PATCH', `${base}/${b.dataset.id}`, { open: b.dataset.open === 'true' });
        forge.refresh();
      });
    },
  });
};
