const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PENDING_TTL_MS = Number(process.env.PENDING_TTL_MS || 10000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 120); // requests per minute per IP

// Simple file-backed stores (persistem entre reinícios)
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const usersFile = path.join(dataDir, 'users.json');
const postsFile = path.join(dataDir, 'posts.json');

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('failed reading', filePath, e);
    return [];
  }
}

function writeJsonSafe(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('failed writing', filePath, e);
  }
}

function loadData(key, filePath, fallback) {
  try {
    if (dbStore && dbStore.available) {
      const v = dbStore.get(key);
      if (v !== null) return v;
    }
  } catch (e) { /* ignore */ }
  return readJsonSafe(filePath) || fallback;
}

function saveData(key, filePath, data) {
  try {
    if (dbStore && dbStore.available) {
      dbStore.set(key, data);
      return;
    }
  } catch (e) { /* ignore */ }
  writeJsonSafe(filePath, data);
}

const users = loadData('users', usersFile, []);
const posts = loadData('posts', postsFile, []);
const AUTH_TOKENS_FILE = path.join(dataDir, 'authTokens.json');
// load auth tokens from disk so sessions can survive restarts (best-effort)
let persistedAuth = {};
try {
  if (dbStore && dbStore.available) {
    persistedAuth = dbStore.get('authTokens') || {};
  } else {
    persistedAuth = fs.existsSync(AUTH_TOKENS_FILE) ? JSON.parse(fs.readFileSync(AUTH_TOKENS_FILE, 'utf8') || '{}') : {};
  }
} catch(e){ persistedAuth = {}; }
const pendingFile = path.join(dataDir, 'pendingDeletes.json');

// optional DB layer (better-sqlite3) and JWT support
let dbStore = null;
try { dbStore = require('./db'); } catch (e) { dbStore = null; }
let jwt = null;
let JWT_SECRET = process.env.JWT_SECRET || null;
try { jwt = require('jsonwebtoken'); if (!JWT_SECRET) JWT_SECRET = crypto.randomBytes(32).toString('hex'); } catch (e) { jwt = null; }

function persistPending() {
  try {
    const out = {};
    if (global.pendingDeletes) {
      for (const k of Object.keys(global.pendingDeletes)) {
        const e = global.pendingDeletes[k];
        const { timeoutId, ...rest } = e;
        out[k] = rest;
      }
    }
    saveData('pendingDeletes', pendingFile, out);
  } catch (e) { console.error('failed to persist pending deletes', e); }
}

function persistAuthTokens() {
  try {
    // if using JWT we don't persist tokens (they are stateless)
    if (jwt) return;
    if (dbStore && dbStore.available) {
      dbStore.set('authTokens', global.authTokens || {});
      return;
    }
    fs.writeFileSync(AUTH_TOKENS_FILE, JSON.stringify(global.authTokens || {}, null, 2), 'utf8');
  } catch (e) { console.error('failed to persist auth tokens', e); }
}

function loadPending() {
  try {
    let obj = null;
    if (dbStore && dbStore.available) {
      obj = dbStore.get('pendingDeletes');
    }
    if (!obj) {
      if (!fs.existsSync(pendingFile)) return;
      const raw = fs.readFileSync(pendingFile, 'utf8');
      if (!raw) return;
      obj = JSON.parse(raw);
    }
    global.pendingDeletes = global.pendingDeletes || {};
    const now = Date.now();
    for (const k of Object.keys(obj)) {
      const entry = obj[k];
      // if expired, skip
      if (entry.expiresAt && entry.expiresAt <= now) continue;
      const remaining = entry.expiresAt ? Math.max(0, entry.expiresAt - now) : 10000;
      const timeoutId = setTimeout(() => {
        if (global.pendingDeletes && global.pendingDeletes[k]) {
          delete global.pendingDeletes[k];
          persistPending();
        }
      }, remaining);
      global.pendingDeletes[k] = Object.assign({}, entry, { timeoutId });
    }
  } catch (e) { console.error('failed to load pending deletes', e); }
}

// load any pending deletes from disk so undo survives restarts
// initialize global maps
global.authTokens = Object.assign({}, persistedAuth || {});
global.pendingDeletes = global.pendingDeletes || {};
loadPending();

// ensure bootstrap: if no users have admin:true, first created user will become admin when added
function hasAdmin() {
  return users.some(u => u.admin);
}

function sendJson(res, status, data) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json)
  });
  res.end(json);
}

