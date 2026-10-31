'use strict';
// Aurora OS server: serves the desktop from /public and a web proxy at /proxy?url=...
// No dependencies. Needs Node 18 or newer.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_HOSTS === '1'; // local testing only
const MAX_BYTES = 30 * 1024 * 1024;
const MAX_BODY = 5 * 1024 * 1024;
const MAX_REDIRECTS = 6;
const TIMEOUT = 20000;
const RATE_PER_MIN = 240;
const OK_PORTS = new Set(['', '80', '443', '8080', '8443']);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json'
};

/* ---------- blocking private network addresses ---------- */
function privV4(ip) {
  const p = ip.split('.').map(Number), a = p[0], b = p[1];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && p[2] === 0) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function privIp(ip) {
  if (net.isIPv4(ip)) return privV4(ip);
  const l = ip.toLowerCase();
  if (l === '::' || l === '::1') return true;
  const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return privV4(m[1]);
  if (/^::ffff:/.test(l)) return true;
  return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || /^ff/.test(l);
}
function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = ALLOW_PRIVATE ? addrs : addrs.filter(a => !privIp(a.address));
    if (!ok.length) return cb(new Error('That address is not allowed'));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}
function parseTarget(str) {
  let u;
  try { u = new URL(str); } catch (e) { throw new Error('That is not a valid web address'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https addresses work');
  if (u.username || u.password) throw new Error('Addresses with a login in them are not allowed');
  if (!ALLOW_PRIVATE && !OK_PORTS.has(u.port)) throw new Error('That port is not allowed');
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (!ALLOW_PRIVATE && net.isIP(h) && privIp(h)) throw new Error('That address is not allowed');
  return u;
}

/* ---------- fetching ---------- */
function request(u, o) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: o.method, headers: o.headers, lookup: safeLookup, timeout: TIMEOUT }, res => {
      const chunks = []; let n = 0;
      res.on('data', c => { n += c.length; if (n > MAX_BYTES) { req.destroy(new Error('The page is too large')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('The site took too long to answer')));
    req.on('error', reject);
    if (o.body && o.body.length) req.write(o.body);
    req.end();
  });
}
async function fetchFollow(urlStr, method, baseHeaders, body) {
  let u = parseTarget(urlStr);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const headers = Object.assign({}, baseHeaders, { host: u.host });
    if (body && body.length) headers['content-length'] = String(body.length); else delete headers['content-type'];
    const r = await request(u, { method, headers, body });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      u = parseTarget(new URL(r.headers.location, u).href);
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === 'POST')) { method = 'GET'; body = null; }
      continue;
    }
    return Object.assign(r, { url: u });
  }
  throw new Error('Too many redirects');
}

/* ---------- script added to every proxied page ---------- */
function clientScript(base, proxyPrefix) {
  const fn = function (B, P) {
    function abs(u) { try { return new URL(u, B).href; } catch (e) { return null; } }
    function enc(u) { return P + encodeURIComponent(u); }
    function go(u) { location.href = enc(u); }
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button || e.ctrlKey || e.metaKey || e.shiftKey) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || typeof a.href !== 'string') return;
      var h = a.getAttribute('href') || '';
      if (/^\s*(javascript:|mailto:|tel:|data:|blob:)/i.test(h)) return;
      e.preventDefault();
      if (h.charAt(0) === '#') {
        var id = decodeURIComponent(h.slice(1));
        var t = id ? (document.getElementById(id) || document.getElementsByName(id)[0]) : null;
        if (t) t.scrollIntoView(); else if (!id) scrollTo(0, 0);
        return;
      }
      go(a.href);
    }, true);
    document.addEventListener('submit', function (e) {
      if (e.defaultPrevented) return;
      var f = e.target, m = (f.getAttribute('method') || 'get').toLowerCase();
      var act = abs(f.getAttribute('action') || B);
      if (!act) return;
      if (m === 'post') { f.setAttribute('action', enc(act)); return; }
      e.preventDefault();
      var u = new URL(act), fd = new FormData(f);
      if (e.submitter && e.submitter.name) fd.append(e.submitter.name, e.submitter.value);
      u.search = '';
      fd.forEach(function (v, k) { if (typeof v === 'string') u.searchParams.append(k, v); });
      go(u.href);
    }, true);
    window.open = function (u) { if (u) { var x = abs(u); if (x) go(x); } return null; };
    function note() { try { parent.postMessage({ aurora: 1, url: B, title: document.title }, '*'); } catch (e) { } }
    if (document.readyState === 'complete') note(); else addEventListener('load', note);
  };
  const safe = s => JSON.stringify(s).replace(/</g, '\\u003c');
  return '(' + fn.toString() + ')(' + safe(base) + ',' + safe(proxyPrefix) + ')';
}
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function errorPage(msg) {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f4f5fa;color:#161a28}main{max-width:420px;padding:24px}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#5d6580}</style><main><h1>This page could not be opened</h1><p>' + escHtml(msg) + '</p></main>';
}

