// Distance-to-mate tablebase for K + pieces vs lone K, built by retrograde analysis.
//
// The board's 8 symmetries are used to keep the white king inside the a1-d1-d4
// triangle (10 squares), so a position is indexed as
//   [white king triangle index, piece 1, ..., piece n, black king]   (base 64).
// When the white king is on the a1-d4 diagonal a position and its diagonal mirror
// are both stored; the generator keeps the two in sync.
//
// The result table holds, for white to move, the number of plies to mate with best
// play from both sides (always odd), or UNKNOWN if white cannot force mate.
//
// Any capture by the black king is treated as a draw. That is exact for every ending
// where losing one piece leaves insufficient material (KQ, KR, KBB, KBN vs K).

import { KING_MOVES, KNIGHT_MOVES, RAYS } from './chess.js';

export const UNKNOWN = 255;
const ESCAPES = 200; // move-counter marker: black has a safe capture, never lost

// ---------- symmetry ----------

// TRANSFORM[t][s]: bit 0 mirrors files, bit 1 mirrors ranks, bit 2 then swaps file/rank.
export const TRANSFORM = [];
for (let t = 0; t < 8; t++) {
  const map = new Uint8Array(64);
  for (let s = 0; s < 64; s++) {
    let f = s & 7, r = s >> 3;
    if (t & 1) f = 7 - f;
    if (t & 2) r = 7 - r;
    if (t & 4) [f, r] = [r, f];
    map[s] = r * 8 + f;
  }
  TRANSFORM.push(map);
}
const SWAP = TRANSFORM[4];

const SYMMETRY = new Uint8Array(64);     // transform that brings a king square into the triangle
const TRIANGLE = new Int8Array(64).fill(-1);
export const TRIANGLE_SQUARES = [];
for (let s = 0; s < 64; s++) {
  let f = s & 7, r = s >> 3, t = 0;
  if (f > 3) { t |= 1; f = 7 - f; }
  if (r > 3) { t |= 2; r = 7 - r; }
  if (r > f) t |= 4;
  SYMMETRY[s] = t;
  if (t === 0) { TRIANGLE[s] = TRIANGLE_SQUARES.length; TRIANGLE_SQUARES.push(s); }
}
export const onDiagonal = (s) => (s & 7) === (s >> 3);

// Table index of a position given as [white king, ...pieces, black king].
export function tableIndex(squares) {
  const map = TRANSFORM[SYMMETRY[squares[0]]];
  let idx = TRIANGLE[map[squares[0]]];
  for (let i = 1; i < squares.length; i++) idx = idx * 64 + map[squares[i]];
  return idx;
}

// ---------- generation ----------

