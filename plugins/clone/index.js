// Serves repos over git's smart HTTP protocol so `git clone http://host/<repo>.git` works.
// Read-only: only upload-pack (clone/fetch) is allowed, push is refused.
const { spawn } = require('child_process');
const path = require('path');

module.exports = app => {
  const root = path.join(app.dataDir, 'repos');

  app.raw(/^\/[a-z0-9][a-z0-9._-]*\.git\//, (req, res, url) => {
    if (url.pathname.endsWith('git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Push is not enabled\n');
    }
    const p = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: req.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] || '', CONTENT_LENGTH: req.headers['content-length'] || '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '',
        REMOTE_ADDR: req.socket.remoteAddress || '',
      },
    });
    req.pipe(p.stdin);
    p.stdin.on('error', () => {});

    // The CGI response is "headers\r\n\r\nbody": parse the headers, then stream the body.
    let buf = Buffer.alloc(0), sent = false;
    p.stdout.on('data', chunk => {
      if (sent) return res.write(chunk);
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const headers = {};
      let status = 200;
      for (const line of buf.subarray(0, end).toString().split('\r\n')) {
        const [k, ...v] = line.split(':');
        if (k.toLowerCase() === 'status') status = parseInt(v.join(':'), 10);
        else headers[k] = v.join(':').trim();
      }
      res.writeHead(status, headers);
      res.write(buf.subarray(end + 4));
      sent = true;
    });
    p.on('close', () => {
      if (!sent) { res.writeHead(500); }
      res.end();
    });
  });
};
