const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function serve(root, prefix = '/chinese-teacher-workbench/', port = 0) {
  root = path.resolve(root);
  const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
    '.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8',
    '.gz':'application/gzip','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'};
  const server = http.createServer((request, response) => {
    let name;
    try { name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { response.writeHead(400).end(); return; }
    if (!name.startsWith(prefix)) { response.writeHead(404).end(); return; }
    const file = path.resolve(root, name.slice(prefix.length) || 'index.html');
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'Content-Length': stat.size, 'Cache-Control':'no-cache'});
      if (request.method === 'HEAD') response.end(); else fs.createReadStream(file).pipe(response);
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () =>
    resolve({server, base:`http://127.0.0.1:${server.address().port}${prefix}`})));
}
module.exports = {serve};
if (require.main === module) serve(process.argv[2], undefined, Number(process.argv[3] || 8780))
  .then(({base}) => console.log(base));