export class IntList {
  constructor() { this.data = new Int32Array(1 << 16); this.length = 0; }
  push(v) {
    if (this.length === this.data.length) {
      const bigger = new Int32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data[this.length++] = v;
  }
}

function maskTables(moves) {
  const lo = new Uint32Array(64), hi = new Uint32Array(64);
  for (let s = 0; s < 64; s++) {
    for (const t of moves[s]) {
      if (t < 32) lo[s] |= 1 << t; else hi[s] |= 1 << (t - 32);
    }
  }
  return [lo, hi];
}

export function generate(pieces) {
  const men = pieces.length + 1;            // white men, king first
  const perKing = 64 ** pieces.length;      // piece placements per white king square
  const NC = TRIANGLE_SQUARES.length * perKing;
  const W = new Uint8Array(NC * 64).fill(UNKNOWN);
  const B = new Uint8Array(NC * 64).fill(UNKNOWN);
  const count = new Uint8Array(NC * 64);    // unresolved black moves per black-to-move position
  const attLo = new Uint32Array(NC), attHi = new Uint32Array(NC);

  const [kLo, kHi] = maskTables(KING_MOVES);
  const [nLo, nHi] = maskTables(KNIGHT_MOVES);
  const types = ['K', ...pieces];
  const stride = types.map((_, i) => 64 ** (men - 1 - i));
  const sq = new Int32Array(men);
  const occ = new Uint8Array(64);
  const from = new Int32Array(32);

  const decode = (c) => {
    for (let i = men - 1; i > 0; i--) { sq[i] = c & 63; c >>>= 6; }
    sq[0] = TRIANGLE_SQUARES[c];
  };
  const attacked = (c, s) =>
    s < 32 ? (attLo[c] >>> s) & 1 : (attHi[c] >>> (s - 32)) & 1;
  const adjacent = (k, s) =>
    s < 32 ? (kLo[k] >>> s) & 1 : (kHi[k] >>> (s - 32)) & 1;

  let frontB = new IntList();
  let frontW = new IntList();
  const winFrom = (c, bk, ply) => {
    if (attacked(c, bk)) return;            // black would already be in check
    const p = c * 64 + bk;
    if (W[p] === UNKNOWN) { W[p] = ply; frontW.push(p); }
  };

  // Pass 1: white attack maps, black move counts, and the checkmates.
  for (let c = 0; c < NC; c++) {
    decode(c);
    let distinct = true;
    for (let i = 0; i < men; i++) {
      if (occ[sq[i]]) distinct = false;
      occ[sq[i]] = 1;
    }
    if (distinct) {
      let lo = kLo[sq[0]], hi = kHi[sq[0]];
      for (let i = 1; i < men; i++) {
        const s = sq[i];
        if (types[i] === 'N') { lo |= nLo[s]; hi |= nHi[s]; continue; }
        for (const ray of RAYS[types[i]][s]) {
          for (const t of ray) {
            if (t < 32) lo |= 1 << t; else hi |= 1 << (t - 32);
            if (occ[t]) break;
          }
        }
      }
      attLo[c] = lo; attHi[c] = hi;

      const wk = sq[0];
      for (let bk = 0; bk < 64; bk++) {
        if (occ[bk] || adjacent(wk, bk)) continue;
        let quiet = 0, capture = false;
        const mv = KING_MOVES[bk];
        for (let j = 0; j < mv.length; j++) {
          const d = mv[j];
          if (attacked(c, d)) continue;
          if (occ[d]) capture = true; else quiet++;
        }
        const idx = c * 64 + bk;
        if (capture) count[idx] = ESCAPES;
        else if (quiet) count[idx] = quiet;
        else if (attacked(c, bk)) { B[idx] = 0; frontB.push(idx); }
      }
    }
    for (let i = 0; i < men; i++) occ[sq[i]] = 0;
  }

  // Pass 2: walk backwards from the mates, one ply at a time.
  for (let ply = 0; frontB.length; ply += 2) {
    frontW = new IntList();

    // White positions that can move into a black-to-move position lost in `ply`.
    for (let k = 0; k < frontB.length; k++) {
      const idx = frontB.data[k];
      const c = idx >>> 6, bk = idx & 63;
      decode(c);
      for (let i = 0; i < men; i++) occ[sq[i]] = 1;
      occ[bk] = 1;

      // King: the square it came from may lie outside the triangle, so re-canonicalise.
      const kingFrom = KING_MOVES[sq[0]];
      for (let j = 0; j < kingFrom.length; j++) {
        const s0 = kingFrom[j];
        if (occ[s0] || adjacent(s0, bk)) continue;
        const map = TRANSFORM[SYMMETRY[s0]];
        const wk = map[s0];
        let c2 = TRIANGLE[wk];
        for (let i = 1; i < men; i++) c2 = c2 * 64 + map[sq[i]];
        winFrom(c2, map[bk], ply + 1);
        if (onDiagonal(wk)) {               // keep the diagonal mirror in sync
          let c3 = TRIANGLE[wk];
          for (let i = 1; i < men; i++) c3 = c3 * 64 + SWAP[map[sq[i]]];
          winFrom(c3, SWAP[map[bk]], ply + 1);
        }
      }

      // Other pieces: the king stays put, so the frame is unchanged.
      for (let i = 1; i < men; i++) {
        const s = sq[i], str = stride[i], base = c - s * str, type = types[i];
        let n = 0;
        if (type === 'N') {
          const mv = KNIGHT_MOVES[s];
          for (let j = 0; j < mv.length; j++) if (!occ[mv[j]]) from[n++] = mv[j];
        } else {
          const rays = RAYS[type][s];
          for (let r = 0; r < rays.length; r++) {
            const ray = rays[r];
            for (let j = 0; j < ray.length && !occ[ray[j]]; j++) from[n++] = ray[j];
          }
        }
        for (let j = 0; j < n; j++) winFrom(base + from[j] * str, bk, ply + 1);
      }

      for (let i = 0; i < men; i++) occ[sq[i]] = 0;
      occ[bk] = 0;
    }

    // Black positions whose every move now leads to a known white win.
    const next = new IntList();
    for (let k = 0; k < frontW.length; k++) {
      const idx = frontW.data[k];
      const c = idx >>> 6, bk = idx & 63;
      decode(c);
      for (let i = 0; i < men; i++) occ[sq[i]] = 1;
      const wk = sq[0];
      const mv = KING_MOVES[bk];
      for (let j = 0; j < mv.length; j++) {
        const d = mv[j];
        if (occ[d] || adjacent(wk, d)) continue;
        const b = c * 64 + d;
        if (--count[b] === 0) { B[b] = ply + 2; next.push(b); }
      }
      for (let i = 0; i < men; i++) occ[sq[i]] = 0;
    }
    frontB = next;
  }

  // Histogram of mate lengths in moves over all real won positions: each stored
  // entry stands for 8 positions, or 4 when the white king is on the diagonal.
  const histogram = new Uint32Array(128);
  const block = perKing * 64;
  for (let k = 0; k < TRIANGLE_SQUARES.length; k++) {
    const weight = onDiagonal(TRIANGLE_SQUARES[k]) ? 4 : 8;
    for (let i = k * block, end = i + block; i < end; i++) {
      if (W[i] !== UNKNOWN) histogram[(W[i] + 1) >> 1] += weight;
    }
  }
  return { table: W, histogram };
}
