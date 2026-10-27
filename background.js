// Saves one file to Downloads/<path parts...>, or reports which files are already
// saved. Messages come from content.js. The browser creates missing folders and reuses
// existing ones, so the same course and module always land in the same folder.

const ext = globalThis.browser ?? chrome; // Firefox has `browser`, Chrome only `chrome`

// Chrome only takes replies through sendResponse, so both browsers answer that way.
ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (msg.check ? alreadySaved(msg.check) : save(msg, sender.tab)).then(
    (result) => sendResponse({ result }),
    (err) => sendResponse({ error: err.message })
  );
  return true;
});

function save(msg, tab) {
  return ext.downloads.download({
    url: msg.url,
    filename: msg.path.map(clean).join('/'),
    // Replace only when the user confirmed it; any other clash gets a "(1)" suffix.
    conflictAction: msg.overwrite ? 'overwrite' : 'uniquify',
    saveAs: false,
    // Firefox: use the tab's container so Canvas login cookies apply. Chrome has none.
    ...(tab.cookieStoreId && { cookieStoreId: tab.cookieStoreId }),
  });
}

// For each path, whether the browser's download history has it saved and still on disk.
// Files saved some other way (or after clearing history) aren't known here.
async function alreadySaved(paths) {
  const saved = (await ext.downloads.search({ state: 'complete', exists: true })).map((d) =>
    d.filename.replaceAll('\\', '/').toLowerCase()
  );
  return paths.map((p) => {
    const tail = '/' + p.map(clean).join('/').toLowerCase();
    return saved.some((f) => f.endsWith(tail));
  });
}

// Browsers reject any path part their sanitizer would change, so pre-apply the rules.
function clean(part) {
  return part
    .replace(/\s+/g, ' ')
    .replace(/[\\/:*?"<>|%\p{Cc}\p{Cf}]/gu, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '') || 'untitled';
}
