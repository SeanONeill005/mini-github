// UI-only plugin: the Settings tab (client.js). Deleting is handled by core (DELETE /api/repos/:name);
// each plugin that keeps per-repo data cleans up on the 'repo:deleted' event.
module.exports = () => {};
