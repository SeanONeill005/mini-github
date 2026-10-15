// Login / sign-up dialog, account buttons in the header, and personal access tokens for `git push`.
export default async forge => {
  const { api, esc, html } = forge;
  let me = null;

  const loadMe = async () => { try { me = await api('GET', '/api/auth/me'); } catch { me = null; } };
  await loadMe();

  const changed = async () => { await loadMe(); await forge.refreshChrome(); forge.refresh(); };

  forge.canWrite = repo => !!me && !!repo && repo.owner === me.username;
  forge.onUnauthorized = () => {
    if (document.querySelector('dialog.auth[open]')) return; // the form shows its own error
    me = null;
    forge.refreshChrome();
    openAuth('login');
  };

  function modal(inner) {
    document.querySelectorAll('dialog.auth').forEach(d => d.remove());
    const dlg = html(`<dialog class="auth">${inner}</dialog>`).firstElementChild;
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
    return dlg;
  }

  function openAuth(mode = 'login') {
    const signup = mode === 'signup';
    const dlg = modal(`<form method="dialog">
      <h3>${signup ? 'Create your account' : 'Log in to Forge'}</h3>
      <label for="au">Username</label><input id="au" class="field" autocomplete="username" autocapitalize="none" spellcheck="false">
      ${signup ? '<label for="ae">Email <span class="mute">(used as the author of your commits)</span></label><input id="ae" class="field" type="email" autocomplete="email" placeholder="optional">' : ''}
      <label for="ap">Password</label><input id="ap" class="field" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" ${signup ? 'placeholder="At least 8 characters"' : ''}>
      <p class="err" id="aerr"></p>
      <div style="display:flex;gap:8px;align-items:center;margin-top:18px">
        <a href="#" id="swap" class="sm">${signup ? 'I already have an account' : 'Create an account'}</a><span class="sp"></span>
        <button class="btn" type="button" id="ac">Cancel</button>
        <button class="btn p" type="submit">${signup ? 'Sign up' : 'Log in'}</button>
      </div></form>`);
    const $ = s => dlg.querySelector(s);
    $('#au').focus();
    $('#ac').onclick = () => dlg.close();
    $('#swap').onclick = e => { e.preventDefault(); openAuth(signup ? 'login' : 'signup'); };
    $('form').onsubmit = async e => {
      e.preventDefault();
      try {
        await api('POST', `/api/auth/${signup ? 'register' : 'login'}`, {
          username: $('#au').value, password: $('#ap').value, ...(signup && { email: $('#ae').value }),
        });
        dlg.close();
        await changed();
      } catch (err) { $('#aerr').textContent = err.message; }
    };
  }

  async function openTokens() {
    const dlg = modal('<div id="tbody"></div>');
    const body = dlg.querySelector('#tbody');
    let fresh = null;

    async function draw() {
      const list = await api('GET', '/api/auth/tokens');
      body.innerHTML = `<h3>Access tokens</h3>
        <p class="mute sm" style="margin-top:0">A token is the password <code class="mono">git push</code> asks for. Your username is <b>${esc(me.username)}</b>.</p>
        ${fresh ? `<div class="box" style="padding:12px;margin-bottom:12px">
          <div class="sm" style="font-weight:600;margin-bottom:6px">Copy your new token now. It won't be shown again.</div>
          <div style="display:flex;gap:6px"><input class="field mono" id="tk" readonly value="${esc(fresh)}" aria-label="New token"><button class="btn sm" id="cp" type="button">Copy</button></div>
          <div class="mute sm" style="margin-top:8px">Then: <span class="mono">git push http://${esc(location.host)}/&lt;repo&gt;.git main</span><br>Username: <b>${esc(me.username)}</b>, password: the token.</div></div>` : ''}
        <div class="box">${list.length ? list.map(t => `<div class="row"><div style="flex:1"><b>${esc(t.name)}</b><div class="mute sm">Created ${esc(new Date(t.created).toLocaleDateString())}</div></div>
          <button class="btn sm" type="button" data-id="${esc(t.id)}">Revoke</button></div>`).join('') : '<div class="empty">No tokens yet.</div>'}</div>
        <form style="display:flex;gap:8px;margin-top:12px"><input id="tn" class="field" placeholder="Token name, e.g. laptop" aria-label="Token name"><button class="btn p" style="white-space:nowrap">Create token</button></form>
        <p class="err" id="terr"></p>
        <div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn" type="button" id="tc">Close</button></div>`;
      body.querySelector('#tc').onclick = () => dlg.close();
      const tk = body.querySelector('#tk');
      if (tk) {
        tk.onfocus = () => tk.select();
        body.querySelector('#cp').onclick = async e => {
          try { await navigator.clipboard.writeText(fresh); e.target.textContent = 'Copied'; } catch { tk.select(); e.target.textContent = 'Press Ctrl+C'; }
        };
      }
      body.querySelectorAll('button[data-id]').forEach(b => b.onclick = async () => {
        try { await api('DELETE', `/api/auth/tokens/${encodeURIComponent(b.dataset.id)}`); fresh = null; await draw(); }
        catch (err) { body.querySelector('#terr').textContent = err.message; }
      });
      body.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        try { fresh = (await api('POST', '/api/auth/tokens', { name: body.querySelector('#tn').value })).token; await draw(); }
        catch (err) { body.querySelector('#terr').textContent = err.message; }
      };
    }
    await draw();
  }

  forge.contribute('header', () => {
    if (!me) {
      const el = html('<span style="display:flex;gap:8px"><button class="btn" id="li">Log in</button><button class="btn" id="su">Sign up</button></span>').firstElementChild;
      el.querySelector('#li').onclick = () => openAuth('login');
      el.querySelector('#su').onclick = () => openAuth('signup');
      return el;
    }
    const el = html(`<span style="display:flex;gap:8px;align-items:center"><b class="sm">${esc(me.username)}</b>
      <button class="btn" id="tok">Tokens</button><button class="btn" id="lo">Log out</button></span>`).firstElementChild;
    el.querySelector('#tok').onclick = () => openTokens().catch(err => alert(err.message));
    el.querySelector('#lo').onclick = async () => { await api('POST', '/api/auth/logout'); await changed(); };
    return el;
  });
};
