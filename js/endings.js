// The endings a player can run. Each one exposes the same small interface:
//
//   key, label, goal, wonIn        strings for the UI
//   men                            [{ type, white }] in board-array order
//   load(onProgress)               builds or fetches the tablebase
//   standardLabel()                text for the fixed-length start option
//   start(mode)                    random position: array of squares, one per man
//   par(pos)                       optimal number of moves to win (Infinity if not won)
//   targets(pos, man)              legal destination squares for a white man
//   play(pos, man, to)             plays White's move and Black's reply; returns
//       { pos, white, black, blackMove: [man, from, to] | null, removed: [man],
//         promoted: man | -1, outcome: null | 'won' | <reason the run failed> }
//
// A man that has been captured has square -1.

import { KING_MOVES, attacksFrom, kingsAdjacent, squareName } from './chess.js';
import { UNKNOWN, TRANSFORM, TRIANGLE_SQUARES, onDiagonal, tableIndex } from './tablebase.js';
import { createLucena, moveMan, moveTo, moveKind } from './lucena.js';

const rand = (n) => Math.floor(Math.random() * n);
const pick = (list) => list[rand(list.length)];

// ---------- tablebase storage ----------
// Built tables are kept in IndexedDB so only the first visit pays for generation.

const DB_NAME = 'checkmate-speedrun-tb3', DB_STORE = 'tables';
try {
  indexedDB.deleteDatabase('checkmate-speedrun');
  indexedDB.deleteDatabase('checkmate-speedrun-tb2');
} catch { /* no IndexedDB */ }