function sendSse(event, data) {
  try {
    const clients = global.sseClients || [];
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    clients.forEach(c => {
      try { c.res.write(payload); } catch (e) { /* ignore write errors */ }
    });
  } catch (e) { /* no-op */ }
}

function serveStatic(req, res) {
  // strip querystring and hash so /?force_unblock=1 resolves to index.html
  const reqPath = (req.url || '').split('?')[0].split('#')[0];
  const safePath = reqPath === '/' || reqPath === '' ? 'index.html' : decodeURIComponent(reqPath.replace(/^\/+/, ''));
  // basic path traversal protection
  if (safePath.includes('..')) { res.writeHead(400); return res.end('Bad request'); }
  const filePath = path.join(__dirname, 'public', safePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const map = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg'
    };
    res.writeHead(200, { 'Content-Type': map[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  try {
    const h = crypto.scryptSync(password, salt, 64).toString('hex');
    return h === hash;
  } catch (e) { return false; }
}

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  // simple in-memory tokens: token -> userId (best-effort persisted)
  if (!global.authTokens) global.authTokens = {};
  if (!global.pendingDeletes) global.pendingDeletes = {};
  // simple rate limiter per IP (sliding window by minute)
  if (!global.rateLimits) global.rateLimits = {};
  const ip = req.socket.remoteAddress || 'unknown';
  const nowTs = Date.now();
  const bucket = global.rateLimits[ip] || { ts: nowTs, count: 0 };
  // reset window if more than 60s passed
  if (nowTs - bucket.ts > 60000) { bucket.ts = nowTs; bucket.count = 0; }
  bucket.count++;
  global.rateLimits[ip] = bucket;
  if (bucket.count > RATE_LIMIT_MAX) return sendJson(res, 429, { error: 'rate limit exceeded' });
  function getAuthUserId(req) {
    const auth = req.headers['authorization'] || req.headers['Authorization'];
    if (!auth) return null;
    const parts = auth.split(' ');
    if (parts.length !== 2) return null;
    const token = parts[1];
    if (jwt) {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        return payload && payload.userId ? payload.userId : null;
      } catch (e) { return null; }
    }
    return global.authTokens[token] || null;
  }

  // API routes
  if (url.startsWith('/api/')) {
    // SSE endpoint for live updates
    if (url === '/api/events' && method === 'GET') {
      // set headers for SSE
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write('\n');
      // track clients
      if (!global.sseClients) global.sseClients = [];
      const client = { id: Math.random().toString(36).slice(2), res };
      global.sseClients.push(client);
      req.on('close', () => {
        global.sseClients = (global.sseClients || []).filter(c => c.id !== client.id);
      });
      return; // keep connection open
    }
    // login
    if (url === '/api/login' && method === 'POST') {
      try {
        const body = await parseBody(req);
        if (!body.userId) return sendJson(res, 400, { error: 'userId required' });
        // small validation: password length limit
        if (body.password && String(body.password).length > 200) return sendJson(res, 400, { error: 'password too long' });
        const user = users.find(u => u.id === body.userId);
        if (!user) return sendJson(res, 404, { error: 'user not found' });
        // if user has a password configured, require password
        if (user.passwordHash && user.passwordSalt) {
          if (!body.password) return sendJson(res, 400, { error: 'password required' });
          if (!verifyPassword(String(body.password), user.passwordSalt, user.passwordHash)) return sendJson(res, 401, { error: 'invalid credentials' });
        }
  let token;
  if (jwt) {
    // sign a JWT (exp optional)
    token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES || '7d' });
  } else {
    token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    global.authTokens[token] = user.id;
    persistAuthTokens();
  }
        return sendJson(res, 200, { token, user: { id: user.id, name: user.name, admin: !!user.admin } });
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid json' });
      }
    }

    if (url === '/api/users' && method === 'GET') {
      return sendJson(res, 200, users);
    }
    if (url === '/api/users' && method === 'POST') {
      try {
        const body = await parseBody(req);
        if (!body.name) return sendJson(res, 400, { error: 'name is required' });
        if (String(body.name).length > 100) return sendJson(res, 400, { error: 'name too long' });
        const id = (users[users.length - 1]?.id || 0) + 1;
        const isAdmin = !!body.admin && hasAdmin() ? false : !!body.admin; // only allow admin flag if an admin exists (can't set admin without an admin)
        // bootstrap first admin: if no admin exists, first user becomes admin
        const makeAdmin = !hasAdmin() ? true : isAdmin;
        const user = { id, name: body.name, admin: !!makeAdmin };
        if (body.password) {
          if (String(body.password).length > 200) return sendJson(res, 400, { error: 'password too long' });
          const { salt, hash } = hashPassword(String(body.password));
          user.passwordSalt = salt;
          user.passwordHash = hash;
        }
  users.push(user);
  saveData('users', usersFile, users);
  // notify SSE clients
  sendSse('user-created', user);
        return sendJson(res, 201, user);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid json' });
      }
    }

    // single-user routes: /api/users/:id
    if (url.startsWith('/api/users/')) {
      const parts = url.split('/');
      const id = Number(parts[3]);
      const userIndex = users.findIndex(u => u.id === id);
      const user = userIndex !== -1 ? users[userIndex] : null;

      if (method === 'GET') {
        if (!user) return sendJson(res, 404, { error: 'user not found' });
        return sendJson(res, 200, user);
      }

      if (method === 'PUT') {
        try {
          const authUserId = getAuthUserId(req);
          if (!authUserId) return sendJson(res, 401, { error: 'authorization required' });
          if (!user) return sendJson(res, 404, { error: 'user not found' });
          const body = await parseBody(req);
          // allow a user to update own name; admin can set admin flag
          if (body.name) user.name = body.name;
          // allow password change if owner or admin
          if (typeof body.password !== 'undefined') {
            const authUser = users.find(u => u.id === authUserId);
            if (!authUser) return sendJson(res, 403, { error: 'forbidden' });
            if (authUserId !== id && !authUser.admin) return sendJson(res, 403, { error: 'forbidden' });
            const { salt, hash } = hashPassword(String(body.password));
            user.passwordSalt = salt;
            user.passwordHash = hash;
          }
          if (typeof body.admin !== 'undefined') {
            const authUser = users.find(u => u.id === authUserId);
            if (!authUser || !authUser.admin) return sendJson(res, 403, { error: 'forbidden' });
            user.admin = !!body.admin;
          }
          users[userIndex] = user;
          saveData('users', usersFile, users);
          sendSse('user-updated', user);
          return sendJson(res, 200, user);
        } catch (e) {
          return sendJson(res, 400, { error: 'invalid json' });
        }
      }

      if (method === 'DELETE') {
        const authUserId = getAuthUserId(req);
        if (!authUserId) return sendJson(res, 401, { error: 'authorization required' });
        if (!user) return sendJson(res, 404, { error: 'user not found' });
        const authUser = users.find(u => u.id === authUserId);
        const authIsAdmin = authUser && authUser.admin;
        // allow deleting yourself or admin deleting anyone
        if (authUserId !== id && !authIsAdmin) return sendJson(res, 403, { error: 'forbidden' });
        // soft-delete: remove user and their posts now, but allow undo for a short window
        const undoToken = 'undo_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        const savedUser = Object.assign({}, user);
        const savedPosts = posts.filter(p => p.userId === id);
        // collect active tokens for this user and remove them (invalidate temporarily)
        const tokensToRestore = [];
        for (const t of Object.keys(global.authTokens)) {
          if (global.authTokens[t] === id) {
            tokensToRestore.push(t);
            delete global.authTokens[t];
          }
        }
        persistAuthTokens();
        // remove user from users array
  users.splice(userIndex, 1);
  saveData('users', usersFile, users);
        // remove posts by user
        const remaining = posts.filter(p => p.userId !== id);
        posts.length = 0;
        remaining.forEach(p => posts.push(p));
  saveData('posts', postsFile, posts);
        // schedule permanent deletion after TTL
        const TTL = PENDING_TTL_MS; // configurable window to undo
        const expiresAt = Date.now() + TTL;
        const timeoutId = setTimeout(() => {
          // permanent: forget saved data
          if (global.pendingDeletes && global.pendingDeletes[undoToken]) {
            delete global.pendingDeletes[undoToken];
            persistPending();
          }
        }, TTL);
        global.pendingDeletes[undoToken] = { type: 'user', id, user: savedUser, posts: savedPosts, tokens: tokensToRestore, timeoutId, expiresAt };
        persistPending();
  // notify SSE clients about deletion (with undoToken)
  sendSse('user-deleted', { id, undoToken });
        return sendJson(res, 200, { success: true, undoToken });
      }
    }

    if (url === '/api/posts' && method === 'GET') {
      return sendJson(res, 200, posts);
    }
    if (url === '/api/posts' && method === 'POST') {
      try {
        const authUserId = getAuthUserId(req);
        if (!authUserId) return sendJson(res, 401, { error: 'authorization required' });
        const body = await parseBody(req);
        if (!body.content) return sendJson(res, 400, { error: 'content required' });
        if (String(body.content).length > 2000) return sendJson(res, 400, { error: 'content too long' });
        const post = { id: (posts[posts.length - 1]?.id || 0) + 1, userId: authUserId, content: body.content, createdAt: new Date().toISOString() };
        posts.push(post);
  saveData('posts', postsFile, posts);
  sendSse('post-created', post);
        return sendJson(res, 201, post);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid json' });
      }
    }

    // single-post routes: /api/posts/:id
    if (url.startsWith('/api/posts/')) {
      const parts = url.split('/');
      const id = Number(parts[3]);
      const postIndex = posts.findIndex(p => p.id === id);
      const post = postIndex !== -1 ? posts[postIndex] : null;

      if (method === 'GET') {
        if (!post) return sendJson(res, 404, { error: 'post not found' });
        return sendJson(res, 200, post);
      }

      if ((method === 'PUT' || method === 'PATCH')) {
        try {
          const authUserId = getAuthUserId(req);
          if (!authUserId) return sendJson(res, 401, { error: 'authorization required' });
          if (!post) return sendJson(res, 404, { error: 'post not found' });
          if (post.userId !== authUserId) return sendJson(res, 403, { error: 'forbidden' });
          const body = await parseBody(req);
          // allow updating content only for now
          if (body.content) post.content = body.content;
          post.updatedAt = new Date().toISOString();
          posts[postIndex] = post;
          writeJsonSafe(postsFile, posts);
          sendSse('post-updated', post);
          return sendJson(res, 200, post);
        } catch (e) {
          return sendJson(res, 400, { error: 'invalid json' });
        }
      }

      if (method === 'DELETE') {
        const authUserId = getAuthUserId(req);
        if (!authUserId) return sendJson(res, 401, { error: 'authorization required' });
        if (!post) return sendJson(res, 404, { error: 'post not found' });
        if (post.userId !== authUserId) return sendJson(res, 403, { error: 'forbidden' });
        // soft-delete post with undo token
        const undoToken = 'undo_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        const savedPost = Object.assign({}, post);
        posts.splice(postIndex, 1);
        writeJsonSafe(postsFile, posts);
        const TTL = PENDING_TTL_MS;
        const expiresAt = Date.now() + TTL;
        const timeoutId = setTimeout(() => {
          if (global.pendingDeletes && global.pendingDeletes[undoToken]) {
            delete global.pendingDeletes[undoToken];
            persistPending();
          }
        }, TTL);
        global.pendingDeletes[undoToken] = { type: 'post', id, post: savedPost, timeoutId, expiresAt };
        persistPending();
  sendSse('post-deleted', { id, undoToken });
        return sendJson(res, 200, { success: true, undoToken });
      }
    }

    // undo endpoint
    if (url === '/api/undo' && method === 'POST') {
      try {
        const body = await parseBody(req);
        if (!body.undoToken) return sendJson(res, 400, { error: 'undoToken required' });
        const entry = global.pendingDeletes && global.pendingDeletes[body.undoToken];
        if (!entry) return sendJson(res, 404, { error: 'undo token not found or expired' });
        // restore based on type
        if (entry.type === 'post') {
          posts.push(entry.post);
          writeJsonSafe(postsFile, posts);
          clearTimeout(entry.timeoutId);
          delete global.pendingDeletes[body.undoToken];
          persistPending();
          sendSse('post-restored', { id: entry.post.id });
          return sendJson(res, 200, { restored: 'post', id: entry.post.id });
        }
        if (entry.type === 'user') {
          users.push(entry.user);
          // restore posts
          entry.posts.forEach(p => posts.push(p));
          // restore tokens
          (entry.tokens || []).forEach(t => { global.authTokens[t] = entry.user.id; });
          persistAuthTokens();
          writeJsonSafe(usersFile, users);
          writeJsonSafe(postsFile, posts);
          clearTimeout(entry.timeoutId);
          delete global.pendingDeletes[body.undoToken];
          persistPending();
          sendSse('user-restored', { id: entry.user.id });
          return sendJson(res, 200, { restored: 'user', id: entry.user.id });
        }
        return sendJson(res, 400, { error: 'unknown undo entry' });
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid json' });
      }
    }

    // not found API
    return sendJson(res, 404, { error: 'not found' });
  }

  // static
  serveStatic(req, res);
});

server.listen(PORT, () => console.log(`CaraNoLivro server running on http://localhost:${PORT}`));
