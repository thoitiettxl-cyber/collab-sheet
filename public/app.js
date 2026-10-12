// hard-site client: grid UI + websocket sync. Plain ESM, no build step.
const COLS = 26; // A-Z
const ROWS = 50;

const params = new URLSearchParams(location.search);
const DOC = params.get('doc') || 'default';

const grid = document.getElementById('grid');
const gridWrap = document.getElementById('gridWrap');
const formulaInput = document.getElementById('formulaInput');
const selLabel = document.getElementById('selLabel');
const docNameEl = document.getElementById('docName');
const userListEl = document.getElementById('userList');
const nameInput = document.getElementById('nameInput');
const myDot = document.getElementById('myDot');
const connDot = document.getElementById('connDot');
const connText = document.getElementById('connText');
const statusText = document.getElementById('statusText');

docNameEl.textContent = DOC;

// ---------- address helpers ----------
function colToLetters(i) { // 0-based
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
function refToCoords(ref) {
  const m = /^([A-Z]+)([0-9]+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}
function coordsToRef(col, row) {
  return `${colToLetters(col)}${row + 1}`;
}

// ---------- state ----------
let ws = null;
let myId = null;
let myColor = '#999';
let version = 0;
let cells = {}; // ref -> { raw, value, error }
let users = [];
let selected = 'A1';
const cellEls = {}; // ref -> td

function myName() {
  return localStorage.getItem('hardsite-name') || '';
}

// ---------- grid build ----------
function buildGrid() {
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  const corner = document.createElement('th');
  hr.appendChild(corner);
  for (let c = 0; c < COLS; c++) {
    const th = document.createElement('th');
    th.textContent = colToLetters(c);
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  grid.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let r = 0; r < ROWS; r++) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = String(r + 1);
    tr.appendChild(th);
    for (let c = 0; c < COLS; c++) {
      const ref = coordsToRef(c, r);
      const td = document.createElement('td');
      td.dataset.ref = ref;
      td.addEventListener('click', () => select(ref, true));
      td.addEventListener('dblclick', () => {
        select(ref, true);
        focusFormula(true);
      });
      tr.appendChild(td);
      cellEls[ref] = td;
    }
    tbody.appendChild(tr);
  }
  grid.appendChild(tbody);
}

function formatValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : String(v);
  return String(v);
}

function displayOf(cell) {
  if (!cell) return '';
  if (cell.error) return cell.error;
  return formatValue(cell.value);
}

function renderCell(ref) {
  const td = cellEls[ref];
  if (!td) return;
  const cell = cells[ref];
  td.textContent = displayOf(cell);
  td.classList.toggle('err', !!(cell && cell.error));
  td.classList.toggle('num', !!(cell && !cell.error && typeof cell.value === 'number'));
}

function renderAll() {
  for (const ref of Object.keys(cellEls)) renderCell(ref);
}

function applyChanges(changes) {
  for (const [ref, c] of Object.entries(changes)) {
    if (c.raw === null || c.raw === undefined) {
      delete cells[ref];
    } else {
      cells[ref] = c;
    }
    renderCell(ref);
  }
  // Refresh formula bar if the selected cell changed remotely and we're not editing.
  if (changes[selected] && document.activeElement !== formulaInput) {
    syncFormulaBar();
  }
}

// ---------- selection ----------
function select(ref, notify) {
  if (!cellEls[ref]) return;
  const prev = cellEls[selected];
  if (prev) prev.classList.remove('sel');
  selected = ref;
  cellEls[ref].classList.add('sel');
  selLabel.textContent = ref;
  if (document.activeElement !== formulaInput) syncFormulaBar();
  // keep selected cell visible
  cellEls[ref].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (notify) send({ type: 'select', ref });
}

function syncFormulaBar() {
  const cell = cells[selected];
  formulaInput.value = cell && cell.raw !== null && cell.raw !== undefined ? String(cell.raw) : '';
}

function focusFormula(selectAll) {
  formulaInput.focus();
  if (selectAll) formulaInput.select();
}

function moveSelection(dc, dr) {
  const p = refToCoords(selected);
  if (!p) return;
  const nc = Math.min(COLS - 1, Math.max(0, p.col + dc));
  const nr = Math.min(ROWS - 1, Math.max(0, p.row + dr));
  select(coordsToRef(nc, nr), true);
  gridWrap.focus({ preventScroll: true });
}

function commitFormula(moveDown) {
  const raw = formulaInput.value;
  send({ type: 'set', ref: selected, raw: raw === '' ? null : raw });
  setStatus(`saved ${selected}`);
  if (moveDown) moveSelection(0, 1);
  else gridWrap.focus({ preventScroll: true });
}

