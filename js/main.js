import { KING_MOVES, attacksFrom, kingsAdjacent, squareName } from './chess.js';
import { UNKNOWN, TRANSFORM, TRIANGLE_SQUARES, onDiagonal, tableIndex } from './tablebase.js';

const SETS = {
  BN: 'Bishop + Knight',
  BB: 'Two Bishops',
  R: 'Rook',
  Q: 'Queen',
};
const GLYPH = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞' };

const $ = (id) => document.getElementById(id);
const boardEl = $('board'), squaresEl = $('squares'), piecesEl = $('pieces');
const overlayEl = $('overlay'), statusEl = $('status'), moveListEl = $('movelist');
const timeEl = $('time'), movesEl = $('moves'), bestEl = $('best');
const setEl = $('set'), startEl = $('start');

const tables = new Map();   // pieces -> Promise<{ table, standard }>
let tb = null;
let pieces = load('set', 'BN');
let startMode = load('start', 'standard');
if (!SETS[pieces]) pieces = 'BN';

// Game state. `pos` holds squares: [white king, ...white pieces, black king];
// a captured piece's square becomes -1.
let types = [];
let pos = [];
let status = 'loading';     // loading | ready | running | won | failed
let history = [];           // { white, black, loss }
let startDtm = 0;
let t0 = 0, elapsed = 0;
let selected = -1, targets = [];
let lastMove = [];
let drag = null;
let pieceEls = [];

function load(key, fallback) {
  try { return localStorage.getItem('cs:' + key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem('cs:' + key, value); } catch { /* private mode */ }
}

// ---------- tablebase ----------

// Built tables are kept in IndexedDB so only the first visit pays for generation.
const DB_STORE = 'tables';
function db(mode, action) {
  return new Promise((resolve) => {
    let open;
    try { open = indexedDB.open('checkmate-speedrun-tb2', 1); } catch { return resolve(null); }
    open.onupgradeneeded = () => open.result.createObjectStore(DB_STORE);
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      try {
        const req = action(open.result.transaction(DB_STORE, mode).objectStore(DB_STORE));
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    };
  });
}

function buildTable(p) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./tb-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      worker.terminate();
      const { table, histogram } = e.data;
      // Standard start: the most common mate length, so every run has the same par.
      let standard = 1;
      for (let d = 1; d < histogram.length; d++) {
        if (histogram[d] > histogram[standard]) standard = d;
      }
      resolve({ table, standard });
    };
    worker.postMessage({ pieces: p });
  });
}

function requestTable(p) {
  if (!tables.has(p)) {
    tables.set(p, (async () => {
      const cached = await db('readonly', (store) => store.get(p));
      if (cached?.table instanceof Uint8Array) return cached;
      const built = await buildTable(p);
      db('readwrite', (store) => store.put(built, p));
      return built;
    })());
  }
  return tables.get(p);
}

const dtm = (squares) => {
  const v = tb.table[tableIndex(squares)];
  return v === UNKNOWN ? Infinity : (v + 1) >> 1;
};

// Uniform over real positions: pick a stored entry, then a random board symmetry.
function randomStart() {
  const n = tb.table.length;
  const want = startMode === 'standard' ? tb.standard * 2 - 1 : -1;
  for (;;) {
    let idx = Math.floor(Math.random() * n);
    const v = tb.table[idx];
    if (v === UNKNOWN || (want >= 0 ? v !== want : v < 5)) continue;
    const squares = [];
    for (let i = 1; i < types.length; i++) { squares.unshift(idx & 63); idx = Math.floor(idx / 64); }
    squares.unshift(TRIANGLE_SQUARES[idx]);
    // Diagonal-king positions are stored twice, so keep them half as often.
    if (onDiagonal(squares[0]) && Math.random() < 0.5) continue;
    const map = TRANSFORM[Math.floor(Math.random() * 8)];
    return squares.map((s) => map[s]);
  }
}

// ---------- rules ----------

function occupancy(skipBlackKing) {
  const occ = new Uint8Array(64);
  const last = pos.length - (skipBlackKing ? 1 : 0);
  for (let i = 0; i < last; i++) if (pos[i] >= 0) occ[pos[i]] = 1;
  return occ;
}

