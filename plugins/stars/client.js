export default forge => {
  forge.contribute('repo-actions', ({ repo }) => {
    const btn = forge.html(`<button class="btn sm">${repo.starred ? 'Starred' : 'Star'} · ${repo.count}</button>`).firstElementChild;
    btn.onclick = async () => {
      await forge.api('POST', `/api/repos/${encodeURIComponent(repo.name)}/star`);
      forge.refresh();
    };
    return btn;
  });
};
