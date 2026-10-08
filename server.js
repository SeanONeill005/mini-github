const fs = require('fs');
const path = require('path');
const { createApp } = require('./core/app');

const dataDir = path.resolve(process.env.FORGE_DATA || 'data');
fs.mkdirSync(dataDir, { recursive: true });

let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')); } catch { /* optional */ }

const app = createApp({
  dataDir, config,
  pluginsDir: path.resolve('plugins'),
  publicDir: path.resolve('public'),
});
app.loadPlugins();
app.listen(process.env.PORT || 3000);