function legalTargets(man) {
  const occ = occupancy(false);
  const bk = pos[pos.length - 1];
  return attacksFrom(types[man], pos[man], occ).filter(
    (t) => !occ[t] && !(man === 0 && kingsAdjacent(t, bk)),
  );
}

function whiteAttacks() {
  const occ = occupancy(true);
  const att = new Uint8Array(64);
  for (let i = 0; i < pos.length - 1; i++) {
    if (pos[i] < 0) continue;
    for (const t of attacksFrom(types[i], pos[i], occ)) att[t] = 1;
  }
  return att;
}

// Black plays the move that postpones mate the longest; takes a piece if it can.
function blackReply() {
  const k = pos.length - 1, bk = pos[k];
  const att = whiteAttacks();
  let best = [], bestValue = -1, capture = -1;
  for (const d of KING_MOVES[bk]) {
    if (att[d]) continue;
    const victim = pos.indexOf(d);
    if (victim >= 0) { capture = d; break; }
    const next = pos.slice(); next[k] = d;
    const v = tb.table[tableIndex(next)];
    if (v > bestValue) { bestValue = v; best = [d]; }
    else if (v === bestValue) best.push(d);
  }
  if (capture >= 0) return { to: capture, capture: true, check: !!att[bk] };
  if (!best.length) return { to: -1, mate: !!att[bk], stalemate: !att[bk] };
  return { to: best[Math.floor(Math.random() * best.length)], check: !!att[bk] };
}

// ---------- game flow ----------

async function newGame() {
  const wanted = pieces;
  status = 'loading';
  drag = null;
  const pending = requestTable(wanted);
  const slow = setTimeout(() => {
    overlayEl.textContent = 'Building tablebase… (first visit only)';
    overlayEl.hidden = false;
  }, 150);
  const entry = await pending;
  clearTimeout(slow);
  if (wanted !== pieces) return;   // user switched sets meanwhile
  overlayEl.hidden = true;
  tb = entry;
  types = ['K', ...pieces, 'k'];
  renderStartOptions();

  pos = randomStart();
  startDtm = dtm(pos);
  history = [];
  elapsed = 0;
  selected = -1; targets = []; lastMove = [];
  status = 'ready';

  buildPieces();
  renderHighlights();
  renderStats();
  moveListEl.textContent = '';
  statusEl.className = '';
  statusEl.textContent = 'Checkmate the king. The clock starts on your first move.';
  renderBest();
}

function play(man, to, animate) {
  if (status === 'ready') {
    status = 'running';
    t0 = performance.now();
    requestAnimationFrame(tick);
  }
  const before = dtm(pos);
  pos[man] = to;
  placePiece(man, animate);

  const k = pos.length - 1;
  const reply = blackReply();
  const record = {
    white: (types[man] === 'K' ? 'K' : types[man]) + squareName(to)
      + (reply.mate ? '#' : reply.check ? '+' : ''),
    black: '',
    loss: 0,
  };
  history.push(record);
  selected = -1; targets = [];

  if (reply.to < 0) {
    lastMove = [];
    finish(reply.mate ? 'won' : 'stalemate');
  } else {
    lastMove = [pos[k], reply.to];
    record.black = 'K' + (reply.capture ? 'x' : '') + squareName(reply.to);
    if (reply.capture) {
      const victim = pos.indexOf(reply.to);
      pos[victim] = -1;
      pieceEls[victim].remove();
    }
    pos[k] = reply.to;
    placePiece(k, true);
    if (reply.capture) {
      record.loss = Infinity;
      finish('captured');
    } else {
      record.loss = dtm(pos) - (before - 1);
    }
  }
  renderHighlights();
  renderStats();
}

function finish(outcome) {
  elapsed = performance.now() - t0;
  const n = history.length;
  if (outcome === 'won') {
    status = 'won';
    const extra = n - startDtm;
    statusEl.className = 'won';
    statusEl.innerHTML = `Mate in <b>${n}</b> moves, <b>${seconds(elapsed)}s</b>. `
      + `Tablebase optimum: <b>${startDtm}</b>`
      + (extra > 0 ? ` (+${extra}).` : ' — perfect.');
    updateBest(elapsed, extra);
  } else {
    status = 'failed';
    statusEl.className = 'failed';
    statusEl.innerHTML = (outcome === 'stalemate' ? 'Stalemate.' : 'Piece lost — draw.')
      + ` It was mate in <b>${startDtm}</b>.`;
  }
  renderMoveList();
}

