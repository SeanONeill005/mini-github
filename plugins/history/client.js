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
            const d = await api('GET', `${base}/commits/${c.sha}?ref=${encodeURIComponent(ref)}`);
            files.innerHTML = d.files.length ? d.files.map(f => `<div class="mono">${esc(STATUS[f.status] || f.status)} · ${esc(f.path)}</div>`).join('') : '<span class="mute">No file changes</span>';
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
