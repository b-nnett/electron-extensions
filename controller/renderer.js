const get = id => document.getElementById(id);
let current;
let initialized = false;
let pending = false;
let consoleFingerprint = '';

function render(state) {
  current = state;
  if (!initialized) {
    get('css-editor').value = state.presets.neon || '';
    initialized = true;
  }
  const busy = state.busy || pending;
  get('launch').disabled = busy || state.launched || !state.available;
  get('stop').disabled = busy || !state.launched;
  for (const name of ['apply', 'remove', 'reload']) get(name).disabled = busy || !state.running;
  get('install-button').disabled = busy || !state.running || state.demoActive;
  get('remove-button').disabled = busy || !state.running || !state.demoActive;
  get('demo-status').textContent = state.demoActive ? 'BUTTON ADDED' : 'NOT ADDED';
  get('demo-status').classList.toggle('active', state.demoActive);
  const entries = state.consoleEntries || [];
  const nextFingerprint = JSON.stringify(entries);
  if (nextFingerprint !== consoleFingerprint) {
    consoleFingerprint = nextFingerprint;
    const feed = get('console-feed');
    const lines = entries.map(entry => {
      const line = document.createElement('p');
      const time = new Date(entry.timestamp).toLocaleTimeString();
      line.textContent = `${time}  ${entry.message} ${entry.clickCount}`;
      return line;
    });
    if (!lines.length) {
      const empty = document.createElement('p');
      empty.className = 'console-empty';
      empty.textContent = 'Button clicks will appear here.';
      lines.push(empty);
    }
    feed.replaceChildren(...lines);
    feed.scrollTop = feed.scrollHeight;
  }
  get('verify').disabled = busy || !state.baseline;
  get('connection').textContent = state.running ? 'Connected' : 'Offline';
  get('connection').classList.toggle('online', state.running);
  get('style-status').textContent = state.cssActive ? 'CUSTOM CSS' : 'ORIGINAL';
  get('style-status').classList.toggle('active', state.cssActive);
  get('background').textContent = state.button?.background || '—';
  get('foreground').textContent = state.button?.color || '—';
  get('radius').textContent = state.button?.radius || '—';
  get('status-message').textContent = state.message;
  get('status-dot').classList.toggle('busy', busy);
  get('status').setAttribute('aria-busy', String(busy));
  get('error').hidden = !state.error;
  get('error').textContent = state.error || '';
  const verified = Boolean(state.integrity?.unchanged);
  get('integrity-icon').textContent = verified ? '✓' : '○';
  get('integrity-icon').classList.toggle('verified', verified);
  get('integrity-status').textContent = verified ? 'Verified unchanged' : state.baseline ? 'Original signature captured' : 'Awaiting a baseline';
  get('integrity-detail').textContent = verified
    ? `${state.integrity.after.files.toLocaleString()} files checked. Bundle SHA-256 and code signature hash both match.`
    : state.baseline ? 'Signature is valid. Apply your styles, then compare the bundle against this baseline.'
      : 'Launch captures the original signature and a fingerprint of every bundle file.';
}

async function run(callback) {
  if (pending || current?.busy) return;
  pending = true;
  if (current) render(current);
  try {
    const result = await callback();
    if (!result.ok && current) render({ ...current, error: result.error });
  } catch (error) {
    if (current) render({ ...current, error: error.message });
  } finally {
    pending = false;
    if (current) render(current);
  }
}

get('launch').addEventListener('click', () => run(() => window.styleLab.launch()));
get('apply').addEventListener('click', () => run(() => window.styleLab.applyCSS(get('css-editor').value)));
get('remove').addEventListener('click', () => run(() => window.styleLab.removeCSS()));
get('install-button').addEventListener('click', () => run(() => window.styleLab.installButton()));
get('remove-button').addEventListener('click', () => run(() => window.styleLab.removeButton()));
get('reload').addEventListener('click', () => run(() => window.styleLab.reload()));
get('verify').addEventListener('click', () => run(() => window.styleLab.verify()));
get('stop').addEventListener('click', () => run(() => window.styleLab.stop()));

for (const name of ['neon', 'lilac']) {
  get(`preset-${name}`).addEventListener('click', () => {
    if (!current) return;
    get('css-editor').value = current.presets[name];
    for (const other of ['neon', 'lilac']) {
      get(`preset-${other}`).classList.toggle('selected', name === other);
      get(`preset-${other}`).setAttribute('aria-pressed', String(name === other));
    }
  });
}

get('css-editor').addEventListener('input', () => {
  for (const name of ['neon', 'lilac']) {
    get(`preset-${name}`).classList.remove('selected');
    get(`preset-${name}`).setAttribute('aria-pressed', 'false');
  }
});
get('css-editor').addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    if (current?.running) run(() => window.styleLab.applyCSS(get('css-editor').value));
  }
});

window.styleLab.subscribe(render);
window.styleLab.snapshot().then(render).catch(error => {
  get('status-message').textContent = 'Controller could not initialize.';
  get('error').hidden = false;
  get('error').textContent = error.message;
});