// ---------- rendering ----------

const seconds = (ms) => (ms / 1000).toFixed(2);

function tick() {
  if (status !== 'running') return;
  timeEl.textContent = seconds(performance.now() - t0);
  requestAnimationFrame(tick);
}

function renderStats() {
  boardEl.classList.toggle('in-run', status === 'running');
  timeEl.textContent = seconds(status === 'running' ? performance.now() - t0 : elapsed);
  movesEl.textContent = history.length;
}

function buildSquares() {
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const el = document.createElement('div');
      el.className = 'sq' + ((row + col) % 2 ? ' d' : '');
      if (row === 7) el.innerHTML += `<span class="coord file">${'abcdefgh'[col]}</span>`;
      if (col === 0) el.innerHTML += `<span class="coord rank">${8 - row}</span>`;
      squaresEl.append(el);
    }
  }
}
const squareEl = (s) => squaresEl.children[(7 - (s >> 3)) * 8 + (s & 7)];

function buildPieces() {
  piecesEl.textContent = '';
  pieceEls = pos.map((_, i) => {
    const el = document.createElement('div');
    const black = types[i] === 'k';
    el.className = 'piece ' + (black ? 'black' : 'white');
    el.textContent = GLYPH[black ? 'K' : types[i]] + '︎';
    piecesEl.append(el);
    return el;
  });
  pos.forEach((_, i) => placePiece(i, false));
}

function placePiece(i, animate) {
  const el = pieceEls[i], s = pos[i];
  el.classList.remove('dragging');
  el.classList.toggle('glide', !!animate);
  el.style.transform = `translate(${(s & 7) * 100}%, ${(7 - (s >> 3)) * 100}%)`;
}

function renderHighlights(hover = -1) {
  for (const el of squaresEl.children) el.classList.remove('sel', 'last', 'target', 'hover');
  for (const s of lastMove) squareEl(s).classList.add('last');
  if (selected >= 0) squareEl(pos[selected]).classList.add('sel');
  for (const s of targets) squareEl(s).classList.add('target');
  if (hover >= 0 && targets.includes(hover)) squareEl(hover).classList.add('hover');
}

function renderMoveList() {
  moveListEl.textContent = '';
  history.forEach((m, i) => {
    const li = document.createElement('li');
    const lossy = m.loss > 0;
    const mark = m.loss === Infinity ? '??' : lossy ? `<sup>+${m.loss}</sup>` : '';
    li.innerHTML = `<span class="n">${i + 1}.</span>`
      + `<span class="w${lossy ? ' loss' : ''}">${m.white}${mark}</span> ${m.black}`;
    moveListEl.append(li);
  });
}

function bestKey() { return `best:${pieces}:${startMode}`; }
function renderBest() {
  let best = null;
  try { best = JSON.parse(load(bestKey(), 'null')); } catch { /* ignore */ }
  bestEl.textContent = best ? `${seconds(best.time)}s · +${best.extra}` : '–';
}
function updateBest(time, extra) {
  let best = null;
  try { best = JSON.parse(load(bestKey(), 'null')); } catch { /* ignore */ }
  best = {
    time: best ? Math.min(best.time, time) : time,
    extra: best ? Math.min(best.extra, extra) : extra,
  };
  save(bestKey(), JSON.stringify(best));
  renderBest();
}

function renderStartOptions() {
  startEl.textContent = '';
  startEl.add(new Option(`Standard · mate in ${tb.standard}`, 'standard'));
  startEl.add(new Option('Any position', 'random'));
  startEl.value = startMode;
}

// ---------- input ----------
// Everything acts on pointerdown. Three ways to move: drag, click piece then
// square, or just click a square that only one piece can reach.

function squareAt(e) {
  const r = boardEl.getBoundingClientRect();
  const col = Math.floor(((e.clientX - r.left) / r.width) * 8);
  const row = Math.floor(((e.clientY - r.top) / r.height) * 8);
  if (col < 0 || col > 7 || row < 0 || row > 7) return -1;
  return (7 - row) * 8 + col;
}

function select(man) {
  selected = man;
  targets = man >= 0 ? legalTargets(man) : [];
}

