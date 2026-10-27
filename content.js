// Adds checkboxes to the file, page and assignment rows of a Canvas Modules page.
// Each row's ▾ button lists the files inside it so they can be picked one by one.
// Download shows every file that will be saved for a last check, then saves the
// checked ones to Downloads/<course code>/<module>/. Small images (icons) and files
// already downloaded start unticked, and replacing a downloaded file asks first.

// Canvas's Modules list. The script loads on any https://*/courses/* page, so on other
// pages and non-Canvas sites this finds nothing and the script does nothing.
const modules = document.querySelectorAll('#context_modules .context_module[data-module-id]');
const courseId = location.pathname.match(/\/courses\/(\d+)/)?.[1];
const ICON_MAX = 50e3; // images smaller than this many bytes count as icons
const fileCache = new Map(); // fileId -> Promise of Canvas file JSON
const rowLoads = new WeakMap(); // row <li> -> Promise that settles once its file list is filled in
const reviewList = document.createElement('div');
const status = document.createElement('span');
const goButton = button('Download', 'btn btn-primary', () => (reviewEntries ? download() : review()));
const backButton = button('Clear', 'btn', () => (reviewEntries ? endReview() : clearAll()));
const allBox = checkbox('cmd-all', 'Select every file in this course');
let reviewEntries = null; // files shown in the review list; null when not reviewing
let busy = false;

if (modules.length) init();

function init() {
  for (const mod of modules) {
    const rows = [...mod.querySelectorAll('li.context_module_item')].filter(contentRef);
    if (!rows.length) continue;
    for (const li of rows) {
      const igRow = li.querySelector('.ig-row');
      igRow.prepend(checkbox('cmd-row', 'Select the files in this item'));
      igRow.append(button('▾', 'cmd-expand', () => toggleFiles(li), 'Show the files in this item'));
    }
    mod.querySelector('.ig-header').prepend(checkbox('cmd-mod', 'Select every file in this module'));
  }
  // Newer Canvas draws the breadcrumb with React after load and may redraw it,
  // so put the course box back in front of the course name whenever it's missing.
  new MutationObserver(placeAllBox).observe(document.body, { childList: true, subtree: true });
  placeAllBox();

  const bar = el('div');
  bar.id = 'cmd-bar';
  reviewList.id = 'cmd-review';
  reviewList.hidden = true;
  reviewList.addEventListener('change', updateReviewCount);
  status.id = 'cmd-status';
  const controls = el('div', 'cmd-controls');
  controls.append(status, goButton, backButton);
  bar.append(reviewList, controls);
  document.body.append(bar);

  document.addEventListener('change', onChange);
  updateStatus();
}

function placeAllBox() {
  if (allBox.isConnected) return;
  document.querySelector(`#breadcrumbs a[href$="/courses/${courseId}"]`)?.closest('li')?.prepend(allBox);
}

// Rows name their content in a class: Attachment_<fileId>, WikiPage_<pageId> or
// Assignment_<id>. Quizzes carry Assignment_<id> too, so only "assignment" rows count.
function contentRef(li) {
  for (const c of li.classList) {
    const m = c.match(/^(Attachment|WikiPage|Assignment)_(\d+)$/);
    if (m && (m[1] !== 'Assignment' || li.classList.contains('assignment'))) return { kind: m[1], id: m[2] };
  }
  return null;
}

// ---- Selection on the page ----

