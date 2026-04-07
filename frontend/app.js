/**
 * DocuBase — app.js
 * Handles: JWT auth · document CRUD · auto-save · offline queue · export · file upload
 */

// ─── Config ──────────────────────────────────────────────────────────────────
const API = (window.API_BASE || 'http://localhost:8000') + '/api';

// ─── State ────────────────────────────────────────────────────────────────────
let token = null;
let currentDocId = null;
let documents = [];
let files = [];
let saveTimer = null;
let isDirty = false;
let currentTab = 'login';
let isOnline = navigator.onLine;

// ─── Offline Queue (IndexedDB) ────────────────────────────────────────────────
const DB_NAME = 'docubase';
const DB_VERSION = 1;
let idb = null;

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'docId' });
      }
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'docId' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, value) {
  const tx = idb.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

async function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(store, key) {
  const tx = idb.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

async function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// ─── Auth Helpers ─────────────────────────────────────────────────────────────
function saveToken(t, user) {
  token = t;
  localStorage.setItem('jwt', t);
  localStorage.setItem('user', JSON.stringify(user));
}

function loadToken() {
  token = localStorage.getItem('jwt');
  return !!token;
}

function clearSession() {
  token = null;
  currentDocId = null;
  localStorage.removeItem('jwt');
  localStorage.removeItem('user');
}

function getUser() {
  try { return JSON.parse(localStorage.getItem('user')); } catch { return null; }
}

// ─── API Helpers ──────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(API + path, { ...options, headers });
  if (res.status === 401) { logout(); return null; }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Request failed');
  }
  if (res.status === 204) return null;
  return res.json();
}

// ─── Tab & Auth UI ────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-signup').classList.toggle('active', tab === 'signup');
  document.getElementById('auth-submit').textContent = tab === 'login' ? 'Sign In' : 'Create Account';
  document.getElementById('auth-error').classList.add('hidden');
}

