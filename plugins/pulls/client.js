export default forge => {
  const { api, esc, html, link } = forge;

  const ago = iso => {
    const s = (Date.now() - new Date(iso)) / 1000;
    for (const [n, u] of [[86400 * 365, 'year'], [86400 * 30, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']]) {
      if (s >= n) { const v = Math.floor(s / n); return `${v} ${u}${v > 1 ? 's' : ''} ago`; }
    }
    return 'just now';
  };

  const STATE = { open: ['Open', 'var(--ok)'], merged: ['Merged', '#8250df'], closed: ['Closed', 'var(--bad)'] };
  const pill = s => `<span class="pill" style="color:${STATE[s][1]};border-color:${STATE[s][1]}">${STATE[s][0]}</span>`;
  const FILE = { A: 'Added', M: 'Modified', D: 'Deleted', T: 'Type changed' };

  const diffHtml = text => text.split('\n').map(l => {
    const c = /^\+(?!\+\+)/.test(l) ? 'var(--ok)' : /^-(?!--)/.test(l) ? 'var(--bad)' : /^(@@|diff )/.test(l) ? 'var(--mute)' : 'inherit';
    return `<span style="color:${c}">${esc(l)}</span>`;
  }).join('\n');

  // One-line, human-readable merge status for a /compare result.
  function statusLine(s, base, head) {
    if (!s) return '';
    if (s.unrelated) return `<span style="color:var(--bad)">✗ These branches have no common history.</span>`;
    if (s.upToDate) return `<span class="mute">Nothing to merge: <b>${esc(base)}</b> already contains every commit on <b>${esc(head)}</b>.</span>`;
    const counts = `${s.ahead} commit${s.ahead === 1 ? '' : 's'} ahead${s.behind ? `, ${s.behind} behind` : ''}`;
    if (s.mergeable) return `<span style="color:var(--ok)">✓ Can be merged automatically</span> <span class="mute">(${counts})</span>`;
    return `<span style="color:var(--bad)">✗ Merge conflicts in ${s.conflicts.map(f => `<span class="mono">${esc(f)}</span>`).join(', ')}</span>
      <div class="mute sm">Edit the conflicting files on <b>${esc(head)}</b> so they agree with <b>${esc(base)}</b>, then check again.</div>`;
  }
  const canMerge = s => s && s.mergeable && !s.upToDate && !s.unrelated;

  forge.registerTab({
    id: 'pulls', order: 8,
    label: repo => `Pull requests (${repo.openPulls ?? 0})`,
    async render(el, ctx) {
      const q = ctx.query;
      if (q.get('pr')) return detail(el, ctx, q.get('pr'));
      if (q.get('new')) return create(el, ctx);
      if (q.get('merge')) return direct(el, ctx);
      return list(el, ctx);
    },
  });

  const baseUrl = repo => `/api/repos/${encodeURIComponent(repo.name)}`;
  // Writes are owner-only on the server; the UI just avoids offering buttons that would be refused.
  const readOnly = (el, repo, what) => {
    el.innerHTML = `<div class="box"><div class="empty">Only ${esc(repo.owner || 'the owner')} can ${what}. <a href="${link(repo.name, 'pulls')}">Back to pull requests</a></div></div>`;
  };
  const select = (id, label, opts, selected) =>
    `<select class="field" style="width:auto" id="${id}" aria-label="${label}">${opts.map(b => `<option ${b === selected ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>`;

  // ---------- list ----------
  async function list(el, { repo, query }) {
    const showClosed = query.get('state') === 'closed';
    const pulls = await api('GET', `${baseUrl(repo)}/pulls`);
    const open = pulls.filter(p => p.state === 'open'), done = pulls.filter(p => p.state !== 'open');
    const shown = showClosed ? done : open;
    const tab = (on, label, n, params) => `<a href="${link(repo.name, 'pulls', params)}" style="${on ? 'font-weight:600;color:var(--text)' : 'color:var(--mute)'}">${label} (${n})</a>`;
    el.innerHTML = `<div style="display:flex;gap:16px;align-items:center;margin-bottom:12px">
        ${tab(!showClosed, 'Open', open.length, {})}${tab(showClosed, 'Closed', done.length, { state: 'closed' })}
        <span class="sp"></span>
        ${forge.canWrite(repo) ? `<a class="btn" href="${link(repo.name, 'pulls', { merge: 1 })}">Merge branches</a>
        <a class="btn p" href="${link(repo.name, 'pulls', { new: 1 })}">New pull request</a>` : ''}</div>
      <div class="box">${shown.length ? shown.map(p => `<div class="row h">
          <div style="flex:1;min-width:0"><a href="${link(repo.name, 'pulls', { pr: p.id })}"><b>${esc(p.title)}</b></a> ${pill(p.state)}
            <div class="mute sm">#${p.id} · ${esc(p.by)} · ${ago(p.updated || p.created)} · <span class="mono">${esc(p.head)} → ${esc(p.base)}</span></div></div></div>`).join('')
        : `<div class="empty">${showClosed ? 'No closed pull requests.' : 'No open pull requests.' + (forge.canWrite(repo) ? ' Create a branch, commit or push to it, then open one.' : '')}</div>`}</div>`;
  }

  // ---------- new pull request ----------
  async function create(el, { repo }) {
    if (!forge.canWrite(repo)) return readOnly(el, repo, 'open pull requests here');
    const base = baseUrl(repo);
    const branches = await api('GET', `${base}/branches`);
    if (branches.length < 2) {
      el.innerHTML = `<div class="box"><div class="empty">You need at least two branches. Create one from the <a href="${link(repo.name, 'code')}">Code tab</a>, commit to it, then come back. <a href="${link(repo.name, 'pulls')}">Cancel</a></div></div>`;
      return;
    }
    const baseDefault = branches.includes(repo.defaultBranch) ? repo.defaultBranch : branches[0];
    const headDefault = branches.find(b => b !== baseDefault);
    el.innerHTML = `<form class="box"><div class="row sm"><b>Open a pull request</b></div><div style="padding:0 16px 16px">
        <div style="display:flex;gap:8px;align-items:center;margin:12px 0 8px"><span class="mute sm">Merge</span>${select('ph', 'Compare branch', branches, headDefault)}
          <span class="mute sm">into</span>${select('pb', 'Base branch', branches, baseDefault)}</div>
        <div class="sm" id="ps" style="margin-bottom:8px"></div>
        <label for="pt">Title</label><input id="pt" class="field" placeholder="What does this change do?">
        <label for="pd">Description</label><textarea id="pd" class="field" rows="6"></textarea>
        <p class="err" id="pe"></p>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px"><a class="btn" href="${link(repo.name, 'pulls')}">Cancel</a><button class="btn p" id="pc">Create pull request</button></div></div></form>`;
    const head = el.querySelector('#ph'), bs = el.querySelector('#pb'), st = el.querySelector('#ps'), btn = el.querySelector('#pc'), err = el.querySelector('#pe');
    let seq = 0;
    async function check() {
      const mine = ++seq;
      if (head.value === bs.value) { st.innerHTML = '<span class="mute">Choose two different branches.</span>'; btn.disabled = true; return; }
      st.textContent = 'Checking…';
      try {
        const s = await api('GET', `${base}/compare?base=${encodeURIComponent(bs.value)}&head=${encodeURIComponent(head.value)}`);
        if (mine !== seq) return;
        st.innerHTML = statusLine(s, bs.value, head.value);
        btn.disabled = s.upToDate || s.unrelated; // conflicts are allowed: you can still open the PR and fix it
      } catch (e) { if (mine === seq) st.textContent = e.message; }
    }
    head.onchange = bs.onchange = check;
    check();
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault(); err.textContent = '';
      try {
        const pr = await api('POST', `${base}/pulls`, { base: bs.value, head: head.value, title: el.querySelector('#pt').value, body: el.querySelector('#pd').value });
        forge.navigate(link(repo.name, 'pulls', { pr: pr.id }));
      } catch (ex) { err.textContent = ex.message; }
    };
  }

  // ---------- direct branch merge ----------
  async function direct(el, { repo }) {
    if (!forge.canWrite(repo)) return readOnly(el, repo, 'merge branches here');
    const base = baseUrl(repo);
    const branches = await api('GET', `${base}/branches`);
    if (branches.length < 2) {
      el.innerHTML = `<div class="box"><div class="empty">You need at least two branches to merge. <a href="${link(repo.name, 'pulls')}">Back</a></div></div>`;
      return;
    }
    const into0 = branches.includes(repo.defaultBranch) ? repo.defaultBranch : branches[0];
    el.innerHTML = `<form class="box"><div class="row sm"><b>Merge branches</b><span class="mute">Merges now, without a pull request.</span></div><div style="padding:0 16px 16px">
        <div style="display:flex;gap:8px;align-items:center;margin:12px 0 8px"><span class="mute sm">Merge</span>${select('mf', 'From branch', branches, branches.find(b => b !== into0))}
          <span class="mute sm">into</span>${select('mi', 'Into branch', branches, into0)}</div>
        <div class="sm" id="ms" style="margin-bottom:8px"></div><p class="err" id="me"></p>
        <div style="display:flex;gap:8px;justify-content:flex-end"><a class="btn" href="${link(repo.name, 'pulls')}">Cancel</a><button class="btn p" id="mb">Merge</button></div></div></form>`;
    const from = el.querySelector('#mf'), into = el.querySelector('#mi'), st = el.querySelector('#ms'), btn = el.querySelector('#mb'), err = el.querySelector('#me');
    let seq = 0;
    async function check() {
      const mine = ++seq; err.textContent = '';
      if (from.value === into.value) { st.innerHTML = '<span class="mute">Choose two different branches.</span>'; btn.disabled = true; return; }
      st.textContent = 'Checking…'; btn.disabled = true;
      try {
        const s = await api('GET', `${base}/compare?base=${encodeURIComponent(into.value)}&head=${encodeURIComponent(from.value)}`);
        if (mine !== seq) return;
        st.innerHTML = statusLine(s, into.value, from.value);
        btn.disabled = !canMerge(s);
      } catch (e) { if (mine === seq) st.textContent = e.message; }
    }
    from.onchange = into.onchange = check;
    check();
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      if (!confirm(`Merge ${from.value} into ${into.value}?`)) return;
      btn.disabled = true;
      try {
        await api('POST', `${base}/merge`, { from: from.value, into: into.value });
        forge.navigate(link(repo.name, 'history', { ref: into.value }));
      } catch (ex) { err.textContent = ex.message; check(); }
    };
  }

  // ---------- pull request detail ----------
  async function detail(el, { repo }, id) {
    const base = baseUrl(repo), url = `${base}/pulls/${encodeURIComponent(id)}`;
    const pr = await api('GET', url);
    const back = link(repo.name, 'pulls');
    const canEdit = forge.canWrite(repo);
    const act = async (fn) => { try { await fn(); forge.refresh(); } catch (e) { el.querySelector('#pe').textContent = e.message; } };

    let panel;
    if (pr.state === 'merged') {
      panel = `<b style="color:#8250df">Merged</b> <span class="mute">${pr.mergedBy ? `by ${esc(pr.mergedBy)} ` : ''}into <b>${esc(pr.base)}</b> ${ago(pr.mergedAt)} as <span class="mono">${esc(pr.mergeSha.slice(0, 7))}</span> · <a href="${link(repo.name, 'history', { ref: pr.base })}">View history</a></span>`;
    } else if (pr.state === 'closed') {
      panel = `<b style="color:var(--bad)">Closed</b> <span class="mute">${pr.closedAt ? ago(pr.closedAt) : ''}</span>
        ${canEdit ? '<div style="margin-top:10px"><button class="btn" id="po">Reopen pull request</button></div>' : ''}`;
    } else if (pr.problem) {
      panel = `<span style="color:var(--bad)">✗ ${esc(pr.problem)}</span>${canEdit ? '<div style="margin-top:10px"><button class="btn" id="pcl">Close pull request</button></div>' : ''}`;
    } else {
      panel = `<div>${statusLine(pr.status, pr.base, pr.head)}</div>
        ${canEdit ? `<div style="margin-top:10px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <button class="btn p" id="pm" ${canMerge(pr.status) ? '' : 'disabled'}>Merge pull request</button>
          <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="pdb" ${pr.head === 'main' ? 'disabled' : ''}> Delete <span class="mono">${esc(pr.head)}</span> after merging</label>
          <span class="sp"></span><button class="btn" id="pcl">Close pull request</button></div>` : ''}`;
    }

    el.innerHTML = `<p><a href="${back}">← All pull requests</a></p>
      <h3 style="margin:0 0 4px">${esc(pr.title)} <span class="mute" style="font-weight:400">#${pr.id}</span> ${pill(pr.state)}</h3>
      <div class="mute sm">${esc(pr.by)} opened ${ago(pr.created)} · <span class="mono">${esc(pr.head)} → ${esc(pr.base)}</span></div>
      ${pr.body ? `<p style="white-space:pre-wrap">${esc(pr.body)}</p>` : ''}
      <div class="box" style="padding:14px;margin:14px 0">${panel}<p class="err" id="pe"></p></div>
      <h4 style="margin:18px 0 8px">Commits <span class="pill">${pr.commits.length}</span></h4>
      <div class="box">${pr.commits.map(c => `<div class="row"><div style="flex:1;min-width:0"><b>${esc(c.message)}</b><div class="mute sm">${esc(c.by)} · ${ago(c.date)}</div></div><span class="mono mute sm">${c.short}</span></div>`).join('') || '<div class="empty">No commits.</div>'}</div>
      <h4 style="margin:18px 0 8px">Files changed <span class="pill">${pr.files.length}</span></h4>
      <div class="box">${pr.files.map(f => `<div class="row sm"><span class="mute" style="width:90px">${esc(FILE[f.status] || f.status)}</span><span class="mono">${esc(f.path)}</span></div>`).join('') || '<div class="empty">No file changes.</div>'}</div>
      ${pr.diff ? `<div class="box" style="margin-top:12px"><pre class="mono sm" style="margin:0;padding:12px 16px;overflow:auto">${diffHtml(pr.diff)}</pre></div>${pr.truncated ? '<p class="mute sm">Diff truncated; it is too large to show in full.</p>' : ''}` : ''}`;

    const on = (sel, fn) => { const b = el.querySelector(sel); if (b) b.onclick = fn; };
    on('#pm', () => act(async () => {
      if (!confirm(`Merge #${pr.id} into ${pr.base}?`)) throw new Error('');
      await api('POST', `${url}/merge`, { deleteBranch: el.querySelector('#pdb').checked });
    }));
    on('#pcl', () => act(() => api('PATCH', url, { state: 'closed' })));
    on('#po', () => act(() => api('PATCH', url, { state: 'open' })));
  }
}
