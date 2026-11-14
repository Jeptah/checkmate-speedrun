// Rules and tablebase for small endings that are played until they are "converted":
// K + Q vs K + piece, K + P vs K, K + Q / R vs K + P.
//
// The run ends at the first capture or promotion, judged on the spot:
//   - White takes Black's last man, or queens, and afterwards the lone king can
//     neither take a white man nor is stalemated                       -> win
//   - Black takes anything                                             -> no win
//   - Black's pawn queens                                              -> no win, unless
//     White can win the new queen at once in the same safe way
//   - checkmate                                                        -> win
// The table stores, for White to move, the number of plies until White wins this
// way with best play from both sides, or UNKNOWN.
//
// Known simplifications: Black only promotes to a queen, and a win that needs more
// than one move after Black queens is not counted.
//
// Men are listed white first, kings first on each side: [K, ..., k, ...]. There is
// at most one pawn. Mirror symmetry keeps the table small: with a pawn it is kept on
// files a-d, without one the white king is kept in the a1-d4 quarter. No position is
// its own mirror image, so every position is stored exactly once.

import { KING_MOVES, KNIGHT_MOVES, RAYS } from './chess.js';
import { IntList } from './tablebase.js';

export const UNKNOWN = 255;
const ESCAPES = 200;            // move-counter marker: Black has a saving capture or promotion

// Moves are packed as: man | to << 4 | kind << 12, kind bit 0 = capture, bit 1 = promotion.
export const manOf = (m) => m & 15;
export const toOf = (m) => (m >> 4) & 63;
export const kindOf = (m) => m >> 12;

const ADJ = new Uint8Array(4096);     // king-adjacent squares
const KN = new Uint8Array(4096);      // a knight's move apart
const LINE = new Uint8Array(4096);    // 1 = same rank/file, 2 = same diagonal
const STEP = new Int8Array(4096);     // square delta of one step from a towards b
for (let a = 0; a < 64; a++) {
  for (const b of KNIGHT_MOVES[a]) KN[a * 64 + b] = 1;
  for (let b = 0; b < 64; b++) {
    if (a === b) continue;
    const df = (b & 7) - (a & 7), dr = (b >> 3) - (a >> 3);
    if (Math.abs(df) <= 1 && Math.abs(dr) <= 1) ADJ[a * 64 + b] = 1;
    const straight = df === 0 || dr === 0;
    if (!straight && Math.abs(df) !== Math.abs(dr)) continue;
    LINE[a * 64 + b] = straight ? 1 : 2;
    STEP[a * 64 + b] = Math.sign(dr) * 8 + Math.sign(df);
  }
}

const KING = 0, QUEEN = 1, ROOK = 2, BISHOP = 3, KNIGHT = 4, PAWN = 5;
const RAYSET = [null, RAYS.Q, RAYS.R, RAYS.B];