async function handleAuth(e) {
  e.preventDefault();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errEl = document.getElementById('auth-error');
  errEl.classList.add('hidden');

  try {
    const endpoint = currentTab === 'login' ? '/auth/login' : '/auth/signup';
    const data = await apiFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (!data) return;
    saveToken(data.access_token, data.user);
    await enterApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

function logout() {
  clearSession();
  currentDocId = null;
  documents = [];
  files = [];
  showScreen('auth');
}

// ─── Screen Management ────────────────────────────────────────────────────────
function showScreen(name) {
  document.getElementById('auth-screen').classList.toggle('hidden', name !== 'auth');
  document.getElementById('app-screen').classList.toggle('hidden', name !== 'app');
}

// ─── Enter App ────────────────────────────────────────────────────────────────
async function enterApp() {
  showScreen('app');
  const user = getUser();
  if (user) document.getElementById('user-email-display').textContent = user.email;
  await loadDocuments();
  await loadFiles();
  updateOnlineStatus();
  if (isOnline) syncOfflineQueue();
}

// ─── Documents ────────────────────────────────────────────────────────────────
async function loadDocuments() {
  try {
    documents = await apiFetch('/documents/') || [];
    renderDocList();
  } catch (e) {
    console.error('Could not load documents', e);
  }
}

function renderDocList() {
  const list = document.getElementById('doc-list');
  if (!documents.length) {
    list.innerHTML = '<div style="padding:12px;font-size:.8rem;color:var(--text-muted);text-align:center">No documents yet</div>';
    return;
  }
  list.innerHTML = documents.map(d => `
    <button class="doc-item ${d.id === currentDocId ? 'active' : ''}" onclick="openDocument('${d.id}')">
      <span class="doc-item-title">${escHtml(d.title || 'Untitled')}</span>
      <span class="doc-item-meta">${relTime(d.updated_at)}</span>
    </button>
  `).join('');
}

async function createDocument() {
  try {
    const doc = await apiFetch('/documents/', {
      method: 'POST',
      body: JSON.stringify({ title: 'Untitled Document', content: '' }),
    });
    if (!doc) return;
    documents.unshift(doc);
    renderDocList();
    openDocument(doc.id);
  } catch (e) {
    toast('Could not create document: ' + e.message);
  }
}

async function openDocument(id) {
  if (isDirty && currentDocId) await saveCurrentDocument(true);

  currentDocId = id;
  isDirty = false;

  // Try loading from server first; fall back to local draft if offline
  let doc = null;
  if (isOnline) {
    try {
      doc = await apiFetch('/documents/' + id);
    } catch {}
  }

  if (!doc) {
    const draft = await idbGet('drafts', id).catch(() => null);
    if (draft) {
      doc = draft;
      toast('Loaded local draft (offline)');
    } else {
      doc = documents.find(d => d.id === id);
    }
  }

  if (!doc) { toast('Document not found'); return; }

  document.getElementById('doc-title').value = doc.title || '';
  document.getElementById('doc-content').value = doc.content || '';
  document.getElementById('doc-updated').textContent = 'Updated ' + relTime(doc.updated_at);
  updateWordCount();
  setSyncStatus('saved');

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('editor-pane').classList.remove('hidden');

  renderDocList(); // highlight active
}

function onTitleChange() {
  isDirty = true;
  setSyncStatus('saving');
  scheduleSave();
}

function onContentChange() {
  isDirty = true;
  setSyncStatus('saving');
  updateWordCount();
  saveDraftLocally();
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveCurrentDocument(), 4000);
}

async function saveCurrentDocument(force = false) {
  if (!isDirty && !force) return;
  if (!currentDocId) return;

  const title = document.getElementById('doc-title').value.trim() || 'Untitled Document';
  const content = document.getElementById('doc-content').value;

  // Save draft locally always
  await idbPut('drafts', { docId: currentDocId, title, content, savedAt: new Date().toISOString() }).catch(() => {});

  if (!isOnline) {
    // Queue for later sync
    await idbPut('queue', {
      docId: currentDocId,
      title,
      content,
      queuedAt: new Date().toISOString(),
    }).catch(() => {});
    setSyncStatus('error');
    toast('Saved locally — will sync when online');
    isDirty = false;
    return;
  }

  try {
    setSyncStatus('saving');
    const updated = await apiFetch('/documents/' + currentDocId, {
      method: 'PUT',
      body: JSON.stringify({ title, content }),
    });
    if (!updated) return;

    isDirty = false;
    setSyncStatus('saved');
    document.getElementById('doc-updated').textContent = 'Updated ' + relTime(updated.updated_at);

    // Update local list
    const idx = documents.findIndex(d => d.id === currentDocId);
    if (idx !== -1) {
      documents[idx] = updated;
      renderDocList();
    }
    // Clear queue entry since we synced
    await idbDelete('queue', currentDocId).catch(() => {});
  } catch (e) {
    setSyncStatus('error');
    // Queue it
    await idbPut('queue', {
      docId: currentDocId,
      title,
      content,
      queuedAt: new Date().toISOString(),
    }).catch(() => {});
  }
}

async function saveDraftLocally() {
  if (!currentDocId) return;
  const title = document.getElementById('doc-title').value;
  const content = document.getElementById('doc-content').value;
  await idbPut('drafts', { docId: currentDocId, title, content, savedAt: new Date().toISOString() }).catch(() => {});
}

async function deleteCurrentDocument() {
  if (!currentDocId) return;
  if (!confirm('Delete this document? This cannot be undone.')) return;
  try {
    await apiFetch('/documents/' + currentDocId, { method: 'DELETE' });
    documents = documents.filter(d => d.id !== currentDocId);
    await idbDelete('drafts', currentDocId).catch(() => {});
    await idbDelete('queue', currentDocId).catch(() => {});
    currentDocId = null;
    isDirty = false;
    document.getElementById('editor-pane').classList.add('hidden');
    document.getElementById('empty-state').classList.remove('hidden');
    renderDocList();
    toast('Document deleted');
  } catch (e) {
    toast('Delete failed: ' + e.message);
  }
}

// ─── Offline Queue Sync ───────────────────────────────────────────────────────
async function syncOfflineQueue() {
  let queue = [];
  try { queue = await idbGetAll('queue'); } catch { return; }
  if (!queue.length) return;

  toast(`Syncing ${queue.length} offline change(s)…`);

  for (const item of queue) {
    try {
      await apiFetch('/documents/' + item.docId, {
        method: 'PUT',
        body: JSON.stringify({ title: item.title, content: item.content }),
      });
      await idbDelete('queue', item.docId).catch(() => {});
    } catch (e) {
      console.warn('Sync failed for', item.docId, e);
    }
  }

  await loadDocuments();

  // Reload current doc if it was in queue
  if (currentDocId && queue.find(q => q.docId === currentDocId)) {
    await openDocument(currentDocId);
  }

  setSyncStatus('saved');
  toast('All changes synced ✓');
}

// ─── Online / Offline Detection ───────────────────────────────────────────────
function updateOnlineStatus() {
  isOnline = navigator.onLine;
  const badge = document.getElementById('offline-badge');
  badge.classList.toggle('hidden', isOnline);
  if (isOnline) setSyncStatus('saved');
}

window.addEventListener('online', async () => {
  isOnline = true;
  updateOnlineStatus();
  await syncOfflineQueue();
  // Also save anything currently dirty
  if (isDirty && currentDocId) await saveCurrentDocument(true);
});

window.addEventListener('offline', () => {
  isOnline = false;
  updateOnlineStatus();
});

// ─── Export ───────────────────────────────────────────────────────────────────
async function exportDoc(format) {
  if (!currentDocId) return;
  if (!isOnline) { toast('Export requires internet connection'); return; }
  const url = `${API}/export/${currentDocId}/${format}`;
  const a = document.createElement('a');
  a.href = url;
  a.setAttribute('Authorization', `Bearer ${token}`);

  // Fetch with auth header and trigger download
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    const disp = res.headers.get('content-disposition') || '';
    const match = disp.match(/filename="?([^"]+)"?/);
    link.download = match ? match[1] : `document.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(blobUrl);
    toast(`Exported as .${format}`);
  } catch (e) {
    toast('Export error: ' + e.message);
  }
}

// ─── Files ────────────────────────────────────────────────────────────────────
async function loadFiles() {
  try {
    files = await apiFetch('/files/') || [];
    renderSidebarFiles();
    renderPanelFiles();
  } catch {}
}

function renderSidebarFiles() {
  const el = document.getElementById('file-list');
  if (!files.length) { el.innerHTML = '<span style="font-size:.75rem;color:var(--text-muted)">No files yet</span>'; return; }
  el.innerHTML = files.map(f => `
    <div class="file-item">
      <a href="${escHtml(f.file_url)}" target="_blank" title="${escHtml(f.file_name)}">${escHtml(f.file_name)}</a>
      <button class="file-delete" onclick="deleteFile('${f.id}')" title="Delete">✕</button>
    </div>
  `).join('');
}

function renderPanelFiles() {
  const el = document.getElementById('panel-file-list');
  if (!files.length) { el.innerHTML = '<p style="font-size:.85rem;color:var(--text-muted)">No files uploaded yet.</p>'; return; }
  el.innerHTML = files.map(f => `
    <div class="panel-file-item">
      <span class="panel-file-name">${escHtml(f.file_name)}</span>
      <div class="panel-file-actions">
        <a class="btn btn-ghost btn-sm" href="${escHtml(f.file_url)}" target="_blank">↓ Download</a>
        <button class="btn btn-danger-ghost btn-sm" onclick="deleteFile('${f.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

async function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const progress = document.getElementById('upload-progress');
  const fill = document.getElementById('progress-fill');
  const statusText = document.getElementById('upload-status-text');
  progress.classList.remove('hidden');
  fill.style.width = '20%';
  statusText.textContent = 'Uploading…';

  const formData = new FormData();
  formData.append('file', file);

  try {
    fill.style.width = '60%';
    const res = await fetch(`${API}/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    fill.style.width = '90%';
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Upload failed');
    }
    const newFile = await res.json();
    fill.style.width = '100%';
    statusText.textContent = 'Upload complete ✓';
    files.unshift(newFile);
    renderSidebarFiles();
    renderPanelFiles();
    toast('File uploaded successfully');
    setTimeout(() => { progress.classList.add('hidden'); fill.style.width = '0'; }, 2000);
  } catch (err) {
    fill.style.width = '0';
    statusText.textContent = 'Upload failed: ' + err.message;
    toast('Upload failed: ' + err.message);
  }
  // Reset input
  e.target.value = '';
}

async function deleteFile(id) {
  if (!confirm('Delete this file?')) return;
  try {
    await apiFetch('/files/' + id, { method: 'DELETE' });
    files = files.filter(f => f.id !== id);
    renderSidebarFiles();
    renderPanelFiles();
    toast('File deleted');
  } catch (e) {
    toast('Delete failed: ' + e.message);
  }
}

// ─── Panel ────────────────────────────────────────────────────────────────────
function showFilesPanel() {
  renderPanelFiles();
  document.getElementById('file-panel').classList.remove('hidden');
}

function hideFilesPanel() {
  document.getElementById('file-panel').classList.add('hidden');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideFilesPanel();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setSyncStatus(state) {
  const el = document.getElementById('sync-status');
  el.className = 'sync-status ' + state;
  el.textContent = state === 'saving' ? 'Saving…' : state === 'error' ? 'Offline' : 'Saved';
}

function updateWordCount() {
  const text = document.getElementById('doc-content').value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  document.getElementById('word-count').textContent = words + (words === 1 ? ' word' : ' words');
}

function relTime(iso) {
  if (!iso) return '—';
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 5)   return 'just now';
  if (diff < 60)  return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function escHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

let toastTimer = null;
function toast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}

// ─── Keyboard shortcut: Ctrl+S ────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (currentDocId) saveCurrentDocument(true);
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  idb = await openIDB();

  if (loadToken()) {
    try {
      // Verify token is still valid with a quick health check
      const res = await fetch(API + '/health', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        await enterApp();
        return;
      }
    } catch {}
    clearSession();
  }
  showScreen('auth');
})();