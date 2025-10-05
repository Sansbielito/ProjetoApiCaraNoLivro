const http = require('http');
const assert = require('assert');

function req(path, method='GET', body=null, token=null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'localhost', port: 3000, path, method,
      headers: {}
    };
    if (data) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (token) options.headers['Authorization'] = 'Bearer ' + token;
    const r = http.request(options, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try {
          const json = out ? JSON.parse(out) : null;
          resolve({ status: res.statusCode, body: json });
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.log('smoke-test: criando usuário...');
  const create = await req('/api/users', 'POST', { name: 'SmokeUser', password: 'abc' });
  assert.strictEqual(create.status, 201);
  const user = create.body;
  console.log('criado', user.id);

  console.log('login...');
  const login = await req('/api/login', 'POST', { userId: user.id, password: 'abc' });
  assert.strictEqual(login.status, 200);
  const token = login.body.token;
  console.log('token obtido');

  console.log('criando post...');
  const postRes = await req('/api/posts', 'POST', { content: 'smoke test post' }, token);
  assert.strictEqual(postRes.status, 201);
  const post = postRes.body;
  console.log('post criado', post.id);

  console.log('deletando post...');
  const del = await req('/api/posts/' + post.id, 'DELETE', null, token);
  assert.strictEqual(del.status, 200);
  console.log('delete retornou undoToken', del.body.undoToken);

  console.log('tentando undo...');
  const undo = await req('/api/undo', 'POST', { undoToken: del.body.undoToken });
  if (undo.status !== 200) {
    console.error('undo falhou:', undo.status, undo.body);
    process.exit(2);
  }
  console.log('undo bem-sucedido, post restaurado id', undo.body.id);
  console.log('smoke-test: OK');
  process.exit(0);
})();