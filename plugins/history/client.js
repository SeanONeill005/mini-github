export default forge => {
  const { api, esc } = forge;
  const STATUS = { A: 'Added', M: 'Modified', D: 'Deleted', T: 'Type changed' };
  const ago = iso => {
    const s = (Date.now() - new Date(iso)) / 1000;
    for (const [n, u] of [[86400 * 365, 'year'], [86400 * 30, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']]) {
      if (s >= n) { const v = Math.floor(s / n); return `${v} ${u}${v > 1 ? 's' : ''} ago`; }
    }
    return 'just now';
  };


  const enc = encodeURIComponent;
  const stat = (a, d) => `<span style="color:var(--ok)">+${a}</span> <span style="color:var(--bad)">\u2212${d}</span>`;
  const tint = v => `color-mix(in srgb, var(--${v}) 18%, transparent)`;
  const CONTEXT = 3, FULL_BELOW = 200; // folded view keeps 3 unchanged lines around each change; short files open in full

  // One file of a commit: header with +/- counts, and the file's lines with additions and deletions marked.
  function fileBlock(ctx, f, open) {
    const el = forge.html(`<div class="box" style="margin:8px 0;overflow:hidden">
        <div class="row sm" style="gap:8px">
          <div role="button" tabindex="0" aria-expanded="false" style="display:flex;flex:1;min-width:0;gap:8px;align-items:center;cursor:pointer">
            <span class="pill">${esc(STATUS[f.status] || f.status)}</span>
            <span class="mono" style="flex:1;min-width:0;overflow-wrap:anywhere">${esc(f.path)}</span>
            ${f.binary ? '<span class="mute">binary</span>' : stat(f.additions, f.deletions)}</div>
          <button class="btn sm" data-m hidden></button></div>
        <div data-b hidden></div></div>`).firstElementChild;
    const head = el.querySelector('[role=button]'), body = el.querySelector('[data-b]'), toggle = el.querySelector('[data-m]');
    let data = null, full = false;
    const opened = new Set(); // folded runs the reader has expanded

    function draw() {
      if (data.binary) return (body.innerHTML = '<div class="row mute sm">Binary file: contents not shown.</div>');
      if (!data.lines.length) return (body.innerHTML = '<div class="row mute sm">No content changes (mode or empty file).</div>');
      const L = data.lines, keep = L.map(() => full);
      if (!full) L.forEach((l, i) => { if (l.t !== ' ') for (let k = Math.max(0, i - CONTEXT); k <= Math.min(L.length - 1, i + CONTEXT); k++) keep[k] = true; });
      const cell = (v, w) => `<span class="mute" style="flex:none;width:${w}px;text-align:right;padding:0 6px;user-select:none">${v ?? ''}</span>`;
      let rows = '';
      for (let i = 0; i < L.length; i++) {
        if (!keep[i] && !opened.has(i)) { // fold a run of unchanged lines
          let j = i; while (j < L.length && !keep[j]) j++;
          rows += `<div class="mute" data-run="${i}" role="button" tabindex="0" style="padding:2px 12px;cursor:pointer;background:var(--hov)">\u22ef ${j - i} unchanged line${j - i > 1 ? 's' : ''}</div>`;
          i = j - 1; continue;
        }
        const l = L[i], bg = l.t === '+' ? tint('ok') : l.t === '-' ? tint('bad') : 'transparent';
        const sign = l.t === ' ' ? '' : l.t === '+' ? '+' : '\u2212';
        rows += `<div style="display:flex;background:${bg}">${cell(l.o, 46)}${cell(l.n, 46)}<span style="flex:none;width:16px;text-align:center;user-select:none;color:var(--${l.t === '+' ? 'ok' : 'bad'})">${sign}</span><span style="flex:1;white-space:pre;padding-right:12px">${esc(l.s)}</span></div>`;
      }
      body.innerHTML = `<div class="mono sm" style="overflow-x:auto;border-top:1px solid var(--line)"><div style="min-width:max-content">${rows}</div></div>
        ${data.truncated ? '<div class="row mute sm">Large file: showing the first 5,000 lines.</div>' : ''}`;
      body.querySelectorAll('[data-run]').forEach(r => {
        const reveal = () => { // expand just this run
          const from = +r.dataset.run; let j = from; while (j < L.length && !keep[j]) j++;
          for (let k = from; k < j; k++) { keep[k] = true; opened.add(k); }
          draw();
        };
        r.onclick = reveal; r.onkeydown = e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), reveal());
      });
      toggle.hidden = !L.some(l => l.t === ' ');
      toggle.textContent = full ? 'Changes only' : 'Full file';
    }

    async function show() {
      head.setAttribute('aria-expanded', 'true');
      body.hidden = false;
      if (!data) {
        body.innerHTML = '<div class="row mute sm">Loading\u2026</div>';
        try {
          data = await api('GET', `${ctx.base}/commits/${ctx.sha}/diff?ref=${enc(ctx.ref)}&path=${enc(f.path)}`);
          full = data.lines.length <= FULL_BELOW;
        } catch (e) { return (body.innerHTML = `<div class="row err sm">${esc(e.message)}</div>`); }
      }
      draw();
    }
    const flip = () => { if (body.hidden) show(); else { body.hidden = true; toggle.hidden = true; head.setAttribute('aria-expanded', 'false'); } };
    head.onclick = flip;
    head.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } };
    toggle.onclick = () => { full = !full; opened.clear(); draw(); };
    if (open && !f.binary) show();
    return el;
  }

  // The commit's changelog: message, totals, and one block per changed file.
  function renderCommit(box, d, ctx) {
    const n = d.files.length;
    box.innerHTML = `<div style="margin:8px 0 4px"><b>${esc(d.subject)}</b>${d.body ? `<div class="mute" style="white-space:pre-wrap;margin-top:4px">${esc(d.body)}</div>` : ''}
      <div class="mute" style="margin-top:4px">${n ? `${n} file${n > 1 ? 's' : ''} changed \u00b7 ${stat(d.additions, d.deletions)}` : 'No file changes'}</div></div><div data-files></div>`;
    const holder = box.querySelector('[data-files]');
    for (const f of d.files) holder.append(fileBlock({ ...ctx, sha: d.sha }, f, n <= 3)); // few files: open them straight away
  }

  forge.registerTab({
    id: 'history', label: 'History', order: 5,
    async render(el, { repo, query }) {
      const ref = query.get('ref') || repo.defaultBranch;
      const base = `/api/repos/${encodeURIComponent(repo.name)}`;
      const branches = await api('GET', `${base}/branches`);
      el.innerHTML = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
          <select class="field" style="width:auto" id="hb" aria-label="Branch">${branches.map(b => `<option ${b === ref ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
          <span class="mute sm">Restoring adds a new commit; nothing is deleted.</span></div>
        <div class="box" id="hl"></div><p class="err" id="he"></p>
        <div style="margin-top:12px"><button class="btn" id="hm" hidden>Load older commits</button></div>`;
      el.querySelector('#hb').onchange = e => forge.navigate(forge.link(repo.name, 'history', { ref: e.target.value }));

      const list = el.querySelector('#hl'), err = el.querySelector('#he'), more = el.querySelector('#hm');
      let skip = 0, tip = null;

      async function load() {
        const page = await api('GET', `${base}/history?ref=${encodeURIComponent(ref)}&skip=${skip}`);
        tip = page.head;
        for (const c of page.commits) list.append(row(c, skip === 0 && c.sha === page.commits[0].sha));
        skip += page.commits.length;
        more.hidden = !page.hasMore;
      }

      function row(c, isLatest) {
        const r = forge.html(`<div class="row" style="flex-wrap:wrap">
            <div style="flex:1;min-width:0"><b>${esc(c.message)}</b>${c.merge ? ' <span class="pill">merge</span>' : ''}${isLatest ? ' <span class="pill">latest</span>' : ''}
              <div class="mute sm">${esc(c.by)} · <span title="${esc(c.date)}">${ago(c.date)}</span> · <span class="mono">${c.short}</span></div></div>
            <button class="btn sm" data-a="files">Changes</button>
            ${isLatest ? '' : '<button class="btn sm" data-a="restore">Restore</button>'}
            <div class="files sm" style="flex-basis:100%" hidden></div></div>`).firstElementChild;
        const files = r.querySelector('.files');
        r.querySelector('[data-a=files]').onclick = async () => {
          if (!files.hidden) return (files.hidden = true);
          try {
            renderCommit(files, await api('GET', `${base}/commits/${c.sha}?ref=${encodeURIComponent(ref)}`), { base, ref });
            files.hidden = false;
          } catch (e) { err.textContent = e.message; }
        };
        const rb = r.querySelector('[data-a=restore]');
        if (rb) rb.onclick = async () => {
          if (!confirm(`Restore ${ref} to ${c.short} ("${c.message}")?\n\nThis adds a new commit that makes the files match that version. Existing history is kept.`)) return;
          err.textContent = '';
          try { await api('POST', `${base}/restore`, { ref, sha: c.sha }); forge.refresh(); }
          catch (e) { err.textContent = e.message; }
        };
        return r;
      }

      more.onclick = () => load().catch(e => (err.textContent = e.message));
      try { await load(); } catch (e) { err.textContent = e.message; }
    },
  });
};
