// Frontend core. It knows how to route and host repos; everything else plugs in through `forge`:
//   forge.registerTab({ id, label: string | repo => string, order, render(el, ctx) })
//   forge.contribute(slot, ctx => string | Node | null)      slots: 'repo-actions'
//   forge.registerRenderer({ match: filename => bool, render: text => html })
//   forge.registerPage({ match: firstSegment => bool, render(el, { name, query }) })   e.g. #/~user
// Plugins ship a client.js (default export: forge => {...}) that is loaded from /api/manifest.

const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = s => document.querySelector(s);
const html = s => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content; };

const svg = d => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const icons = {
  star: svg('<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>'),
  issue: svg('<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1" fill="currentColor"/>'),
  pull: svg('<circle cx="4.5" cy="3.5" r="1.7"/><circle cx="4.5" cy="12.5" r="1.7"/><circle cx="11.5" cy="12.5" r="1.7"/><path d="M4.5 5.2v5.6M11.5 10.8V7a2 2 0 00-2-2H8"/>'),
  folder: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.5 3.6c0-.6.5-1.1 1.1-1.1h3.1c.3 0 .6.1.8.4l.9 1h6c.6 0 1.1.5 1.1 1.1v7.4c0 .6-.5 1.1-1.1 1.1H2.6c-.6 0-1.1-.5-1.1-1.1z"/></svg>',
  file: svg('<path d="M4 1.8h5l3.2 3.2v8.2a1 1 0 01-1 1H4a1 1 0 01-1-1V2.8a1 1 0 011-1z"/><path d="M9 1.8V5h3.2"/>'),
};
// A stable gradient "avatar" for a name: same name, same colour.
const hue = n => { let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) % 30; return 4 + h; }; // ember range: reds to ambers
const avatar = (name, cls = '') => `<span class="avatar ${cls}" style="--h:${hue(name)}" aria-hidden="true">${esc(String(name || '?')[0])}</span>`;

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) {
    if (res.status === 401) forge.onUnauthorized?.();
    throw new Error(data?.error || res.statusText);
  }
  return data;
}

const link = (repo, tab, params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  return `#/${encodeURIComponent(repo)}/${tab}${q.size ? '?' + q : ''}`;
};

const tabs = [], slots = {}, renderers = [], pages = [];
const forge = {
  api, esc, html, link, icons, avatar,
  registerTab: t => tabs.push(t),
  registerPage: p => pages.push(p),
  contribute: (slot, fn) => (slots[slot] ||= []).push(fn),
  registerRenderer: r => renderers.push(r),
  refresh: () => route(),
  navigate: hash => { location.hash === hash ? route() : (location.hash = hash); },
  async fillSlot(slot, ctx, into) {
    for (const fn of slots[slot] || []) {
      const out = await fn(ctx);
      if (out) into.append(typeof out === 'string' ? html(out) : out);
    }
  },
  renderFile: (name, text) => renderers.find(r => r.match(name))?.render(text),
  search: '',
  canWrite: () => true, // the auth plugin decides who may change a repo
  onUnauthorized: null, // called when the API answers 401
  async refreshChrome() { const el = $('#acct'); el.replaceChildren(); await forge.fillSlot('header', {}, el); },
};
window.forge = forge;