// ---------- presence ----------
function renderPresence() {
  // clear markers
  for (const td of Object.values(cellEls)) {
    td.style.boxShadow = '';
    td.querySelectorAll('.presence-tag').forEach((el) => el.remove());
  }
  userListEl.innerHTML = '';
  for (const u of users) {
    const chip = document.createElement('span');
    chip.className = 'user-chip';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = u.color;
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(u.name + (u.id === myId ? ' (you)' : '')));
    userListEl.appendChild(chip);

    if (u.id !== myId && u.sel && cellEls[u.sel]) {
      const td = cellEls[u.sel];
      td.style.boxShadow = `inset 0 0 0 2px ${u.color}`;
      const tag = document.createElement('span');
      tag.className = 'presence-tag';
      tag.textContent = u.name;
      tag.style.background = u.color;
      td.appendChild(tag);
    }
  }
}

// ---------- websocket ----------
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setStatus(t) {
  statusText.textContent = t;
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?doc=${encodeURIComponent(DOC)}&name=${encodeURIComponent(myName())}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    connDot.className = 'conn-dot on';
    connText.textContent = 'connected';
    setStatus('connected');
  };

  ws.onclose = () => {
    connDot.className = 'conn-dot off';
    connText.textContent = 'reconnecting…';
    setStatus('connection lost — retrying');
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    try { ws.close(); } catch { /* noop */ }
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    onMessage(msg);
  };
}

function onMessage(msg) {
  switch (msg.type) {
    case 'init': {
      if (msg.you) {
        myId = msg.you.id;
        myColor = msg.you.color;
        myDot.style.background = myColor;
        if (!nameInput.value) nameInput.value = msg.you.name;
      }
      version = msg.version;
      cells = msg.cells || {};
      renderAll();
      syncFormulaBar();
      if (msg.users) {
        users = msg.users;
        renderPresence();
      }
      setStatus(`loaded doc "${DOC}" · v${version}`);
      break;
    }
    case 'update': {
      if (typeof msg.version === 'number') {
        if (msg.version > version + 1) {
          // missed something; resync to be safe
          send({ type: 'sync' });
        }
        version = Math.max(version, msg.version);
      }
      if (msg.changes) applyChanges(msg.changes);
      const who = users.find((u) => u.id === msg.by);
      setStatus(`${msg.op === 'undo' ? 'undo' : msg.op === 'redo' ? 'redo' : 'edit'} ${msg.ref || ''} by ${who ? who.name : 'someone'} · v${version}`);
      break;
    }
    case 'presence': {
      users = msg.users || [];
      renderPresence();
      break;
    }
    case 'you': {
      if (msg.you) {
        myId = msg.you.id;
        myColor = msg.you.color;
        myDot.style.background = myColor;
        nameInput.value = msg.you.name;
        localStorage.setItem('hardsite-name', msg.you.name);
      }
      break;
    }
    case 'noop': {
      setStatus(`nothing to ${msg.op}`);
      break;
    }
    case 'error': {
      setStatus(`error: ${msg.message}`);
      break;
    }
  }
}

// ---------- events ----------
formulaInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitFormula(true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    syncFormulaBar();
    gridWrap.focus({ preventScroll: true });
  } else if (e.key === 'Tab') {
    e.preventDefault();
    commitFormula(false);
    moveSelection(1, 0);
  }
});

document.addEventListener('keydown', (e) => {
  const inFormula = document.activeElement === formulaInput;
  const inName = document.activeElement === nameInput;

  if ((e.ctrlKey || e.metaKey) && !inName) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      send({ type: 'undo' });
      return;
    }
    if (k === 'y' || (k === 'z' && e.shiftKey)) {
      e.preventDefault();
      send({ type: 'redo' });
      return;
    }
    return;
  }
  if (inFormula || inName) return;

  switch (e.key) {
    case 'ArrowUp': e.preventDefault(); moveSelection(0, -1); break;
    case 'ArrowDown': e.preventDefault(); moveSelection(0, 1); break;
    case 'ArrowLeft': e.preventDefault(); moveSelection(-1, 0); break;
    case 'ArrowRight': e.preventDefault(); moveSelection(1, 0); break;
    case 'Enter':
      e.preventDefault();
      focusFormula(true);
      break;
    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      send({ type: 'set', ref: selected, raw: null });
      break;
    case 'Escape':
      gridWrap.focus({ preventScroll: true });
      break;
    default:
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // start typing directly into the formula bar
        e.preventDefault();
        focusFormula(false);
        formulaInput.value = e.key;
      }
  }
});

nameInput.addEventListener('change', () => {
  const name = nameInput.value.trim().slice(0, 20);
  if (!name) return;
  localStorage.setItem('hardsite-name', name);
  send({ type: 'rename', name });
});

// ---------- boot ----------
nameInput.value = myName();
buildGrid();
select('A1', false);
syncFormulaBar();
connect();