function onChange(e) {
  const box = e.target;
  if (!box.matches('.cmd-all, .cmd-mod, .cmd-row, .cmd-file')) return;
  if (box.matches('.cmd-all')) {
    for (const b of document.querySelectorAll('.cmd-row:not(:disabled), .cmd-file:not(:disabled)')) {
      b.checked = box.checked;
      b.indeterminate = false;
    }
    for (const b of document.querySelectorAll('.cmd-mod')) syncModule(b.closest('.context_module'));
    syncAll();
    updateStatus();
    return;
  }
  const mod = box.closest('.context_module');
  if (box.matches('.cmd-mod')) {
    for (const b of mod.querySelectorAll('.cmd-row:not(:disabled), .cmd-file:not(:disabled)')) {
      b.checked = box.checked;
      b.indeterminate = false;
    }
  } else if (box.matches('.cmd-row')) {
    for (const b of box.closest('li.context_module_item').querySelectorAll('.cmd-file:not(:disabled)')) {
      b.checked = box.checked;
    }
  } else {
    syncRow(box.closest('li.context_module_item'));
  }
  syncModule(mod);
  syncAll();
  updateStatus();
}

// A row's box is ticked when all its files are, half-ticked when some are.
function syncRow(li) {
  const row = li.querySelector('.cmd-row');
  const files = [...li.querySelectorAll('.cmd-file:not(:disabled)')];
  const n = files.filter((f) => f.checked).length;
  row.disabled = files.length === 0;
  row.checked = n > 0 && n === files.length;
  row.indeterminate = n > 0 && n < files.length;
}

function syncModule(mod) {
  const rows = [...mod.querySelectorAll('.cmd-row:not(:disabled)')];
  const box = mod.querySelector('.cmd-mod');
  box.disabled = rows.length === 0;
  box.checked = rows.length > 0 && rows.every((r) => r.checked);
  box.indeterminate = !box.checked && rows.some((r) => r.checked || r.indeterminate);
}

function syncAll() {
  const mods = [...document.querySelectorAll('.cmd-mod:not(:disabled)')];
  allBox.checked = mods.length > 0 && mods.every((m) => m.checked);
  allBox.indeterminate = !allBox.checked && mods.some((m) => m.checked || m.indeterminate);
}

function clearAll() {
  for (const b of document.querySelectorAll('.cmd-all, .cmd-mod, .cmd-row, .cmd-file')) {
    b.checked = false;
    b.indeterminate = false;
  }
  updateStatus();
}

function updateStatus() {
  if (busy || reviewEntries) return;
  const n = [...document.querySelectorAll('.cmd-row')].filter((b) => b.checked || b.indeterminate).length;
  status.textContent = n ? `${n} item${n === 1 ? '' : 's'} selected` : 'Tick items to download';
  status.title = '';
  goButton.disabled = !n;
}

// ---- Files inside a row ----

function toggleFiles(li) {
  loadRow(li);
  const list = li.querySelector('.cmd-files');
  list.hidden = !list.hidden;
  const btn = li.querySelector('.cmd-expand');
  btn.textContent = list.hidden ? '▾' : '▴';
  btn.setAttribute('aria-expanded', String(!list.hidden));
}

// Builds the row's (hidden) file list the first time it is needed.
function loadRow(li) {
  if (!rowLoads.has(li)) {
    const list = el('ul', 'cmd-files');
    list.hidden = true;
    // Keep Canvas from treating clicks in the list as clicks on the row.
    list.addEventListener('click', (e) => e.stopPropagation());
    li.append(list);
    rowLoads.set(li, fillFiles(li, list));
  }
  return rowLoads.get(li);
}

async function fillFiles(li, list) {
  list.replaceChildren(el('li', 'cmd-note', 'Loading…'));
  const files = [];
  try {
    for (const id of await fileIdsOfRow(li)) {
      files.push([id, await getFile(id).catch((e) => ({ error: e.message }))]);
    }
  } catch (e) {
    list.dataset.error = e.message;
  }
  const checked = li.querySelector('.cmd-row').checked;
  list.replaceChildren(...files.map(([id, file]) => fileItem(id, file, checked)));
  if (!files.length) {
    const text = list.dataset.error ? `Couldn't load: ${list.dataset.error}` : 'No files in this item';
    list.append(el('li', 'cmd-note', text));
  }
  syncRow(li);
  syncModule(li.closest('.context_module'));
  syncAll();
  updateStatus();
}

