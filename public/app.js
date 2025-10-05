async function fetchJson(url, options) {
  // attach token if present
  const token = localStorage.getItem('cnl_token');
  const headers = options && options.headers ? Object.assign({}, options.headers) : {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, Object.assign({}, options || {}, { headers }));
  if (!res.ok) {
    const text = await res.text();
    try { showToast(text || res.statusText, 'error'); } catch (e) {}
    throw new Error(text || res.statusText);
  }
  return res.json();
}

// Global safety: se ocorrer um erro não tratado, garanta que o modal de confirmação
// e o backdrop sejam removidos para não bloquear a interação do usuário.
window.addEventListener('error', (ev) => {
  try {
    const modal = document.getElementById('confirmModal');
    if (modal) {
      modal.classList.remove('modal-open');
      modal.classList.add('modal-hidden');
    }
    document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
    // restaura pointer-events caso algo tenha alterado
    try { document.body.style.pointerEvents = 'auto'; } catch (e) {}
  } catch (e) {}
  // deixa o erro seguir para o console
  console.error('Unhandled error caught, cleaned modal/backdrop', ev.error || ev.message || ev);
});
window.addEventListener('unhandledrejection', (ev) => {
  try {
    const modal = document.getElementById('confirmModal');
    if (modal) {
      modal.classList.remove('modal-open');
      modal.classList.add('modal-hidden');
    }
    document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
    try { document.body.style.pointerEvents = 'auto'; } catch (e) {}
  } catch (e) {}
  console.error('Unhandled rejection caught, cleaned modal/backdrop', ev.reason || ev);
});

// confirmation modal helper that returns a Promise<boolean>
function confirmModal(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirmModal');
    const msg = document.getElementById('confirmMessage');
    const okBtn = document.getElementById('confirmOk');
    const cancelBtn = document.getElementById('confirmCancel');
    if (!modal || !msg || !okBtn || !cancelBtn) return resolve(window.confirm(message));
    msg.textContent = message;
    // show modal with animation
    modal.classList.remove('modal-hidden');
    requestAnimationFrame(() => modal.classList.add('modal-open'));
    // trap focus
    const previouslyFocused = document.activeElement;
    okBtn.focus();
    function restoreFocus() { try { if (previouslyFocused) previouslyFocused.focus(); } catch (e) {} }
    function cleanup() {
      modal.classList.remove('modal-open');
      // wait for animation to finish before hiding
      setTimeout(() => modal.classList.add('modal-hidden'), 190);
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      restoreFocus();
    }
    function onOk() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    function onKey(e) {
      if (e.key === 'Escape') { onCancel(); }
      if (e.key === 'Enter') { onOk(); }
    }
    document.addEventListener('keydown', onKey);
  });
}

function showToast(message, type = 'info', ms = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = message;
  // start slightly translated to animate in
  t.style.transform = 'translateY(-6px)';
  t.style.opacity = '0';
  container.appendChild(t);
  // force layout so transition runs
  void t.offsetWidth;
  t.style.transform = 'translateY(0)';
  t.style.opacity = '0.95';
  // remove after timeout with fade/slide out
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(-6px)';
    t.addEventListener('transitionend', () => {
      try { t.remove(); } catch (e) {}
    }, { once: true });
  }, ms);
}