function db(mode, action) {
  return new Promise((resolve) => {
    let open;
    try { open = indexedDB.open(DB_NAME, 1); } catch { return resolve(null); }
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

async function loadTable(key, job, onProgress) {
  const cached = await db('readonly', (store) => store.get(key));
  if (cached?.table instanceof Uint8Array && cached.histogram) return cached;
  const built = await new Promise((resolve) => {
    const worker = new Worker(new URL('./tb-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.progress !== undefined) { onProgress(e.data.progress); return; }
      worker.terminate();
      resolve({ table: e.data.table, histogram: e.data.histogram });
    };
    onProgress(0);
    worker.postMessage(job);
  });
  db('readwrite', (store) => store.put(built, key));
  return built;
}

// ---------- K + pieces vs lone K: play to checkmate ----------

function mateEnding(pieces, label) {
  const types = ['K', ...pieces, 'k'];
  const k = types.length - 1;               // the black king's slot
  let table = null, standard = 0, loading = null;

  const value = (pos) => table[tableIndex(pos)];

  function occupancy(pos, skipBlackKing) {
    const occ = new Uint8Array(64);
    for (let i = 0; i < (skipBlackKing ? k : k + 1); i++) if (pos[i] >= 0) occ[pos[i]] = 1;
    return occ;
  }

  function whiteAttacks(pos) {
    const occ = occupancy(pos, true);
    const att = new Uint8Array(64);
    for (let i = 0; i < k; i++) {
      if (pos[i] < 0) continue;
      for (const t of attacksFrom(types[i], pos[i], occ)) att[t] = 1;
    }
    return att;
  }

  // Black plays the move that postpones mate the longest; takes a piece if it can.
  function blackReply(pos) {
    const bk = pos[k];
    const att = whiteAttacks(pos);
    let best = [], bestValue = -1;
    for (const d of KING_MOVES[bk]) {
      if (att[d]) continue;
      if (pos.indexOf(d) >= 0) return { to: d, capture: true, check: !!att[bk] };
      const next = pos.slice(); next[k] = d;
      const v = value(next);
      if (v > bestValue) { bestValue = v; best = [d]; } else if (v === bestValue) best.push(d);
    }
    if (!best.length) return { to: -1, mate: !!att[bk] };
    return { to: pick(best), check: !!att[bk] };
  }

  return {
    key: pieces,
    label,
    goal: 'Checkmate the king.',
    wonIn: 'Mate in',
    men: types.map((t) => ({ type: t === 'k' ? 'K' : t, white: t !== 'k' })),

    load(onProgress) {
      loading ??= loadTable(pieces, { kind: 'mate', pieces }, onProgress).then((entry) => {
        table = entry.table;
        // Standard start: the most common mate length, so every run has the same par.
        standard = 1;
        entry.histogram.forEach((n, d) => { if (n > entry.histogram[standard]) standard = d; });
      });
      return loading;
    },
    standardLabel: () => `mate in ${standard}`,

    // Uniform over real positions: pick a stored entry, then a random board symmetry.
    start(mode) {
      const want = mode === 'standard' ? standard * 2 - 1 : -1;
      for (;;) {
        let idx = rand(table.length);
        const v = table[idx];
        if (v === UNKNOWN || (want >= 0 ? v !== want : v < 5)) continue;
        const squares = [];
        for (let i = 1; i < types.length; i++) { squares.unshift(idx & 63); idx = Math.floor(idx / 64); }
        squares.unshift(TRIANGLE_SQUARES[idx]);
        // Diagonal-king positions are stored twice, so keep them half as often.
        if (onDiagonal(squares[0]) && Math.random() < 0.5) continue;
        const map = TRANSFORM[rand(8)];
        return squares.map((s) => map[s]);
      }
    },

    par(pos) {
      if (pos.includes(-1)) return Infinity;
      const v = value(pos);
      return v === UNKNOWN ? Infinity : (v + 1) >> 1;
    },

    targets(pos, man) {
      const occ = occupancy(pos, false);
      return attacksFrom(types[man], pos[man], occ).filter(
        (t) => !occ[t] && !(man === 0 && kingsAdjacent(t, pos[k])),
      );
    },

    play(pos, man, to) {
      const next = pos.slice();
      next[man] = to;
      const reply = blackReply(next);
      const out = {
        pos: next,
        white: types[man] + squareName(to) + (reply.mate ? '#' : reply.check ? '+' : ''),
        black: '', blackMove: null, removed: [], promoted: -1, outcome: null,
      };
      if (reply.to < 0) {
        out.outcome = reply.mate ? 'won' : 'Stalemate.';
        return out;
      }
      out.blackMove = [k, next[k], reply.to];
      out.black = 'K' + (reply.capture ? 'x' : '') + squareName(reply.to);
      if (reply.capture) {
        const victim = next.indexOf(reply.to);
        next[victim] = -1;
        out.removed.push(victim);
        out.outcome = 'Piece lost — draw.';
      }
      next[k] = reply.to;
      return out;
    },
  };
}

// ---------- Lucena: K + R + P vs K + R, play until the pawn is converted ----------
// Men: [white king, white rook, pawn, black king, black rook]. The table is built
// for a d-pawn; half the runs are mirrored to an e-pawn.

function lucenaEnding() {
  const FILE = 3;
  const rules = createLucena(FILE);
  const buffer = new Int32Array(64);
  let table = null, standard = 0, loading = null, mirror = false;

  const flip = (s) => (mirror && s >= 0 ? s ^ 7 : s);
  const index = (wk, wr, bk, br) => ((wk * 64 + wr) * 64 + bk) * 64 + br;
  const intact = (pos) => !pos.includes(-1) && flip(pos[2]) === rules.P;
  const listMoves = (generator, wk, wr, bk, br) =>
    Array.from(buffer.subarray(0, generator(wk, wr, bk, br, buffer)));

  return {
    key: 'lucena',
    label: 'Lucena (R + P vs R)',
    goal: 'Queen the pawn safely, or win the rook.',
    wonIn: 'Won in',
    men: [
      { type: 'K', white: true }, { type: 'R', white: true }, { type: 'P', white: true },
      { type: 'K', white: false }, { type: 'R', white: false },
    ],

    load(onProgress) {
      loading ??= loadTable('lucena-' + FILE, { kind: 'lucena', file: FILE }, onProgress).then((entry) => {
        table = entry.table;
        // Standard start: the longest win that still has plenty of positions.
        const h = entry.histogram;
        const most = Math.max(...h);
        standard = h.length - 1;
        while (standard > 1 && h[standard] < most / 20) standard--;
      });
      return loading;
    },
    standardLabel: () => `win in ${standard}`,

    // The king always starts on the queening square, in front of its pawn. Standard
    // starts also keep the defending king on its back two ranks, as in the textbook position.
    start(mode) {
      const wk = rules.Q8;
      for (;;) {
        const wr = rand(64), bk = rand(64), br = rand(64);
        const v = table[index(wk, wr, bk, br)];
        if (v === UNKNOWN) continue;
        const moves = (v + 1) >> 1;
        if (mode === 'standard' ? moves !== standard || bk < 48 : moves < 3) continue;
        mirror = Math.random() < 0.5;
        return [wk, wr, rules.P, bk, br].map(flip);
      }
    },

    par(pos) {
      if (!intact(pos)) return Infinity;
      const v = table[index(flip(pos[0]), flip(pos[1]), flip(pos[3]), flip(pos[4]))];
      return v === UNKNOWN ? Infinity : (v + 1) >> 1;
    },

    targets(pos, man) {
      if (!intact(pos)) return [];
      return listMoves(rules.whiteMoves, flip(pos[0]), flip(pos[1]), flip(pos[3]), flip(pos[4]))
        .filter((m) => moveMan(m) === man)
        .map((m) => flip(moveTo(m)));
    },

    play(pos, man, to) {
      const wk = flip(pos[0]), wr = flip(pos[1]), bk = flip(pos[3]), br = flip(pos[4]);
      const target = flip(to);
      const move = listMoves(rules.whiteMoves, wk, wr, bk, br)
        .find((m) => moveMan(m) === man && moveTo(m) === target);
      const kind = moveKind(move);
      const next = pos.slice();
      const out = { pos: next, white: '', black: '', blackMove: null, removed: [], promoted: -1, outcome: null };
      const takes = kind === 1 || kind === 3;
      out.white = man === 2
        ? (takes ? squareName(pos[2])[0] + 'x' : '') + squareName(to) + '=Q'
        : 'KR'[man] + (takes ? 'x' : '') + squareName(to);
      next[man] = to;
      if (takes) { next[4] = -1; out.removed.push(4); }
      if (man === 2) out.promoted = 2;

      // A capture or promotion ends the run and is judged on the spot.
      if (kind) {
        out.outcome = rules.whiteEventWins(wk, wr, bk, br, move) ? 'won'
          : kind === 2 ? 'The queen can be taken for free — no win.'
          : kind === 3 ? 'Stalemate.'
          : 'The rook falls or it is stalemate — no win.';
        return out;
      }

      const wk2 = man === 0 ? target : wk, wr2 = man === 1 ? target : wr;
      const check = rules.blackInCheck(wk2, wr2, bk, br);
      const replies = listMoves(rules.blackMoves, wk2, wr2, bk, br);
      if (!replies.length) {
        out.white += check ? '#' : '';
        out.outcome = check ? 'won' : 'Stalemate.';
        return out;
      }
      if (check) out.white += '+';

      // Black delays the conversion as long as possible; a saving capture beats everything.
      let best = [], bestValue = -1;
      for (const m of replies) {
        let v;
        if (moveKind(m)) v = rules.blackEventWins(wk2, wr2, bk, br, m) ? 0 : 1000;
        else if (moveMan(m) === 0) v = table[index(wk2, wr2, moveTo(m), br)];
        else v = table[index(wk2, wr2, bk, moveTo(m))];
        if (v > bestValue) { bestValue = v; best = [m]; } else if (v === bestValue) best.push(m);
      }
      const reply = pick(best);
      const slot = moveMan(reply) === 0 ? 3 : 4, dest = flip(moveTo(reply));
      out.blackMove = [slot, next[slot], dest];
      out.black = 'KR'[moveMan(reply)] + (moveKind(reply) ? 'x' : '') + squareName(dest);
      if (moveKind(reply)) {
        const victim = moveKind(reply) === 1 ? 1 : 2;
        next[victim] = -1;
        out.removed.push(victim);
        out.outcome = rules.blackEventWins(wk2, wr2, bk, br, reply) ? 'won'
          : victim === 1 ? 'Rook lost — no win.' : 'Pawn lost — draw.';
      }
      next[slot] = dest;
      return out;
    },
  };
}

export const ENDINGS = [
  mateEnding('BN', 'Bishop + Knight'),
  mateEnding('BB', 'Two Bishops'),
  mateEnding('R', 'Rook'),
  mateEnding('Q', 'Queen'),
  lucenaEnding(),
];