/* ---------- request handling ---------- */
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now > h.reset) { h = { n: 0, reset: now + 60000 }; hits.set(ip, h); }
  return ++h.n > RATE_PER_MIN;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, 60000).unref();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(new Error('The form data is too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleProxy(req, res, reqUrl) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const send = (code, html) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); };
  if (limited(ip)) return send(429, errorPage('Too many requests. Wait a minute and try again.'));
  if (req.method !== 'GET' && req.method !== 'POST') return send(405, errorPage('Only GET and POST are supported.'));
  const target = reqUrl.searchParams.get('url');
  if (!target) return send(400, errorPage('No web address was given.'));
  try {
    const body = req.method === 'POST' ? await readBody(req) : null;
    const headers = {
      'user-agent': UA, 'accept': req.headers.accept || '*/*', 'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'accept-encoding': 'identity'
    };
    if (body && req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    const r = await fetchFollow(target, req.method, headers, body);
    const ct = r.headers['content-type'] || 'application/octet-stream';
    const out = {
      'content-type': ct, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock'
    };
    if (r.headers['content-disposition']) out['content-disposition'] = r.headers['content-disposition'];
    if (!/text\/html|application\/xhtml/i.test(ct)) { res.writeHead(r.status, out); return res.end(r.body); }
    const cs = (ct.match(/charset=([^;]+)/i) || [])[1];
    let text;
    try { text = new TextDecoder(cs ? cs.trim().replace(/["']/g, '') : 'utf-8').decode(r.body); } catch (e) { text = r.body.toString('utf8'); }
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const origin = proto + '://' + req.headers.host;
    const finalUrl = r.url.href;
    const inj = '<meta charset="utf-8"><base href="' + escAttr(finalUrl) + '"><script>' + clientScript(finalUrl, origin + '/proxy?url=') + '</' + 'script>';
    if (/<head[^>]*>/i.test(text)) text = text.replace(/<head[^>]*>/i, m => m + inj);
    else if (/^\s*<!doctype[^>]*>/i.test(text)) text = text.replace(/^\s*<!doctype[^>]*>/i, m => m + inj);
    else text = inj + text;
    out['content-type'] = 'text/html; charset=utf-8';
    res.writeHead(r.status, out);
    res.end(text);
  } catch (err) {
    send(502, errorPage(err.message || 'Something went wrong.'));
  }
}

function handleStatic(req, res, reqUrl) {
  let p = decodeURIComponent(reqUrl.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const reqUrl = new URL(req.url, 'http://x');
  if (reqUrl.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (reqUrl.pathname === '/proxy') return handleProxy(req, res, reqUrl);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  handleStatic(req, res, reqUrl);
}).listen(PORT, () => console.log('Aurora OS running on http://localhost:' + PORT));
