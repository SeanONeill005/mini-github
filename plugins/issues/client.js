export default forge => {
  const { api, esc, link } = forge;

  const ago = iso => {
    const s = (Date.now() - new Date(iso)) / 1000;
    for (const [n, u] of [[86400 * 365, 'year'], [86400 * 30, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']]) {
      if (s >= n) { const v = Math.floor(s / n); return `${v} ${u}${v > 1 ? 's' : ''} ago`; }
    }
    return 'just now';
  };

  // A label's colour is derived from its name, so the same label always looks the same.
  const labelChip = (l, href) => {
    let h = 0;
    for (const c of l) h = (h * 31 + c.charCodeAt(0)) % 360;
    const col = `hsl(${h} 55% 45%)`;
    return `<a href="${href}" class="pill" style="color:${col};border-color:${col};text-decoration:none">${esc(l)}</a>`;
  };
  const stateDot = open => `<span class="state" style="background:${open ? 'var(--ok)' : 'var(--bad)'}"></span>`;
  const statePill = open => `<span class="pill" style="color:${open ? 'var(--ok)' : 'var(--bad)'};border-color:${open ? 'var(--ok)' : 'var(--bad)'}">${open ? 'Open' : 'Closed'}</span>`;
  const md = t => forge.renderFile('x.md', t) || esc(t);

  // Who is logged in? (the auth plugin is optional)
  const whoami = async () => { try { return await api('GET', '/api/auth/me'); } catch { return null; } };

  forge.registerTab({
    id: 'issues', order: 10,
    label: repo => `Issues (${repo.openIssues ?? 0})`,
    async render(el, ctx) {
      const q = ctx.query;
      if (q.get('issue')) return detail(el, ctx, q.get('issue'));
      if (q.get('new')) return create(el, ctx);
      return index(el, ctx);
    },
  });

  const base = repo => `/api/repos/${encodeURIComponent(repo.name)}/issues`;

  // ---------- list ----------
  async function index(el, { repo, query }) {
    const closed = query.get('state') === 'closed', label = query.get('label') || '', term = (query.get('q') || '').toLowerCase();
    const issues = (await api('GET', base(repo))).reverse();
    const counts = { open: issues.filter(i => i.open).length, closed: issues.filter(i => !i.open).length };
    const labels = [...new Set(issues.flatMap(i => i.labels || []))].sort();
    const shown = issues.filter(i => i.open !== closed && (!label || (i.labels || []).includes(label)) && (!term || `${i.title} #${i.id}`.toLowerCase().includes(term)));
    const keep = o => ({ state: closed ? 'closed' : '', label, q: query.get('q') || '', ...o });
    const tab = (on, text, params) => `<a href="${link(repo.name, 'issues', params)}" style="${on ? 'font-weight:600;color:var(--text)' : 'color:var(--mute)'}">${text}</a>`;

    el.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:12px">
        ${tab(!closed, `Open (${counts.open})`, keep({ state: '' }))}${tab(closed, `Closed (${counts.closed})`, keep({ state: 'closed' }))}
        <input id="sq" class="field" style="max-width:240px" placeholder="Search issues" aria-label="Search issues" value="${esc(query.get('q') || '')}">
        ${labels.length ? `<select id="lf" class="field" style="width:auto" aria-label="Filter by label"><option value="">All labels</option>${labels.map(l => `<option ${l === label ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : ''}
        <span class="sp"></span><a class="btn p" href="${link(repo.name, 'issues', { new: 1 })}">New issue</a></div>
      <div class="box">${shown.length ? shown.map(i => `<div class="row h">${stateDot(i.open)}
        <div style="flex:1;min-width:0"><a href="${link(repo.name, 'issues', { issue: i.id })}"><b>${esc(i.title)}</b></a>
          ${(i.labels || []).map(l => labelChip(l, link(repo.name, 'issues', keep({ label: l })))).join(' ')}
          <div class="mute sm">#${i.id} ${i.open ? 'opened' : 'closed'} ${ago(i.open ? i.created : i.closedAt || i.updated)} by ${esc(i.by)}</div></div>
        ${i.comments ? `<span class="mute sm" title="Comments">${i.comments} comment${i.comments === 1 ? '' : 's'}</span>` : ''}</div>`).join('')
        : `<div class="empty">${issues.length ? 'No issues match these filters.' : 'No issues yet. <a href="' + link(repo.name, 'issues', { new: 1 }) + '">Open the first one.</a>'}</div>`}</div>`;

    el.querySelector('#sq').onkeydown = e => { if (e.key === 'Enter') forge.navigate(link(repo.name, 'issues', keep({ q: e.target.value.trim() }))); };
    const lf = el.querySelector('#lf');
    if (lf) lf.onchange = () => forge.navigate(link(repo.name, 'issues', keep({ label: lf.value })));
  }

  // ---------- new issue ----------
  async function create(el, { repo }) {
    el.innerHTML = `<form class="box"><div class="row sm"><b>New issue</b></div><div style="padding:0 16px 16px">
      <label for="it">Title</label><input id="it" class="field" maxlength="200" placeholder="Summarise the bug or idea">
      <label for="ib">Description <span class="mute sm">(optional)</span></label>
      <textarea id="ib" class="field" rows="8" maxlength="20000" placeholder="Steps to reproduce, what you expected, screenshots in words..."></textarea>
      <p class="err" id="ie"></p>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px"><a class="btn" href="${link(repo.name, 'issues')}">Cancel</a><button class="btn p">Submit new issue</button></div></div></form>`;
    el.querySelector('#it').focus();
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const title = el.querySelector('#it').value.trim();
      if (!title) return (el.querySelector('#ie').textContent = 'Enter a title.');
      try {
        const issue = await api('POST', base(repo), { title, body: el.querySelector('#ib').value });
        forge.navigate(link(repo.name, 'issues', { issue: issue.id }));
      } catch (err) { el.querySelector('#ie').textContent = err.message; }
    };
  }

  // ---------- detail ----------
  async function detail(el, { repo }, id) {
    const [issue, me] = await Promise.all([api('GET', `${base(repo)}/${encodeURIComponent(id)}`), whoami()]);
    const url = `${base(repo)}/${issue.id}`;
    const writer = !!me && forge.canWrite(repo);
    const author = !!me && me.username === issue.by;
    const canEdit = writer || author;
    const back = link(repo.name, 'issues');

    const comment = c => `<div class="box" style="margin-top:12px"><div class="row sm"><b>${esc(c.by)}</b><span class="mute">commented ${ago(c.created)}</span><span class="sp"></span>
        ${writer || (me && me.username === c.by) ? `<button class="btn sm" data-del="${c.id}">Delete</button>` : ''}</div>
        <div class="readme" style="padding:6px 16px 12px;white-space:pre-line">${md(c.body)}</div></div>`;

    el.innerHTML = `<p style="margin:0 0 8px"><a href="${back}">&larr; All issues</a></p>
      <div id="head"></div>
      <div class="box"><div class="row sm"><b>${esc(issue.by)}</b><span class="mute">opened ${ago(issue.created)}</span></div>
        <div class="readme" style="padding:6px 16px 12px;white-space:pre-line">${issue.body ? md(issue.body) : '<p class="mute">No description provided.</p>'}</div></div>
      ${issue.comments.map(comment).join('')}
      <div style="margin-top:16px">${me ? `<form class="box" id="cf"><div style="padding:12px 16px">
          <textarea id="cb" class="field" rows="4" maxlength="10000" placeholder="Leave a comment" aria-label="Comment"></textarea>
          <p class="err" id="ce"></p>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
            ${canEdit ? `<button type="button" class="btn" id="cs">${issue.open ? 'Close issue' : 'Reopen issue'}</button>` : ''}
            <button class="btn p">Comment</button></div></div></form>`
        : `<div class="box"><div class="empty">Log in to join this conversation.</div></div>`}</div>`;

    const head = el.querySelector('#head');
    const renderHead = (editing = false) => {
      head.innerHTML = editing ? `<form style="display:flex;gap:8px;margin-bottom:6px"><input class="field" id="et" maxlength="200" value="${esc(issue.title)}" aria-label="Title">
          <button class="btn p">Save</button><button type="button" class="btn" id="ec">Cancel</button></form>`
        : `<h2 class="title" style="margin-bottom:4px">${esc(issue.title)} <span class="mute" style="font-weight:400">#${issue.id}</span>${canEdit ? ' <button class="btn sm" id="edit">Edit</button>' : ''}</h2>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px">${statePill(issue.open)}
          ${(issue.labels || []).map(l => labelChip(l, link(repo.name, 'issues', { label: l }))).join(' ')}
          ${writer ? '<button class="btn sm" id="lb">Edit labels</button>' : ''}</div>`;
      if (editing) {
        head.querySelector('#ec').onclick = () => renderHead();
        head.querySelector('#et').focus();
        head.querySelector('form').onsubmit = e => run(e, () => api('PATCH', url, { title: head.querySelector('#et').value }));
      } else {
        head.querySelector('#edit')?.addEventListener('click', () => renderHead(true));
        head.querySelector('#lb')?.addEventListener('click', async () => {
          const next = prompt('Labels, separated by commas', (issue.labels || []).join(', '));
          if (next !== null) run(null, () => api('PATCH', url, { labels: next.split(',').map(s => s.trim()).filter(Boolean) }));
        });
      }
    };
    renderHead();

    async function run(e, fn) {
      e?.preventDefault();
      try { await fn(); forge.refresh(); } catch (err) { alert(err.message); }
    }

    el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => confirm('Delete this comment?') && run(null, () => api('DELETE', `${url}/comments/${b.dataset.del}`)));
    const cf = el.querySelector('#cf');
    if (cf) {
      const send = async state => {
        const body = cf.querySelector('#cb').value;
        try { await api('POST', `${url}/comments`, { body, state }); forge.refresh(); }
        catch (err) { cf.querySelector('#ce').textContent = err.message; }
      };
      cf.onsubmit = e => { e.preventDefault(); send(); };
      cf.querySelector('#cs')?.addEventListener('click', () => send(issue.open ? 'closed' : 'open'));
    }
  }
};