function showToastWithUndo(message, undoToken, ms = 10000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast info`;
  const txt = document.createElement('span');
  txt.textContent = message;
  const btn = document.createElement('button');
  btn.textContent = 'Desfazer';
  btn.style.marginLeft = '10px';
  btn.addEventListener('click', async () => {
    try {
      await fetchJson('/api/undo', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ undoToken }) });
      showToast('Ação desfeita', 'success');
      await loadUsers();
      await loadPosts();
      try { t.remove(); } catch (e) {}
    } catch (e) { showToast('Falha ao desfazer', 'error'); }
  });
  t.appendChild(txt);
  t.appendChild(btn);
  // animate in like showToast
  t.style.transform = 'translateY(-6px)';
  t.style.opacity = '0';
  container.appendChild(t);
  void t.offsetWidth;
  t.style.transform = 'translateY(0)';
  t.style.opacity = '0.95';
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(-6px)';
    t.addEventListener('transitionend', () => { try { t.remove(); } catch (e) {} }, { once: true });
  }, ms);
}

async function loadUsers() {
  const users = await fetchJson('/api/users');
  const userList = document.getElementById('userList');
  userList.innerHTML = '';
  // keep users in a window-global cache so we can map userId -> name when rendering posts
  window.__cnl_users = users;
  users.forEach(u => {
    const li = document.createElement('li');
    li.dataset.userid = String(u.id);
    li.textContent = `${u.id} - ${u.name}` + (u.admin ? ' (admin)' : '');
    const loggedUserId = Number(localStorage.getItem('cnl_userId')) || null;
    const loggedIsAdmin = !!(localStorage.getItem('cnl_user_admin') === 'true');
    // if logged is admin, show promote and delete for any user
    if (loggedIsAdmin) {
      if (!u.admin) {
        const btnMakeAdmin = document.createElement('button');
        btnMakeAdmin.textContent = 'Tornar admin';
        btnMakeAdmin.style.marginLeft = '8px';
        btnMakeAdmin.addEventListener('click', async () => {
          try {
            await fetchJson(`/api/users/${u.id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ admin: true }) });
            showToast('Usuário promovido a admin', 'success');
            await loadUsers();
          } catch (e) { showToast('Falha ao promover', 'error'); }
        });
        li.appendChild(btnMakeAdmin);
      }
      const btnDel = document.createElement('button');
      btnDel.textContent = 'Excluir';
      btnDel.style.marginLeft = '8px';
      btnDel.addEventListener('click', async () => {
        const ok = await confirmModal(`Excluir usuário ${u.id} - ${u.name}? Isso também removerá os posts dele.`);
        if (!ok) return;
          try {
          const res = await fetchJson(`/api/users/${u.id}`, { method: 'DELETE' });
          if (res && res.undoToken) {
            showToastWithUndo('Usuário excluído', res.undoToken);
          } else {
            showToast('Usuário excluído', 'info');
          }
          // if deleted user is the logged-in user, clear local auth
          const currentLogged = Number(localStorage.getItem('cnl_userId')) || null;
          if (currentLogged && currentLogged === u.id) {
            localStorage.removeItem('cnl_token');
            localStorage.removeItem('cnl_userId');
            localStorage.removeItem('cnl_user_admin');
            updateAuthUI();
          }
          await loadUsers();
          await loadPosts();
        } catch (e) { showToast('Falha ao excluir usuário', 'error'); }
      });
      li.appendChild(btnDel);
    } else {
      // non-admins can delete only themselves (button shown)
      if (loggedUserId && loggedUserId === u.id) {
        const btnDel = document.createElement('button');
        btnDel.textContent = 'Excluir';
        btnDel.style.marginLeft = '8px';
        btnDel.addEventListener('click', async () => {
          const ok = await confirmModal(`Excluir usuário ${u.id} - ${u.name}? Isso também removerá os posts dele.`);
          if (!ok) return;
            try {
            const res = await fetchJson(`/api/users/${u.id}`, { method: 'DELETE' });
            if (res && res.undoToken) {
              showToastWithUndo('Sua conta foi excluída', res.undoToken);
            } else {
              showToast('Sua conta foi excluída', 'info');
            }
            localStorage.removeItem('cnl_token');
            localStorage.removeItem('cnl_userId');
            localStorage.removeItem('cnl_user_admin');
            updateAuthUI();
            await loadUsers();
            await loadPosts();
          } catch (e) { showToast('Falha ao excluir sua conta', 'error'); }
        });
        li.appendChild(btnDel);
      }
    }
    userList.appendChild(li);
  });
    // after updating user list cache, refresh posts so author names reflect any changes
    try { await loadPosts(); } catch (e) { /* ignore errors while syncing */ }
}