boardEl.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  if ((status !== 'ready' && status !== 'running') || drag) return;
  const s = squareAt(e);
  if (s < 0) return;

  const man = pos.indexOf(s);
  if (man >= 0 && man < pos.length - 1) {
    drag = { man, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, wasSelected: selected === man };
    select(man);
    boardEl.setPointerCapture(e.pointerId);
    renderHighlights();
    return;
  }
  if (selected >= 0) {
    if (targets.includes(s)) { play(selected, s, true); return; }
    select(-1);
    renderHighlights();
    return;
  }
  const movers = [];
  for (let i = 0; i < pos.length - 1; i++) {
    if (pos[i] >= 0 && legalTargets(i).includes(s)) movers.push(i);
  }
  if (movers.length === 1) play(movers[0], s, true);
});

boardEl.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
  drag.moved = true;
  const r = boardEl.getBoundingClientRect();
  const size = r.width / 8;
  const el = pieceEls[drag.man];
  el.classList.remove('glide');
  el.classList.add('dragging');
  el.style.transform = `translate(${e.clientX - r.left - size / 2}px, ${e.clientY - r.top - size / 2}px)`;
  renderHighlights(squareAt(e));
});

function endDrag(e, cancelled) {
  if (!drag || e.pointerId !== drag.id) return;
  const { man, moved, wasSelected } = drag;
  drag = null;
  const s = cancelled ? -1 : squareAt(e);
  if (moved && targets.includes(s)) { play(man, s, false); return; }
  placePiece(man, false);                       // snap back, keep it selected
  if (!moved && wasSelected) select(-1);        // second click on a piece deselects
  renderHighlights();
}
boardEl.addEventListener('pointerup', (e) => endDrag(e, false));
boardEl.addEventListener('pointercancel', (e) => endDrag(e, true));
boardEl.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- board size ----------
// Drag the bottom-right corner; unavailable during a run so it can't be hit by accident.

const MIN_BOARD = 280, MAX_BOARD = 1400;
const resizeEl = $('resize');
let resizing = null;

function applyBoardSize(px) {
  const root = document.documentElement.style;
  if (px) root.setProperty('--board', `min(100vw - 24px, ${px}px)`);
  else root.removeProperty('--board');
}
applyBoardSize(Number(load('size', 0)) || 0);

resizeEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();                      // never reaches the board as a move
  if (status === 'running') return;
  resizing = { id: e.pointerId, x: e.clientX, y: e.clientY, size: boardEl.getBoundingClientRect().width };
  resizeEl.setPointerCapture(e.pointerId);
});
resizeEl.addEventListener('pointermove', (e) => {
  if (!resizing || e.pointerId !== resizing.id) return;
  // The board is centred, so a sideways drag moves the corner half as far.
  const dx = 2 * (e.clientX - resizing.x), dy = e.clientY - resizing.y;
  const size = resizing.size + (Math.abs(dx) > Math.abs(dy) ? dx : dy);
  resizing.now = Math.round(Math.max(MIN_BOARD, Math.min(MAX_BOARD, window.innerWidth - 24, size)));
  applyBoardSize(resizing.now);
});
const endResize = (e) => {
  if (!resizing || e.pointerId !== resizing.id) return;
  if (resizing.now) save('size', resizing.now);
  resizing = null;
};
resizeEl.addEventListener('pointerup', endResize);
resizeEl.addEventListener('pointercancel', endResize);
resizeEl.addEventListener('dblclick', () => {
  if (status === 'running') return;
  applyBoardSize(0);
  save('size', 0);
});

document.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyR') {
    e.preventDefault();
    newGame();
  }
});
$('new').addEventListener('click', (e) => { e.currentTarget.blur(); newGame(); });

setEl.addEventListener('change', () => {
  pieces = setEl.value; save('set', pieces); setEl.blur(); newGame();
});
startEl.addEventListener('change', () => {
  startMode = startEl.value; save('start', startMode); startEl.blur(); newGame();
});

// ---------- boot ----------

for (const [value, label] of Object.entries(SETS)) setEl.add(new Option(label, value));
setEl.value = pieces;
if (startMode !== 'standard' && startMode !== 'random') startMode = 'standard';
buildSquares();
newGame();

// Debug handle for the console.
window.cs = {
  get tb() { return tb; }, get pos() { return pos; }, get status() { return status; },
  get history() { return history; }, legalTargets, blackReply, play, dtm,
};
