// Frontend core. It knows how to route and host repos; everything else plugs in through `forge`:
//   forge.registerTab({ id, label: string | repo => string, order, render(el, ctx) })
//   forge.contribute(slot, ctx => string | Node | null)      slots: 'repo-actions'
//   forge.registerRenderer({ match: filename => bool, render: text => html })
// Plugins ship a client.js (default export: forge => {...}) that is loaded from /api/manifest.

const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = s => document.querySelector(s);
const html = s => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content; };

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

const link = (repo, tab, params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  return `#/${encodeURIComponent(repo)}/${tab}${q.size ? '?' + q : ''}`;
};

const tabs = [], slots = {}, renderers = [];
const forge = {
  api, esc, html, link,
  registerTab: t => tabs.push(t),
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
    const parts = dirPath.split('/').filter(Boolean);
    const sub = n => parts.slice(0, n).join('/');

    el.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:4px">
        <select class="field" style="width:auto" id="br" aria-label="Switch branch">${branches.map(b => `<option ${b === ref ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
        <button class="btn" id="nb">New branch</button>
        ${ref !== 'main' ? '<button class="btn" id="db">Delete branch</button>' : ''}
        <span class="sp"></span>
        <span class="mute sm">${esc(log[0]?.message || '')} · ${log.length} commits · ${branches.length} branches</span>
        ${isFile ? '' : `<a class="btn" href="${here({ new: 1 })}">Add file</a>`}
      </div>
      <div class="crumb mono"><a href="${link(repo.name, 'code', { ref })}">${esc(repo.name)}</a>${parts.map((p, i) => `/<a href="${link(repo.name, 'code', { ref, path: sub(i + 1) })}">${esc(p)}</a>`).join('')}</div>
      <div id="body"></div>`;

    const body = el.querySelector('#body');
    el.querySelector('#br').onchange = e => forge.navigate(link(repo.name, 'code', { ref: e.target.value }));
    el.querySelector('#nb').onclick = async () => {
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

    const editing = query.get('edit') && isFile, adding = query.get('new') && !isFile;
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
      body.innerHTML = `<div class="box"><div class="row sm"><b>${esc(parts.at(-1))}</b><span class="mute">${lines.length} lines</span><span class="sp"></span><a class="btn sm" href="${here({ edit: 1 })}">Edit file</a></div>
        <div class="code"><pre class="ln">${lines.map((_, i) => i + 1).join('\n')}</pre><pre>${esc(lines.join('\n'))}</pre></div></div>`;
    } else {
      entries.sort((a, b) => (a.type === 'file') - (b.type === 'file') || a.name.localeCompare(b.name));
      body.innerHTML = `<div class="box">${parts.length ? `<div class="row h"><a href="${link(repo.name, 'code', { ref, path: sub(parts.length - 1) })}">..</a></div>` : ''}
        ${entries.map(n => `<div class="row h"><span class="mute mono" style="width:18px">${n.type === 'dir' ? '▸' : '-'}</span><a href="${link(repo.name, 'code', { ref, path: [dirPath, n.name].filter(Boolean).join('/') })}">${esc(n.name)}</a></div>`).join('')}</div>`;
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
  const repos = (await api('GET', '/api/repos')).filter(r => (r.name + r.description).toLowerCase().includes(q));
  app.innerHTML = `<div class="hero"><h1>Where code lives</h1><p class="mute">Host repositories and read code in one place.</p></div>
    <h3>Repositories <span class="pill">${repos.length}</span></h3><div class="box" id="list"></div>`;
  const list = $('#list');
  if (!repos.length) list.innerHTML = `<div class="empty">${q ? `No repositories match "${esc(forge.search)}".` : 'No repositories yet. Create your first one.'}</div>`;
  for (const r of repos) {
    const row = html(`<div class="row h"><div style="flex:1;min-width:0"><a href="${link(r.name, 'code')}"><b>you/${esc(r.name)}</b></a> <span class="pill">Public</span>
      <div class="mute sm">${esc(r.description) || 'No description'}</div></div><span class="actions"></span></div>`);
    list.append(row);
    await forge.fillSlot('repo-actions', { repo: r }, list.lastElementChild.querySelector('.actions'));
  }
}

async function repoView({ name, tab, query }) {
  const repo = await api('GET', `/api/repos/${encodeURIComponent(name)}`);
  const sorted = [...tabs].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  const active = sorted.find(t => t.id === tab) || sorted[0];
  app.innerHTML = `<h2 class="title"><span class="mute" style="font-weight:400">you /</span> ${esc(repo.name)} <span class="pill">Public</span><span class="sp"></span><span class="actions"></span></h2>
    <p class="mute" style="margin:6px 0 0">${esc(repo.description) || 'No description'}</p>
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
    if (name) await repoView({ name: decodeURIComponent(name), tab, query: new URLSearchParams(q || '') });
    else await home();
  } catch (e) {
    if (mine === seq) app.innerHTML = `<div class="box"><div class="empty">${esc(e.message)}. <a href="#/">Back to repositories</a></div></div>`;
  }
}
addEventListener('hashchange', route);

// ---------- chrome: search, theme, new-repo dialog ----------
$('#gs').oninput = e => { forge.search = e.target.value; location.hash.length > 2 ? (location.hash = '#/') : route(); };
$('#th').onclick = () => {
  const r = document.documentElement, dark = getComputedStyle(r).getPropertyValue('--bg').trim() === '#12161c';
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
  try { (await import(`/plugins/${id}/client.js`)).default(forge); }
  catch (e) { console.error(`plugin ${id} failed to load`, e); }
}
route();