// ---------- built-in markdown renderer (a plugin could replace it with a fuller one) ----------
forge.registerRenderer({
  match: n => /\.md$/i.test(n),
  render: t => t.split(/\n\n+/).map(b => {
    b = esc(b).replace(/`([^`]+)`/g, '<code class="mono">$1</code>');
    return b.startsWith('# ') ? `<h1>${b.slice(2)}</h1>` : b.startsWith('## ') ? `<h2>${b.slice(3)}</h2>` : `<p>${b}</p>`;
  }).join(''),
});

// ---------- built-in Code tab ----------
forge.registerTab({
  id: 'code', label: 'Code', order: 0,
  async render(el, { repo, query }) {
    const ref = query.get('ref') || repo.defaultBranch, dirPath = query.get('path') || '';
    const base = `/api/repos/${encodeURIComponent(repo.name)}`, q = (o = {}) => new URLSearchParams({ ref, path: dirPath, ...o });
    const here = (o = {}) => link(repo.name, 'code', { ref, path: dirPath, ...o });
    const [branches, log] = await Promise.all([api('GET', `${base}/branches`), api('GET', `${base}/log?ref=${encodeURIComponent(ref)}`).catch(() => [])]);

    let entries = null, content = null;
    try { entries = await api('GET', `${base}/tree?${q()}`); }
    catch (e) { content = (await api('GET', `${base}/blob?${q()}`)).content; }
    const isFile = content !== null;
    const canWrite = forge.canWrite(repo);
    const parts = dirPath.split('/').filter(Boolean);
    const sub = n => parts.slice(0, n).join('/');

    el.innerHTML = `
      <div class="toolbar">
        <select class="field" style="width:auto" id="br" aria-label="Switch branch">${branches.map(b => `<option ${b === ref ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
        ${canWrite ? '<button class="btn" id="nb">New branch</button>' : ''}
        ${canWrite && ref !== 'main' ? '<button class="btn" id="db">Delete branch</button>' : ''}
        <span class="sp"></span>
        <span class="mute sm">${branches.length} branch${branches.length === 1 ? '' : 'es'}</span>
        ${isFile || !canWrite ? '' : `<a class="btn" href="${here({ new: 1 })}">Add file</a>`}
      </div>
      <div class="crumb mono"><a href="${link(repo.name, 'code', { ref })}">${esc(repo.name)}</a>${parts.map((p, i) => `/<a href="${link(repo.name, 'code', { ref, path: sub(i + 1) })}">${esc(p)}</a>`).join('')}</div>
      <div id="body"></div>`;

    const body = el.querySelector('#body');
    el.querySelector('#br').onchange = e => forge.navigate(link(repo.name, 'code', { ref: e.target.value }));
    const nb = el.querySelector('#nb');
    if (nb) nb.onclick = async () => {
      const name = prompt(`New branch name (copies ${ref})`);
      if (!name) return;
      try { const b = await api('POST', `${base}/branches`, { name, from: ref }); forge.navigate(link(repo.name, 'code', { ref: b.name })); }
      catch (e) { alert(e.message); }
    };
    const del = el.querySelector('#db');
    if (del) del.onclick = async () => {
      if (!confirm(`Delete branch "${ref}"?`)) return;
      await api('DELETE', `${base}/branches/${encodeURIComponent(ref)}`);
      forge.navigate(link(repo.name, 'code'));
    };

    const editing = canWrite && query.get('edit') && isFile, adding = canWrite && query.get('new') && !isFile;
    if (editing || adding) {
      const name = parts.at(-1);
      body.innerHTML = `<form class="box"><div class="row sm"><b>${adding ? 'New file on' : `Editing ${esc(name)} on`} ${esc(ref)}</b></div><div style="padding:0 16px 16px">
        ${adding ? '<label for="ef">File name</label><input id="ef" class="field mono" placeholder="notes.txt">' : ''}
        <label for="ec">Contents</label><textarea id="ec" class="field mono" rows="14" spellcheck="false">${adding ? '' : esc(content)}</textarea>
        <label for="em">Commit message</label><input id="em" class="field" placeholder="${adding ? 'Add file' : 'Update ' + esc(name)}">
        <p class="err" id="ee"></p>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px"><a class="btn" href="${here({ edit: '', new: '' })}">Cancel</a><button class="btn p">Commit to ${esc(ref)}</button></div></div></form>`;
      body.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        const file = adding ? body.querySelector('#ef').value.trim().replace(/\\/g, '/') : dirPath;
        if (!file) return (body.querySelector('#ee').textContent = 'Enter a file name.');
        const path = adding ? [dirPath, file].filter(Boolean).join('/') : dirPath;
        try {
          await api('PUT', `${base}/file`, { ref, path, isNew: !!adding, content: body.querySelector('#ec').value.replace(/\n?$/, '\n'), message: body.querySelector('#em').value });
          forge.navigate(link(repo.name, 'code', { ref, path }));
        } catch (err) { body.querySelector('#ee').textContent = err.message; }
      };
    } else if (isFile) {
      const lines = content.replace(/\n$/, '').split('\n');
      body.innerHTML = `<div class="box"><div class="row sm"><b>${esc(parts.at(-1))}</b><span class="mute">${lines.length} lines</span><span class="sp"></span>${canWrite ? `<a class="btn sm" href="${here({ edit: 1 })}">Edit file</a>` : ''}</div>
        <div class="code"><pre class="ln">${lines.map((_, i) => i + 1).join('\n')}</pre><pre>${esc(lines.join('\n'))}</pre></div></div>`;
    } else {
      entries.sort((a, b) => (a.type === 'file') - (b.type === 'file') || a.name.localeCompare(b.name));
      const last = log[0];
      body.innerHTML = `<div class="box files">
        ${last ? `<div class="row sm files-head">${avatar(last.by, 'xs')}<b>${esc(last.by)}</b><span class="msg mute">${esc(last.message)}</span><span class="sp"></span><span class="mute" style="white-space:nowrap">${log.length} commit${log.length === 1 ? '' : 's'}</span></div>` : ''}
        ${parts.length ? `<div class="row h"><span class="ico dir">${icons.folder}</span><a href="${link(repo.name, 'code', { ref, path: sub(parts.length - 1) })}">..</a></div>` : ''}
        ${entries.map(n => `<div class="row h"><span class="ico ${n.type === 'dir' ? 'dir' : ''}">${n.type === 'dir' ? icons.folder : icons.file}</span><a href="${link(repo.name, 'code', { ref, path: [dirPath, n.name].filter(Boolean).join('/') })}">${esc(n.name)}</a></div>`).join('')}</div>`;
      const readme = entries.find(n => n.type === 'file' && forge.renderFile(n.name, ''));
      if (readme && !parts.length) {
        const r = await api('GET', `${base}/blob?${q({ path: readme.name })}`);
        body.append(html(`<div class="box" style="margin-top:16px"><div class="row sm"><b>${esc(readme.name)}</b></div><div class="readme">${forge.renderFile(readme.name, r.content)}</div></div>`));
      }
    }
  },
});

// ---------- views ----------
const app = $('#app');

async function home() {
  const q = forge.search.toLowerCase();
  const all = await api('GET', '/api/repos');
  const repos = all.filter(r => (r.name + r.description).toLowerCase().includes(q));
  const sum = k => all.reduce((n, r) => n + (r[k] || 0), 0);
  app.innerHTML = `<section class="hero">
      <span class="eyebrow">Self-hosted git, built to be extended</span>
      <h1>Where code gets <em>forged</em>.</h1>
      <p>Host repositories, track issues and review pull requests in one small, fast place that you own.</p>
      <div class="hero-cta"><button class="btn p lg" id="hn">New repository</button><a class="btn lg" href="#repos">Browse repositories</a></div>
      <div class="stats">
        <div class="stat"><b>${all.length}</b><span>repositories</span></div>
        <div class="stat"><b>${sum('count')}</b><span>stars</span></div>
        <div class="stat"><b>${sum('openIssues')}</b><span>open issues</span></div>
        <div class="stat"><b>${sum('openPulls')}</b><span>open pull requests</span></div>
      </div></section>
    <div class="section-head" id="repos"><h3>Repositories</h3><span class="pill">${repos.length}</span></div>
    <div class="cards" id="list"></div>`;
  $('#hn').onclick = () => $('#new').click();
  $('a[href="#repos"]').onclick = e => { e.preventDefault(); $('#repos').scrollIntoView({ behavior: 'smooth' }); };
  const list = $('#list');
  if (!repos.length) {
    list.outerHTML = `<div class="box"><div class="empty">${q ? `No repositories match "${esc(forge.search)}".` : 'No repositories yet. Create your first one.'}</div></div>`;
    return;
  }
  for (const r of repos) {
    const owner = r.owner || 'you';
    list.append(html(`<article class="card">
      <div class="card-top">${avatar(owner)}<div class="card-name"><a href="${link(r.name, 'code')}"><span>${esc(owner)} /</span> ${esc(r.name)}</a><span class="pill">Public</span></div></div>
      <p class="desc">${esc(r.description) || 'No description'}</p>
      <div class="card-foot">
        <span class="meta" title="Stars">${icons.star}${r.count || 0}</span>
        <span class="meta" title="Open issues">${icons.issue}${r.openIssues || 0}</span>
        <span class="meta" title="Open pull requests">${icons.pull}${r.openPulls || 0}</span>
        <span class="sp"></span><span class="actions"></span>
      </div></article>`));
    await forge.fillSlot('repo-actions', { repo: r }, list.lastElementChild.querySelector('.actions'));
  }
}

async function repoView({ name, tab, query }) {
  const repo = await api('GET', `/api/repos/${encodeURIComponent(name)}`);
  const sorted = [...tabs].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  const active = sorted.find(t => t.id === tab) || sorted[0];
  const owner = repo.owner || 'you';
  app.innerHTML = `<div class="repo-head">${avatar(owner, 'lg')}<div class="repo-id">
      <h2 class="title">${repo.owner ? `<a href="#/~${encodeURIComponent(repo.owner)}">${esc(repo.owner)}</a>` : 'you'}<span class="slash">/</span>${esc(repo.name)} <span class="pill">Public</span></h2>
      <p class="desc">${esc(repo.description) || 'No description'}</p></div><span class="actions"></span></div>
    <div class="tabs" role="tablist">${sorted.map(t => `<a class="tab ${t === active ? 'on' : ''}" role="tab" href="${link(name, t.id)}">${esc(typeof t.label === 'function' ? t.label(repo) : t.label)}</a>`).join('')}</div>
    <div id="tab"></div>`;
  await forge.fillSlot('repo-actions', { repo }, app.querySelector('.actions'));
  await active.render($('#tab'), { repo, query });
}

let seq = 0;
async function route() {
  const mine = ++seq;
  const [p, q] = location.hash.slice(2).split('?');
  const [name, tab] = p.split('/');
  try {
    const page = name && pages.find(p => p.match(decodeURIComponent(name)));
    if (page) await page.render(app, { name: decodeURIComponent(name), query: new URLSearchParams(q || '') });
    else if (name) await repoView({ name: decodeURIComponent(name), tab, query: new URLSearchParams(q || '') });
    else await home();
  } catch (e) {
    if (mine === seq) app.innerHTML = `<div class="box"><div class="empty">${esc(e.message)}. <a href="#/">Back to repositories</a></div></div>`;
  }
}
addEventListener('hashchange', route);

// ---------- chrome: search, theme, new-repo dialog ----------
$('#gs').oninput = e => { forge.search = e.target.value; location.hash.length > 2 ? (location.hash = '#/') : route(); };
$('#th').onclick = () => {
  const r = document.documentElement, dark = getComputedStyle(r).getPropertyValue('--dark').trim() === '1';
  r.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('forge-theme', r.dataset.theme); } catch { /* storage unavailable */ }
};
try { const t = localStorage.getItem('forge-theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* storage unavailable */ }

$('#new').onclick = () => { $('#rn').value = ''; $('#rd').value = ''; $('#re').textContent = ''; $('#dlg').showModal(); $('#rn').focus(); };
$('#rc').onclick = () => $('#dlg').close();
$('#dlg form').onsubmit = async e => {
  e.preventDefault();
  if (!$('#rn').value.trim()) return $('#rn').focus();
  try {
    const repo = await api('POST', '/api/repos', { name: $('#rn').value, description: $('#rd').value });
    $('#dlg').close();
    forge.navigate(link(repo.name, 'code'));
  } catch (err) { $('#re').textContent = err.message; }
};

// ---------- load plugins, then start ----------
const { plugins } = await api('GET', '/api/manifest');
for (const id of plugins) {
  try { await (await import(`/plugins/${id}/client.js`)).default(forge); }
  catch (e) { console.error(`plugin ${id} failed to load`, e); }
}
await forge.refreshChrome();
route();
