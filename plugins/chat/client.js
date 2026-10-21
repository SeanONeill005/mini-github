// Chat tab: a live message thread for the repo's owner and collaborators. Polls for new messages while open.
export default async forge => {
  const { api, esc } = forge;
  const POLL_MS = 3000;

  const clock = iso => {
    const d = new Date(iso), today = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
  };

  forge.registerTab({
    id: 'chat', label: 'Chat', order: 70,
    async render(el, { repo }) {
      const me = await api('GET', '/api/auth/me').catch(() => null);
      if (!me) { el.innerHTML = '<div class="box"><div class="empty">Log in to use this repository\'s chat.</div></div>'; return; }
      if (!forge.canWrite(repo)) {
        el.innerHTML = '<div class="box"><div class="empty">Chat is private to the owner and collaborators of this repository.</div></div>';
        return;
      }

      const base = `/api/repos/${encodeURIComponent(repo.name)}/chat`;
      el.innerHTML = `<p class="mute sm">A private room for ${esc(repo.owner || 'the owner')} and collaborators. Enter sends, Shift+Enter adds a new line.</p>
        <div class="box"><div id="msgs" role="log" aria-live="polite" style="height:min(55vh,480px);overflow-y:auto;padding:8px 0"></div>
        <form id="cf" style="display:flex;gap:8px;align-items:flex-end;padding:12px;border-top:1px solid var(--line)">
          <textarea class="field" id="ct" rows="2" maxlength="2000" placeholder="Message the team" aria-label="Message" style="resize:none"></textarea>
          <button class="btn p" id="cs">Send</button></div></div>
        <p class="err" id="ce"></p>`;
      const box = el.querySelector('#msgs'), form = el.querySelector('#cf'), input = el.querySelector('#ct'), err = el.querySelector('#ce');
      let last = 0, empty = true;

      const row = m => {
        const mine = m.by === me.username, canDelete = mine || repo.owner === me.username;
        return `<div class="row" data-id="${m.id}" style="align-items:flex-start;padding:6px 18px;border-top:0">
          <div style="min-width:0;flex:1"><div class="sm"><b${mine ? ' style="color:var(--acc)"' : ''}>${esc(m.by)}</b> <span class="mute">${esc(clock(m.created))}</span></div>
          <div style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(m.body)}</div></div>
          ${canDelete ? `<button class="btn sm" data-del="${m.id}" aria-label="Delete message">Delete</button>` : ''}</div>`;
      };

      function append(messages) {
        if (!messages.length) return;
        const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60; // only follow new messages if already at the bottom
        if (empty) { box.innerHTML = ''; empty = false; }
        box.insertAdjacentHTML('beforeend', messages.map(row).join(''));
        last = Math.max(last, ...messages.map(m => m.id));
        if (stick) box.scrollTop = box.scrollHeight;
      }

      async function poll(first) {
        try {
          append(await api('GET', last ? `${base}?after=${last}` : base));
          if (first && empty) box.innerHTML = '<div class="empty">No messages yet. Say hello.</div>';
          err.textContent = '';
        } catch (e) { if (first) err.textContent = e.message; }
      }

      await poll(true);
      box.scrollTop = box.scrollHeight;
      const timer = setInterval(() => {
        if (!el.isConnected) return clearInterval(timer); // navigated to another tab or page
        if (!document.hidden) poll(false);
      }, POLL_MS);

      form.onsubmit = async e => {
        e.preventDefault();
        const body = input.value.trim();
        if (!body) return;
        form.querySelector('#cs').disabled = true;
        try {
          const msg = await api('POST', base, { body });
          input.value = '';
          err.textContent = '';
          await poll(false); // also picks up anything posted by others since the last poll
          if (!box.querySelector(`[data-id="${msg.id}"]`)) append([msg]);
          box.scrollTop = box.scrollHeight;
        } catch (e2) { err.textContent = e2.message; }
        form.querySelector('#cs').disabled = false;
        input.focus();
      };
      input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } };

      box.onclick = async e => {
        const id = e.target.dataset?.del;
        if (!id || !confirm('Delete this message?')) return;
        try {
          await api('DELETE', `${base}/${id}`);
          box.querySelector(`[data-id="${id}"]`)?.remove();
          if (!box.children.length) { empty = true; box.innerHTML = '<div class="empty">No messages yet. Say hello.</div>'; }
        } catch (e2) { err.textContent = e2.message; }
      };
    },
  });
};