async function loadPosts() {
  const posts = await fetchJson('/api/posts');
  const postList = document.getElementById('postList');
  postList.innerHTML = '';
  const loggedUserId = Number(localStorage.getItem('cnl_userId')) || null;
  posts.slice().reverse().forEach(p => {
    const li = document.createElement('li');
    li.dataset.postid = String(p.id);
    const meta = document.createElement('div');
  meta.className = 'post-meta';
  const users = window.__cnl_users || [];
  const author = users.find(u => u.id === p.userId);
  const authorName = author ? author.name : `usuário #${p.userId}`;
  meta.textContent = `#${p.id} - ${authorName} - ${new Date(p.createdAt).toLocaleString()}`;
    const content = document.createElement('div');
    content.textContent = p.content;
    li.appendChild(meta);
    li.appendChild(content);
    if (loggedUserId && loggedUserId === p.userId) {
      const btnEdit = document.createElement('button');
      btnEdit.textContent = 'Editar';
      btnEdit.style.marginRight = '6px';
      btnEdit.addEventListener('click', async () => {
        const newContent = prompt('Novo conteúdo:', p.content);
        if (newContent == null) return;
        try {
          await fetchJson(`/api/posts/${p.id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ content: newContent }) });
          showToast('Post atualizado', 'success');
          await loadPosts();
        } catch (e) { showToast('Falha ao atualizar post', 'error'); }
      });
      const btnDel = document.createElement('button');
      btnDel.textContent = 'Excluir';
      btnDel.addEventListener('click', async () => {
        const ok = await confirmModal('Deseja excluir este post?');
        if (!ok) return;
  try { const res = await fetchJson(`/api/posts/${p.id}`, { method: 'DELETE' }); if (res && res.undoToken) { showToastWithUndo('Post excluído', res.undoToken); } else { showToast('Post excluído', 'info'); } await loadPosts(); } catch (e) { showToast('Falha ao excluir post', 'error'); }
      });
      const actions = document.createElement('div');
      actions.appendChild(btnEdit);
      actions.appendChild(btnDel);
      li.appendChild(actions);
    }
    postList.appendChild(li);
  });
}

// Helpers for incremental DOM updates
function addUserToDom(user) {
  const userList = document.getElementById('userList');
  window.__cnl_users = window.__cnl_users || [];
  // avoid duplicate
  if (window.__cnl_users.find(u => u.id === user.id)) return;
  window.__cnl_users.push(user);
  const li = document.createElement('li');
  li.dataset.userid = String(user.id);
  li.textContent = `${user.id} - ${user.name}` + (user.admin ? ' (admin)' : '');
  userList.appendChild(li);
}

function updateUserInDom(user) {
  window.__cnl_users = window.__cnl_users || [];
  const idx = window.__cnl_users.findIndex(u => u.id === user.id);
  if (idx !== -1) window.__cnl_users[idx] = user;
  const el = document.querySelector(`#userList li[data-userid='${user.id}']`);
  if (el) el.textContent = `${user.id} - ${user.name}` + (user.admin ? ' (admin)' : '');
}

function removeUserFromDom(id) {
  window.__cnl_users = window.__cnl_users || [];
  window.__cnl_users = window.__cnl_users.filter(u => u.id !== id);
  const el = document.querySelector(`#userList li[data-userid='${id}']`);
  if (el) el.remove();
}

function addPostToDom(post) {
  const postList = document.getElementById('postList');
  window.__cnl_posts = window.__cnl_posts || [];
  if (window.__cnl_posts.find(p => p.id === post.id)) return;
  window.__cnl_posts.push(post);
  const li = document.createElement('li');
  li.dataset.postid = String(post.id);
  const meta = document.createElement('div');
  meta.className = 'post-meta';
  const users = window.__cnl_users || [];
  const author = users.find(u => u.id === post.userId);
  const authorName = author ? author.name : `usuário #${post.userId}`;
  meta.textContent = `#${post.id} - ${authorName} - ${new Date(post.createdAt).toLocaleString()}`;
  const content = document.createElement('div');
  content.textContent = post.content;
  li.appendChild(meta);
  li.appendChild(content);
  postList.insertBefore(li, postList.firstChild);
}

function updatePostInDom(post) {
  window.__cnl_posts = window.__cnl_posts || [];
  const idx = window.__cnl_posts.findIndex(p => p.id === post.id);
  if (idx !== -1) window.__cnl_posts[idx] = post;
  const el = document.querySelector(`#postList li[data-postid='${post.id}']`);
  if (!el) return;
  const meta = el.querySelector('.post-meta');
  const content = el.querySelector('div:not(.post-meta)');
  const users = window.__cnl_users || [];
  const author = users.find(u => u.id === post.userId);
  const authorName = author ? author.name : `usuário #${post.userId}`;
  if (meta) meta.textContent = `#${post.id} - ${authorName} - ${new Date(post.createdAt).toLocaleString()}`;
  if (content) content.textContent = post.content;
}

function removePostFromDom(id) {
  window.__cnl_posts = window.__cnl_posts || [];
  window.__cnl_posts = window.__cnl_posts.filter(p => p.id !== id);
  const el = document.querySelector(`#postList li[data-postid='${id}']`);
  if (el) el.remove();
}

document.getElementById('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('userName').value.trim();
  const password = document.getElementById('userPassword').value || undefined;
  if (!name) return;
  try {
    const payload = { name };
    if (password) payload.password = password;
    const user = await fetchJson('/api/users', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    showToast(`Usuário criado: #${user.id} ${user.name}`, 'success');
    document.getElementById('userName').value = '';
    document.getElementById('userPassword').value = '';
    await loadUsers();
  } catch (e) {
    showToast('Falha ao criar usuário', 'error');
  }
});

document.getElementById('postForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = document.getElementById('postContent').value.trim();
  if (!content) return;
  try {
    await fetchJson('/api/posts', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ content }) });
    showToast('Post publicado', 'success');
    document.getElementById('postContent').value = '';
    await loadPosts();
  } catch (e) {
    showToast('Falha ao publicar post', 'error');
  }
});

// login/logout handlers
document.getElementById('loginBtn').addEventListener('click', async () => {
  const userId = Number(document.getElementById('loginUserId').value);
  const password = document.getElementById('loginPassword').value || undefined;
  if (!userId) return alert('Informe um userId para login');
  try {
    const body = { userId };
    if (password) body.password = password;
    const res = await fetchJson('/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    localStorage.setItem('cnl_token', res.token);
    localStorage.setItem('cnl_userId', res.user.id);
    localStorage.setItem('cnl_user_admin', res.user.admin ? 'true' : 'false');
    // store user name for UI display
    if (res.user.name) localStorage.setItem('cnl_user_name', res.user.name);
    document.getElementById('loginUserId').value = '';
    document.getElementById('loginPassword').value = '';
    updateAuthUI();
    await loadPosts();
  } catch (e) {
    showToast('Login falhou: ' + e.message, 'error');
  }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('cnl_token');
  localStorage.removeItem('cnl_userId');
  localStorage.removeItem('cnl_user_admin');
  localStorage.removeItem('cnl_user_name');
  updateAuthUI();
});

// delete self button
document.getElementById('deleteSelfBtn').addEventListener('click', async () => {
  const userId = Number(localStorage.getItem('cnl_userId'));
  if (!userId) return;
  const ok = await confirmModal('Tem certeza que deseja excluir sua conta? Isso removerá seus posts e não poderá ser desfeito.');
  if (!ok) return;
  try {
    await fetchJson(`/api/users/${userId}`, { method: 'DELETE' });
    showToast('Sua conta foi excluída', 'info');
    localStorage.removeItem('cnl_token');
    localStorage.removeItem('cnl_userId');
    localStorage.removeItem('cnl_user_admin');
    localStorage.removeItem('cnl_user_name');
    updateAuthUI();
    await loadUsers();
    await loadPosts();
  } catch (e) {
    showToast('Falha ao excluir sua conta', 'error');
  }
});

function updateAuthUI() {
  const token = localStorage.getItem('cnl_token');
  const userId = localStorage.getItem('cnl_userId');
  const isAdmin = localStorage.getItem('cnl_user_admin') === 'true';
  const userName = localStorage.getItem('cnl_user_name');
  document.getElementById('loginBtn').style.display = token ? 'none' : 'inline-block';
  document.getElementById('logoutBtn').style.display = token ? 'inline-block' : 'none';
  document.getElementById('deleteSelfBtn').style.display = token ? 'inline-block' : 'none';
  document.getElementById('loggedAs').textContent = token ? `Conectado como ${userName ? userName + ' #' + userId : '#' + userId}${isAdmin ? ' (admin)' : ''}` : '';
}

// inicializar auth UI
updateAuthUI();

// inicializar
loadUsers();
loadPosts();

// connect to server-sent events for live updates
try {
  const es = new EventSource('/api/events');
  es.addEventListener('user-created', async (e) => {
    try { const obj = JSON.parse(e.data); addUserToDom(obj); } catch (e) { await loadUsers(); }
  });
  es.addEventListener('user-updated', async (e) => {
    try { const obj = JSON.parse(e.data); updateUserInDom(obj); } catch (e) { await loadUsers(); }
  });
  es.addEventListener('user-deleted', async (e) => {
    try { const obj = JSON.parse(e.data); removeUserFromDom(obj.id); } catch (e) { await loadUsers(); }
  });
  es.addEventListener('user-restored', async (e) => {
    try { const obj = JSON.parse(e.data); /* fetch full user to add */ const u = await fetchJson(`/api/users/${obj.id}`); addUserToDom(u); } catch (e) { await loadUsers(); }
  });
  es.addEventListener('post-created', async (e) => {
    try { const obj = JSON.parse(e.data); addPostToDom(obj); } catch (e) { await loadPosts(); }
  });
  es.addEventListener('post-updated', async (e) => {
    try { const obj = JSON.parse(e.data); updatePostInDom(obj); } catch (e) { await loadPosts(); }
  });
  es.addEventListener('post-deleted', async (e) => {
    try { const obj = JSON.parse(e.data); removePostFromDom(obj.id); } catch (e) { await loadPosts(); }
  });
  es.addEventListener('post-restored', async (e) => {
    try { const obj = JSON.parse(e.data); /* fetch full post */ const p = await fetchJson(`/api/posts/${obj.id}`); addPostToDom(p); } catch (e) { await loadPosts(); }
  });
  es.onerror = function() { /* ignore errors; browser will try to reconnect */ };
} catch (e) { console.warn('SSE not available', e); }

// Force-unblock helper: se a página for carregada com ?force_unblock=1, tenta
// remover overlays automaticamente (útil quando não é possível colar no console)
function forceUnblock() {
  try {
    const modal = document.getElementById('confirmModal');
    if (modal) {
      modal.classList.remove('modal-open');
      modal.classList.add('modal-hidden');
    }
    document.querySelectorAll('.modal-backdrop, .backdrop, [data-backdrop]').forEach(el => el.remove());
    Array.from(document.querySelectorAll('*')).forEach(el => {
      try {
        const s = window.getComputedStyle(el);
        if ((s.position === 'fixed' || s.position === 'absolute') && parseInt(s.zIndex||0) > 0 && el.offsetWidth>0 && el.offsetHeight>0) {
          el.style.pointerEvents = 'auto';
          if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)') el.style.background = 'transparent';
        }
      } catch(e){}
    });
    document.body.style.pointerEvents = 'auto';
    console.log('forceUnblock: overlays neutralizados');
    try { alert('UI desbloqueada — tente interagir agora.'); } catch(e){}
  } catch (e) { console.error('forceUnblock falhou', e); }
}

// checar query string para forçar desbloqueio
try {
  const params = new URLSearchParams(location.search);
  if (params.get('force_unblock') === '1') {
    // rodar após microtask para garantir elementos montados
    setTimeout(forceUnblock, 50);
  }
} catch (e) {}