// white, black: strings such as 'KQ' and 'KR'. pawnRanks limits where the pawn may
// stand (rank indices, 1 = second rank); a pawn that cannot move quietly needs one rank.
export function createGame(white, black, { pawnRanks = [1, 6] } = {}) {
  const types = [...white, ...black];
  const n = types.length, BK = white.length;
  const code = types.map((t) => 'KQRBNP'.indexOf(t));
  const pawn = types.indexOf('P');
  const key = pawn >= 0 ? pawn : 0;          // the man that mirroring is based on
  const pawnOK = (s) => s >= 0 && s < 64 && (s >> 3) >= pawnRanks[0] && (s >> 3) <= pawnRanks[1];

  const dom = types.map((t, i) => {
    const list = [];
    for (let s = 0; s < 64; s++) {
      const f = s & 7, r = s >> 3;
      if (i === pawn ? f < 4 && pawnOK(s) : pawn < 0 && i === 0 ? f < 4 && r < 4 : true) list.push(s);
    }
    return Uint8Array.from(list);
  });
  const digit = dom.map((list) => {
    const d = new Int16Array(64).fill(-1);
    list.forEach((s, k) => { d[s] = k; });
    return d;
  });
  const size = dom.reduce((a, list) => a * list.length, 1);

  // Scratch position: one square per man (-1 = captured) and the board the other way round.
  const sq = new Int8Array(n);
  const board = new Int8Array(64).fill(-1);
  let queened = false;                       // the pawn has just promoted
  const kind = (i) => (queened && i === pawn ? QUEEN : code[i]);

  function index() {
    const k = sq[key];
    const flip = ((k & 7) > 3 ? 7 : 0) | (pawn < 0 && (k >> 3) > 3 ? 56 : 0);
    let idx = 0;
    for (let i = 0; i < n; i++) idx = idx * dom[i].length + digit[i][sq[i] ^ flip];
    return idx;
  }
  function decode(idx) {
    for (let i = n - 1; i >= 0; i--) {
      const len = dom[i].length;
      sq[i] = dom[i][idx % len];
      idx = (idx / len) | 0;
    }
  }
  function load(squares) {
    for (let i = 0; i < n; i++) { sq[i] = squares[i]; if (sq[i] >= 0) board[sq[i]] = i; }
  }
  function unload() {
    for (let i = 0; i < n; i++) if (sq[i] >= 0) board[sq[i]] = -1;
    queened = false;
  }

  function attacks(i, t) {
    const s = sq[i], j = s * 64 + t, k = kind(i);
    if (k === KING) return ADJ[j] === 1;
    if (k === KNIGHT) return KN[j] === 1;
    if (k === PAWN) {
      const d = t - s;
      return ADJ[j] === 1 && (i < BK ? d === 7 || d === 9 : d === -7 || d === -9);
    }
    const line = LINE[j];
    if (line === 0 || (line === 1 && k === BISHOP) || (line === 2 && k === ROOK)) return false;
    const d = STEP[j];
    for (let x = s + d; x !== t; x += d) if (board[x] >= 0) return false;
    return true;
  }
  function attacked(t, byWhite, skip) {
    const a = byWhite ? 0 : BK, b = byWhite ? BK : n;
    for (let i = a; i < b; i++) if (i !== skip && sq[i] >= 0 && attacks(i, t)) return true;
    return false;
  }

  // Pseudo-legal moves of one side; kings are never captured.
  function gen(whiteSide, out) {
    let c = 0;
    const a = whiteSide ? 0 : BK, b = whiteSide ? BK : n;
    const enemyKing = sq[whiteSide ? BK : 0];
    const takeable = (t) => board[t] >= 0 && (board[t] < BK) !== whiteSide && t !== enemyKing;
    for (let i = a; i < b; i++) {
      const s = sq[i];
      if (s < 0) continue;
      const k = kind(i);
      if (k === PAWN) {
        const up = whiteSide ? 8 : -8, last = whiteSide ? 7 : 0, home = whiteSide ? 1 : 6;
        const f = s + up, promo = (f >> 3) === last ? 2 << 12 : 0;
        if (board[f] < 0) {
          out[c++] = i | (f << 4) | promo;
          if ((s >> 3) === home && board[f + up] < 0) out[c++] = i | ((f + up) << 4);
        }
        if ((s & 7) > 0 && takeable(f - 1)) out[c++] = i | ((f - 1) << 4) | promo | (1 << 12);
        if ((s & 7) < 7 && takeable(f + 1)) out[c++] = i | ((f + 1) << 4) | promo | (1 << 12);
      } else if (k === KING || k === KNIGHT) {
        const mv = k === KING ? KING_MOVES[s] : KNIGHT_MOVES[s];
        for (let j = 0; j < mv.length; j++) {
          const t = mv[j];
          if (board[t] < 0) out[c++] = i | (t << 4);
          else if (takeable(t)) out[c++] = i | (t << 4) | (1 << 12);
        }
      } else {
        const rays = RAYSET[k][s];
        for (let r = 0; r < rays.length; r++) {
          const ray = rays[r];
          for (let j = 0; j < ray.length; j++) {
            const t = ray[j];
            if (board[t] < 0) { out[c++] = i | (t << 4); continue; }
            if (takeable(t)) out[c++] = i | (t << 4) | (1 << 12);
            break;
          }
        }
      }
    }
    return c;
  }

  // Empty squares man i could have come from by a quiet move.
  function sources(i, out) {
    const s = sq[i], k = code[i];
    let c = 0;
    if (k === PAWN) {
      const back = i < BK ? -8 : 8, home = i < BK ? 1 : 6;
      const f = s + back, g = f + back;
      if (pawnOK(f) && board[f] < 0) {
        out[c++] = f;
        if (pawnOK(g) && (g >> 3) === home && board[g] < 0) out[c++] = g;
      }
    } else if (k === KING || k === KNIGHT) {
      const mv = k === KING ? KING_MOVES[s] : KNIGHT_MOVES[s];
      for (let j = 0; j < mv.length; j++) if (board[mv[j]] < 0) out[c++] = mv[j];
    } else {
      const rays = RAYSET[k][s];
      for (let r = 0; r < rays.length; r++) {
        const ray = rays[r];
        for (let j = 0; j < ray.length && board[ray[j]] < 0; j++) out[c++] = ray[j];
      }
    }
    return c;
  }

  function make(m) {
    const i = m & 15, t = (m >> 4) & 63, cap = board[t];
    if (cap >= 0) sq[cap] = -1;
    board[sq[i]] = -1;
    board[t] = i;
    sq[i] = t;
    if (m >> 13) queened = true;
    return cap;
  }
  function unmake(m, from, cap) {
    const i = m & 15, t = (m >> 4) & 63;
    board[t] = cap;
    if (cap >= 0) sq[cap] = t;
    board[from] = i;
    sq[i] = from;
    if (m >> 13) queened = false;
  }

  // White has just captured or queened. Won if Black is left with a bare king that
  // cannot take anything and is not stalemated.
  function bareKingLost() {
    for (let i = BK + 1; i < n; i++) if (sq[i] >= 0) return false;
    const bk = sq[BK];
    board[bk] = -1;
    let free = false, hanging = false;
    const mv = KING_MOVES[bk];
    for (let j = 0; j < mv.length && !hanging; j++) {
      const d = mv[j], o = board[d];
      if (o >= 0) hanging = !attacked(d, true, o);
      else if (!attacked(d, true, -1)) free = true;
    }
    board[bk] = BK;
    return !hanging && (free || attacked(bk, true, -1));
  }
  function eventWinsLoaded(m) {
    const from = sq[m & 15], cap = make(m);
    const won = !attacked(sq[0], false, -1) && bareKingLost();
    unmake(m, from, cap);
    return won;
  }

  // A legal black capture or promotion. Taking anything saves Black; queening saves
  // Black unless White can win the new queen on the spot.
  const retakes = new Int32Array(128);
  function eventSavesLoaded(m) {
    if ((m >> 12) & 1) return true;
    const from = sq[m & 15], cap = make(m), target = sq[m & 15];
    let saved = true;
    const c = gen(true, retakes);
    for (let j = 0; j < c && saved; j++) {
      if (((retakes[j] >> 4) & 63) === target && eventWinsLoaded(retakes[j])) saved = false;
    }
    unmake(m, from, cap);
    return saved;
  }

  // ---------- interface for playing ----------

  function legalMoves(squares, whiteSide) {
    load(squares);
    const buffer = new Int32Array(128), out = [];
    const c = gen(whiteSide, buffer);
    for (let j = 0; j < c; j++) {
      const m = buffer[j], from = sq[m & 15], cap = make(m);
      if (!attacked(sq[whiteSide ? 0 : BK], !whiteSide, -1)) out.push(m);
      unmake(m, from, cap);
    }
    unload();
    return out;
  }
  function eventWins(squares, m) {
    load(squares);
    const won = eventWinsLoaded(m);
    unload();
    return won;
  }
  function eventSaves(squares, m) {
    load(squares);
    const saved = eventSavesLoaded(m);
    unload();
    return saved;
  }
  function blackInCheck(squares) {
    load(squares);
    const check = attacked(sq[BK], true, -1);
    unload();
    return check;
  }
  function indexOf(squares) {
    for (let i = 0; i < n; i++) sq[i] = squares[i];
    return index();
  }
  function squaresOf(idx) {
    decode(idx);
    return Array.from(sq);
  }

  // ---------- tablebase ----------

  function generate(onProgress = () => {}) {
    const W = new Uint8Array(size).fill(UNKNOWN);
    const B = new Uint8Array(size).fill(UNKNOWN);
    const count = new Uint8Array(size);       // unresolved quiet moves per black-to-move position
    const validW = new Uint8Array(size);      // legal with White to move
    const moves = new Int32Array(128);
    const mates = new IntList(), seedW = new IntList(), seedB = new IntList();

    // Pass 1: judge every conversion, count Black's quiet moves, find the mates.
    for (let idx = 0; idx < size; idx++) {
      if ((idx & 0xffff) === 0) onProgress(0.6 * idx / size);
      decode(idx);
      let placed = 0;
      while (placed < n && board[sq[placed]] < 0) { board[sq[placed]] = placed; placed++; }
      if (placed === n && !ADJ[sq[0] * 64 + sq[BK]]) {
        const blackChecked = attacked(sq[BK], true, -1);
        const whiteChecked = attacked(sq[0], false, -1);
        if (!blackChecked) {
          validW[idx] = 1;
          const c = gen(true, moves);
          for (let j = 0; j < c; j++) {
            if (moves[j] >> 12 && eventWinsLoaded(moves[j])) { W[idx] = 1; seedW.push(idx); break; }
          }
        }
        if (!whiteChecked) {
          const c = gen(false, moves);
          let quiet = 0, losing = 0, escapes = false;
          for (let j = 0; j < c && !escapes; j++) {
            const m = moves[j], from = sq[m & 15], cap = make(m);
            const legal = !attacked(sq[BK], true, -1);
            unmake(m, from, cap);
            if (!legal) continue;
            if (!(m >> 12)) quiet++;
            else if (eventSavesLoaded(m)) escapes = true;
            else losing++;
          }
          if (escapes) count[idx] = ESCAPES;
          else if (quiet) count[idx] = quiet;
          else if (losing) { B[idx] = 1; seedB.push(idx); }     // must queen and lose the queen
          else if (blackChecked) { B[idx] = 0; mates.push(idx); }
        }
      }
      for (let i = 0; i < placed; i++) board[sq[i]] = -1;
    }

    // Pass 2: walk backwards one ply at a time through the quiet moves.
    const from = new Int32Array(32);
    let curB = mates, curW = new IntList();
    for (let ply = 0; ; ply++) {
      onProgress(1 - 0.4 * Math.exp(-ply / 15));
      const nextW = ply === 0 ? seedW : new IntList();
      const nextB = ply === 0 ? seedB : new IntList();

      // White positions with a quiet move into a black position lost in `ply`.
      for (let k = 0; k < curB.length; k++) {
        decode(curB.data[k]);
        for (let i = 0; i < n; i++) board[sq[i]] = i;
        for (let i = 0; i < BK; i++) {
          const s = sq[i], c = sources(i, from);
          for (let j = 0; j < c; j++) {
            sq[i] = from[j];
            const p = index();
            if (validW[p] && W[p] === UNKNOWN) { W[p] = ply + 1; nextW.push(p); }
          }
          sq[i] = s;
        }
        for (let i = 0; i < n; i++) board[sq[i]] = -1;
      }

      // Black positions whose every move now loses.
      for (let k = 0; k < curW.length; k++) {
        decode(curW.data[k]);
        for (let i = 0; i < n; i++) board[sq[i]] = i;
        for (let i = BK; i < n; i++) {
          const s = sq[i], c = sources(i, from);
          for (let j = 0; j < c; j++) {
            sq[i] = from[j];
            const p = index();
            if (count[p] > 0 && count[p] < ESCAPES && --count[p] === 0) { B[p] = ply + 1; nextB.push(p); }
          }
          sq[i] = s;
        }
        for (let i = 0; i < n; i++) board[sq[i]] = -1;
      }

      curB = nextB; curW = nextW;
      if (!curB.length && !curW.length) break;
    }

    const histogram = new Uint32Array(128);   // win lengths in moves
    for (let i = 0; i < size; i++) if (W[i] !== UNKNOWN) histogram[(W[i] + 1) >> 1]++;
    return { table: W, histogram };
  }

  return {
    types, BK, pawn, size,
    legalMoves, eventWins, eventSaves, blackInCheck, indexOf, squaresOf, generate,
  };
}