function fileItem(id, file, checked) {
  const problem = file.error ?? (file.locked_for_user || !file.url ? 'locked' : null);
  const name = file.display_name ?? `File ${id}`;
  const box = checkbox('cmd-file', 'Include this file');
  box.dataset.fileId = id;
  box.disabled = Boolean(problem);
  box.checked = checked && !problem;
  if (problem) box.dataset.problem = `${name} (${problem})`;
  const label = el('label');
  label.append(box, name, el('span', 'cmd-meta', problem ?? formatSize(file.size)));
  const item = el('li');
  item.append(label);
  return item;
}

async function fileIdsOfRow(li) {
  const { kind, id } = contentRef(li);
  if (kind === 'Attachment') return [id];
  const path = kind === 'WikiPage' ? `pages/page_id:${id}` : `assignments/${id}`;
  const content = await api(`/api/v1/courses/${courseId}/${path}`);
  const ids = fileIdsIn(content.body ?? content.description ?? '');
  if (!ids.length && content.locked_for_user) throw new Error('locked');
  return ids;
}

// Canvas file links and embedded images point at .../files/<fileId>[/preview|/download].
function fileIdsIn(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const ids = new Set();
  for (const link of doc.querySelectorAll('a[href], img[src]')) {
    const url = URL.parse(link.getAttribute('href') ?? link.getAttribute('src'), location.href);
    const m = url?.origin === location.origin && url.pathname.match(/\/files\/(\d+)/);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

function getFile(id) {
  if (!fileCache.has(id)) fileCache.set(id, api(`/api/v1/files/${id}`));
  return fileCache.get(id);
}

// ---- Review and download ----

async function review() {
  busy = true;
  goButton.disabled = true;
  // The course code is the name shown at the top of the page, e.g. "BIO-101".
  const course = (await api(`/api/v1/courses/${courseId}`).catch(() => null))?.course_code || `Course ${courseId}`;
  const rows = [...document.querySelectorAll('.cmd-row')]
    .filter((b) => b.checked || b.indeterminate)
    .map((b) => b.closest('li.context_module_item'));
  let loaded = 0;
  await eachLimited(rows, 4, async (li) => {
    await loadRow(li);
    status.textContent = `Finding files… ${++loaded} of ${rows.length}`;
  });

  const entries = new Map(); // fileId -> entry; a file listed in several rows is saved once
  const problems = [];
  for (const li of rows) {
    const from = li.querySelector('.item_name .title').textContent.trim();
    const module = li.closest('.context_module').getAttribute('aria-label');
    const error = li.querySelector('.cmd-files').dataset.error;
    if (error) problems.push(`${from}: ${error}`);
    for (const box of li.querySelectorAll('.cmd-file')) {
      const id = box.dataset.fileId;
      if (box.dataset.problem) problems.push(`${from}: ${box.dataset.problem}`);
      else if (box.checked && !entries.has(id)) entries.set(id, { folder: [course, module], from, file: await getFile(id) });
    }
  }
  const list = [...entries.values()];
  const saved = await send({ check: list.map(savePath) }).catch(() => []);
  list.forEach((e, i) => {
    e.saved = saved[i];
    e.icon = Boolean(e.file['content-type']?.startsWith('image/')) && e.file.size < ICON_MAX;
  });
  busy = false;
  showReview(list, problems);
}

function savePath(entry) {
  return [...entry.folder, entry.file.display_name];
}

function showReview(entries, problems) {
  reviewEntries = entries;
  reviewList.replaceChildren();
  const icons = entries.filter((e) => e.icon);
  if (icons.length) {
    const skip = checkbox('cmd-pick', 'Leave small images unticked');
    skip.checked = true;
    skip.addEventListener('change', () => icons.forEach((e) => (e.box.checked = !skip.checked)));
    const label = el('label', 'cmd-heading');
    label.append(skip, `Skip ${icons.length} icon${icons.length === 1 ? '' : 's'} (images under ${formatSize(ICON_MAX)})`);
    reviewList.append(label);
  }
  let folder;
  for (const entry of entries) {
    if (entry.folder.join(' / ') !== folder) {
      folder = entry.folder.join(' / ');
      reviewList.append(el('div', 'cmd-heading', folder));
    }
    entry.box = checkbox('cmd-pick', 'Download this file');
    entry.box.checked = !entry.icon && !entry.saved;
    const label = el('label');
    label.title = `From: ${entry.from}`;
    const meta = [formatSize(entry.file.size), entry.icon && 'icon', entry.saved && 'already downloaded'];
    label.append(entry.box, entry.file.display_name, el('span', 'cmd-meta', meta.filter(Boolean).join(' · ')));
    reviewList.append(label);
  }
  if (!entries.length) reviewList.append(el('div', 'cmd-note', 'No files found in the selected items.'));
  for (const p of problems) reviewList.append(el('div', 'cmd-note', `Skipped: ${p}`));
  reviewList.hidden = false;
  backButton.textContent = 'Back';
  updateReviewCount();
}

function updateReviewCount() {
  if (busy) return;
  const n = reviewEntries.filter((e) => e.box.checked).length;
  status.textContent = `${n} of ${reviewEntries.length} files`;
  goButton.textContent = n ? `Download ${n}` : 'Download';
  goButton.disabled = !n;
}

function endReview() {
  reviewEntries = null;
  reviewList.hidden = true;
  goButton.textContent = 'Download';
  backButton.textContent = 'Clear';
  updateStatus();
}

async function download() {
  const chosen = reviewEntries.filter((e) => e.box.checked);
  const replacing = chosen.filter((e) => e.saved).map((e) => e.file.display_name);
  if (replacing.length) {
    const shown = replacing.slice(0, 10).join('\n') + (replacing.length > 10 ? `\n…and ${replacing.length - 10} more` : '');
    const n = replacing.length === 1 ? '1 file' : `${replacing.length} files`;
    if (!confirm(`Replace ${n} you already downloaded?\n\n${shown}\n\nCancel to go back and untick them.`)) return;
  }
  busy = true;
  goButton.disabled = backButton.disabled = true;
  const failures = [];
  for (const [i, e] of chosen.entries()) {
    status.textContent = `Downloading ${i + 1} of ${chosen.length}…`;
    try {
      await send({ url: e.file.url, path: savePath(e), overwrite: e.saved });
    } catch (err) {
      failures.push(`${e.file.display_name}: ${err.message}`);
    }
  }
  busy = false;
  backButton.disabled = false;
  endReview();
  status.textContent =
    `Done: ${chosen.length - failures.length} downloaded` +
    (failures.length ? `, ${failures.length} failed (hover for details)` : '');
  status.title = failures.join('\n');
  for (const f of failures) console.warn('[Canvas Bulk Downloader]', f);
}

// ---- Helpers ----

// Runs fn over items with at most `limit` at a time, to stay under Canvas rate limits.
async function eachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: limit }, worker));
}

// Asks background.js to do something; it replies with { result } or { error }.
async function send(msg) {
  const reply = await (globalThis.browser ?? chrome).runtime.sendMessage(msg);
  if (reply.error) throw new Error(reply.error);
  return reply.result;
}

async function api(path) {
  const res = await fetch(location.origin + path, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function checkbox(className, title) {
  const box = el('input', className);
  box.type = 'checkbox';
  box.title = title;
  box.setAttribute('aria-label', title);
  // Keep Canvas from also handling the click (e.g. collapsing the module).
  box.addEventListener('click', (e) => e.stopPropagation());
  return box;
}

function button(text, className, onClick, title = '') {
  const b = el('button', className, text);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function formatSize(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(bytes / 1e3)} KB`;
}
