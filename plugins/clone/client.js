export default forge => {
  forge.contribute('repo-actions', ({ repo }) => {
    const cmd = `git clone ${location.origin}/${repo.name}.git`;
    const el = forge.html(`<details class="clone" style="display:inline-block;position:relative">
      <summary class="btn sm" style="list-style:none">Clone</summary>
      <div class="box" style="position:absolute;right:0;z-index:4;padding:12px;width:min(420px,86vw);margin-top:4px">
        <div class="sm" style="font-weight:600;margin-bottom:6px">Clone with HTTP</div>
        <div style="display:flex;gap:6px"><input class="field mono" readonly value="${forge.esc(cmd)}" aria-label="Clone command"><button class="btn sm">Copy</button></div>
      </div></details>`).firstElementChild;
    const input = el.querySelector('input'), copy = el.querySelector('button');
    input.onfocus = () => input.select();
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(cmd); copy.textContent = 'Copied'; }
      catch { input.select(); copy.textContent = 'Press Ctrl+C'; }
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
    };
    return el;
  });
};
