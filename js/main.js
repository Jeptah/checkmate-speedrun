import { squareName } from './chess.js';
import { ENDINGS } from './endings.js';

const GLYPH = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };

const $ = (id) => document.getElementById(id);
const boardEl = $('board'), squaresEl = $('squares'), piecesEl = $('pieces');
const overlayEl = $('overlay'), statusEl = $('status'), moveListEl = $('movelist');
const timeEl = $('time'), movesEl = $('moves'), bestEl = $('best');
const setEl = $('set'), startEl = $('start');

let ending = ENDINGS.find((e) => e.key === load('set', 'BN')) ?? ENDINGS[0];
let startMode = load('start', 'standard');

// Game state. `pos` holds one square per man of the ending (-1 once captured).
let pos = [];
let status = 'loading';     // loading | ready | running | won | failed
let history = [];           // { white, black, loss, input: 'mouse' | 'key' }
let startPar = 0;
let t0 = 0, elapsed = 0;
let selected = -1, targets = [];
let lastMove = [];
let drag = null;
let pieceEls = [];
let hoverSquare = -1;       // square under the mouse, for keyboard moves

function load(key, fallback) {
  try { return localStorage.getItem('cs:' + key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem('cs:' + key, value); } catch { /* private mode */ }
}

const isWhiteMan = (i) => i >= 0 && ending.men[i].white && pos[i] >= 0;
const playable = () => status === 'ready' || status === 'running';

// ---------- game flow ----------

async function newGame() {
  const wanted = ending;
  status = 'loading';
  drag = null;
  const showProgress = (fraction) => {
    if (wanted !== ending) return;
    overlayEl.textContent = `Building tablebase… ${Math.round(fraction * 100)}% (first visit only)`;
    overlayEl.hidden = false;
  };
  await wanted.load(showProgress);
  if (wanted !== ending) return;   // user switched endings meanwhile
  overlayEl.hidden = true;
  renderStartOptions();

  pos = ending.start(startMode);
  startPar = ending.par(pos);
  history = [];
  elapsed = 0;
  selected = -1; targets = []; lastMove = [];
  status = 'ready';

  buildPieces();
  renderHighlights();
  renderStats();
  moveListEl.textContent = '';
  statusEl.className = '';
  statusEl.textContent = `${ending.goal} The clock starts on your first move.`;
  bestEl.parentElement.classList.remove('record');
  renderBest();
}

// `input` says how the move was entered, so runs can later be split by input method.
function play(man, to, animate, input = 'mouse') {
  if (status === 'ready') {
    status = 'running';
    t0 = performance.now();
    requestAnimationFrame(tick);
  }
  const before = ending.par(pos);
  const result = ending.play(pos, man, to);
  pos = result.pos;

  if (result.promoted >= 0) pieceEls[result.promoted].textContent = GLYPH.Q + '︎';
  for (const i of result.removed) pieceEls[i].remove();
  if (pos[man] >= 0) placePiece(man, animate);
  lastMove = [];
  if (result.blackMove) {
    const [blackMan, from, dest] = result.blackMove;
    lastMove = [from, dest];
    placePiece(blackMan, true);
  }

  const record = { white: result.white, black: result.black, loss: 0, input };
  history.push(record);
  selected = -1; targets = [];
  if (result.outcome) {
    if (result.outcome !== 'won') record.loss = Infinity;
    finish(result.outcome);
  } else {
    record.loss = ending.par(pos) - (before - 1);
  }
  renderHighlights();
  renderStats();
}

function finish(outcome) {
  elapsed = performance.now() - t0;
  const n = history.length;
  if (outcome === 'won') {
    status = 'won';
    const extra = n - startPar;
    statusEl.className = 'won';
    statusEl.innerHTML = `${ending.wonIn} <b>${n}</b> move${n === 1 ? '' : 's'}, <b>${seconds(elapsed)}s</b>. `
      + `Tablebase optimum: <b>${startPar}</b>`
      + (extra > 0 ? ` (+${extra}).` : ' — perfect.');
    const record = updateBest(elapsed, extra);
    if (record.time || record.extra) {
      const what = record.time && record.extra ? 'New best time and fewest extra moves'
        : record.time ? 'New best time' : 'Fewest extra moves yet';
      statusEl.innerHTML += `<span class="record">★ ${what}</span>`;
      bestEl.parentElement.classList.add('record');
    }
  } else {
    status = 'failed';
    statusEl.className = 'failed';
    statusEl.innerHTML = `${outcome} The optimum was <b>${startPar}</b> moves.`;
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
  pieceEls = ending.men.map((man) => {
    const el = document.createElement('div');
    el.className = 'piece ' + (man.white ? 'white' : 'black');
    el.textContent = GLYPH[man.type] + '︎';
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

function bestKey() { return `best:${ending.key}:${startMode}`; }
function readBest() {
  try { return JSON.parse(load(bestKey(), 'null')); } catch { return null; }
}
function renderBest() {
  const best = readBest();
  bestEl.textContent = best ? `${seconds(best.time)}s · +${best.extra}` : '–';
}
// Stores the run if it beats the best time or the fewest extra moves; says which.
function updateBest(time, extra) {
  const best = readBest();
  const record = { time: !best || time < best.time, extra: !best || extra < best.extra };
  save(bestKey(), JSON.stringify({
    time: record.time ? time : best.time,
    extra: record.extra ? extra : best.extra,
  }));
  renderBest();
  return record;
}

function renderStartOptions() {
  startEl.textContent = '';
  startEl.add(new Option(`Standard · ${ending.standardLabel()}`, 'standard'));
  startEl.add(new Option('Any position', 'random'));
  startEl.value = startMode;
}

// ---------- mouse and touch ----------
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
  targets = man >= 0 ? ending.targets(pos, man) : [];
}

// White men that can legally move to square `s`.
function moversTo(s) {
  const movers = [];
  for (let i = 0; i < pos.length; i++) {
    if (isWhiteMan(i) && ending.targets(pos, i).includes(s)) movers.push(i);
  }
  return movers;
}

boardEl.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  if (!playable() || drag) return;
  const s = squareAt(e);
  if (s < 0) return;

  // A selected piece capturing takes priority over selecting what stands there.
  if (selected >= 0 && targets.includes(s)) { play(selected, s, true); return; }
  const man = pos.indexOf(s);
  if (isWhiteMan(man)) {
    drag = { man, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, wasSelected: selected === man };
    select(man);
    boardEl.setPointerCapture(e.pointerId);
    renderHighlights();
    return;
  }
  if (selected >= 0) {
    select(-1);
    renderHighlights();
    return;
  }
  const movers = moversTo(s);
  if (movers.length === 1) play(movers[0], s, true);
});

boardEl.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') setHover(squareAt(e));
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
boardEl.addEventListener('pointerleave', () => setHover(-1));
boardEl.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- keyboard moves ----------
// Hover a square and press a piece key to move that piece there. Keep the key held
// and the piece moves again each time the mouse reaches another square it can go to.

const KEYS = {
  KeyW: ['P', 'push'], KeyQ: ['P', 'left'], KeyE: ['P', 'right'],
  KeyS: ['Q'], ShiftLeft: ['K'], ShiftRight: ['K'], Space: ['B'],
  KeyA: ['N', 'left'], KeyD: ['N', 'right'],
  Digit1: ['R', 'left'], Digit3: ['R', 'right'], Numpad1: ['R', 'left'], Numpad3: ['R', 'right'],
};

// Piece keys currently held down, most recent last. While one is held, every new
// square the mouse enters is tried as a move for that piece.
const held = [];

function setHover(s) {
  if (s === hoverSquare) return;
  if (hoverSquare >= 0) squareEl(hoverSquare).classList.remove('cursor');
  hoverSquare = s;
  if (s < 0) return;
  squareEl(s).classList.add('cursor');
  if (held.length) keyMove(...held[held.length - 1].key);
}

function release(code) {
  const i = held.findIndex((h) => h.code === code);
  if (i >= 0) held.splice(i, 1);
}

function keyMove(type, side) {
  if (!playable() || drag || hoverSquare < 0) return;
  const to = hoverSquare;
  const movers = moversTo(to).filter((i) => {
    if (ending.men[i].type !== type) return false;
    if (type !== 'P') return true;
    // Pawn: forward, or capturing towards the left / right.
    const shift = (to & 7) - (pos[i] & 7);
    return shift === (side === 'push' ? 0 : side === 'left' ? -1 : 1);
  });
  if (!movers.length) return;
  // Two of a kind that can both get there: the key picks the left or right one.
  movers.sort((a, b) => (pos[a] & 7) - (pos[b] & 7) || pos[a] - pos[b]);
  const man = type !== 'P' && side === 'right' ? movers[movers.length - 1] : movers[0];
  play(man, to, true, 'key');
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = KEYS[e.code] ?? (e.key === 'Shift' ? KEYS.ShiftLeft : null);
  if (key) {
    e.preventDefault();
    if (e.repeat) return;
    release(e.code || e.key);
    held.push({ code: e.code || e.key, key });
    keyMove(key[0], key[1]);
    return;
  }
  if (e.repeat) return;
  if (e.code === 'Enter' || e.code === 'KeyR') {
    e.preventDefault();
    newGame();
  }
});

document.addEventListener('keyup', (e) => release(e.code || e.key));
window.addEventListener('blur', () => { held.length = 0; });

// ---------- board size ----------
// Drag the bottom-right corner; unavailable during a run so it can't be hit by accident.

const MIN_BOARD = 280, MAX_BOARD = 1400;
const resizeEl = $('resize');
let resizing = null;

// The stylesheet caps this at the largest board that fits without scrolling.
function applyBoardSize(px) {
  const root = document.documentElement.style;
  if (px) root.setProperty('--user-size', `${px}px`);
  else root.removeProperty('--user-size');
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
  applyBoardSize(Math.round(Math.max(MIN_BOARD, Math.min(MAX_BOARD, size))));
  resizing.changed = true;
});
const endResize = (e) => {
  if (!resizing || e.pointerId !== resizing.id) return;
  if (resizing.changed) {
    // Keep what was actually reached, not how far the pointer overshot.
    const reached = Math.round(boardEl.getBoundingClientRect().width);
    applyBoardSize(reached);
    save('size', reached);
  }
  resizing = null;
};
resizeEl.addEventListener('pointerup', endResize);
resizeEl.addEventListener('pointercancel', endResize);
resizeEl.addEventListener('dblclick', () => {
  if (status === 'running') return;
  applyBoardSize(0);
  save('size', 0);
});

// ---------- options ----------

$('new').addEventListener('click', (e) => { e.currentTarget.blur(); newGame(); });

setEl.addEventListener('change', () => {
  ending = ENDINGS.find((x) => x.key === setEl.value);
  save('set', ending.key); setEl.blur(); newGame();
});
startEl.addEventListener('change', () => {
  startMode = startEl.value; save('start', startMode); startEl.blur(); newGame();
});

// ---------- boot ----------

for (const e of ENDINGS) {
  let group = [...setEl.children].find((g) => g.label === e.group);
  if (!group) {
    group = document.createElement('optgroup');
    group.label = e.group;
    setEl.append(group);
  }
  group.append(new Option(e.label, e.key));
}
setEl.value = ending.key;
if (startMode !== 'standard' && startMode !== 'random') startMode = 'standard';
buildSquares();
newGame();

// Debug handle for the console.
window.cs = {
  get ending() { return ending; }, get pos() { return pos; }, get status() { return status; },
  get history() { return history; }, get hover() { return hoverSquare; }, play, squareName,
};
