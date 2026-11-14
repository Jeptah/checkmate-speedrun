// Rules and tablebase for K + R + pawn-on-the-7th vs K + R (Lucena-type positions).
//
// A full distance-to-mate table for this material is far too big for a browser, so
// the game is cut off at the first capture or promotion ("conversion"). That event
// is judged on the spot:
//   - White queens and the queen cannot be taken for free            -> win
//   - White wins Black's rook and keeps a won position               -> win
//   - Black takes the pawn or rook but White wins the rook back, or
//     is left with a winning K+P vs K                                -> win
//   - anything else (pawn or rook lost, stalemate)                   -> no win
// The table stores, for White to move, the number of plies until a winning
// conversion with best play from both sides, or UNKNOWN.
//
// The pawn never moves before the game ends, so a position is just
// [white king, white rook, black king, black rook] (base 64).

import { KING_MOVES, RAYS } from './chess.js';

export const UNKNOWN = 255;
const ESCAPES = 200;            // move-counter marker: Black has a saving capture
const ROOK_RAYS = RAYS.R;

// ---------- geometry ----------

const ADJ = new Uint8Array(4096);     // king-adjacent squares
const LINE = new Uint8Array(4096);    // 1 = same rank/file, 2 = same diagonal
const BLO = new Int32Array(4096);     // squares strictly between, low/high 32 bits
const BHI = new Int32Array(4096);
const BIT_LO = new Int32Array(64), BIT_HI = new Int32Array(64);
for (let s = 0; s < 64; s++) {
  if (s < 32) BIT_LO[s] = 1 << s; else BIT_HI[s] = 1 << (s - 32);
}
for (let a = 0; a < 64; a++) {
  for (let b = 0; b < 64; b++) {
    if (a === b) continue;
    const df = (b & 7) - (a & 7), dr = (b >> 3) - (a >> 3);
    if (Math.abs(df) <= 1 && Math.abs(dr) <= 1) ADJ[a * 64 + b] = 1;
    const straight = df === 0 || dr === 0;
    if (!straight && Math.abs(df) !== Math.abs(dr)) continue;
    LINE[a * 64 + b] = straight ? 1 : 2;
    const sf = Math.sign(df), sr = Math.sign(dr);
    for (let f = (a & 7) + sf, r = (a >> 3) + sr; r * 8 + f !== b; f += sf, r += sr) {
      BLO[a * 64 + b] |= BIT_LO[r * 8 + f];
      BHI[a * 64 + b] |= BIT_HI[r * 8 + f];
    }
  }
}

const rookSees = (a, b, lo, hi) => {
  const i = a * 64 + b;
  return LINE[i] === 1 && (BLO[i] & lo) === 0 && (BHI[i] & hi) === 0;
};
const queenSees = (a, b, lo, hi) => {
  const i = a * 64 + b;
  return LINE[i] !== 0 && (BLO[i] & lo) === 0 && (BHI[i] & hi) === 0;
};

class IntList {
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

// Moves are packed as: man | to << 4 | kind << 12.
//   White men: 0 king, 1 rook, 2 pawn.  Kinds: 0 quiet, 1 takes rook, 2 queens, 3 takes rook and queens.
//   Black men: 0 king, 1 rook.          Kinds: 0 quiet, 1 takes rook, 2 takes pawn.
export const moveMan = (m) => m & 15;
export const moveTo = (m) => (m >> 4) & 63;
export const moveKind = (m) => m >> 12;

export function createLucena(file) {
  const P = 48 + file, Q8 = 56 + file;
  const PA = file > 0 ? P + 7 : -1, PB = file < 7 ? P + 9 : -1;   // squares the pawn attacks
  const P_LO = BIT_LO[P], P_HI = BIT_HI[P];

  // ---------- move generation (all five men on the board) ----------

  function whiteMoves(wk, wr, bk, br, out) {
    let n = 0;
    const lo = BIT_LO[wk] | BIT_LO[wr] | BIT_LO[bk] | BIT_LO[br] | P_LO;
    const hi = BIT_HI[wk] | BIT_HI[wr] | BIT_HI[bk] | BIT_HI[br] | P_HI;

    const klo = lo & ~BIT_LO[wk], khi = hi & ~BIT_HI[wk];
    const km = KING_MOVES[wk];
    for (let j = 0; j < km.length; j++) {
      const t = km[j];
      if (t === wr || t === P || ADJ[bk * 64 + t]) continue;
      if (t === br) { out[n++] = (t << 4) | (1 << 12); continue; }
      if (rookSees(br, t, klo, khi)) continue;
      out[n++] = t << 4;
    }

    // Only when the black rook is lined up with the king can other moves be illegal.
    const exposed = LINE[br * 64 + wk] === 1;
    const rlo = lo & ~BIT_LO[wr], rhi = hi & ~BIT_HI[wr];
    const rays = ROOK_RAYS[wr];
    for (let r = 0; r < rays.length; r++) {
      const ray = rays[r];
      for (let j = 0; j < ray.length; j++) {
        const t = ray[j];
        if (t === br) { out[n++] = 1 | (t << 4) | (1 << 12); break; }
        if ((BIT_LO[t] & lo) || (BIT_HI[t] & hi)) break;
        if (exposed && rookSees(br, wk, rlo | BIT_LO[t], rhi | BIT_HI[t])) continue;
        out[n++] = 1 | (t << 4);
      }
    }

    if (!((BIT_LO[Q8] & lo) || (BIT_HI[Q8] & hi))) {
      const plo = (lo & ~P_LO) | BIT_LO[Q8], phi = (hi & ~P_HI) | BIT_HI[Q8];
      if (!(exposed && rookSees(br, wk, plo, phi))) out[n++] = 2 | (Q8 << 4) | (2 << 12);
    }
    if (br === PA || br === PB) out[n++] = 2 | (br << 4) | (3 << 12);
    return n;
  }

  function blackMoves(wk, wr, bk, br, out) {
    let n = 0;
    const lo = BIT_LO[wk] | BIT_LO[wr] | BIT_LO[bk] | BIT_LO[br] | P_LO;
    const hi = BIT_HI[wk] | BIT_HI[wr] | BIT_HI[bk] | BIT_HI[br] | P_HI;

    const klo = lo & ~BIT_LO[bk], khi = hi & ~BIT_HI[bk];
    const km = KING_MOVES[bk];
    for (let j = 0; j < km.length; j++) {
      const t = km[j];
      if (t === br || ADJ[wk * 64 + t]) continue;
      if (t === wr) { if (t !== PA && t !== PB) out[n++] = (t << 4) | (1 << 12); continue; }
      if (t === P) { if (!rookSees(wr, t, klo, khi)) out[n++] = (t << 4) | (2 << 12); continue; }
      if (t === PA || t === PB || rookSees(wr, t, klo, khi)) continue;
      out[n++] = t << 4;
    }

    const pawnCheck = bk === PA || bk === PB;
    const exposed = LINE[wr * 64 + bk] === 1;
    const rlo = lo & ~BIT_LO[br], rhi = hi & ~BIT_HI[br];
    const rays = ROOK_RAYS[br];
    for (let r = 0; r < rays.length; r++) {
      const ray = rays[r];
      for (let j = 0; j < ray.length; j++) {
        const t = ray[j];
        if (t === wr) { if (!pawnCheck) out[n++] = 1 | (t << 4) | (1 << 12); break; }
        if (t === P) {
          if (!(exposed && rookSees(wr, bk, rlo, rhi))) out[n++] = 1 | (t << 4) | (2 << 12);
          break;
        }
        if ((BIT_LO[t] & lo) || (BIT_HI[t] & hi)) break;
        if (pawnCheck) continue;
        if (exposed && rookSees(wr, bk, rlo | BIT_LO[t], rhi | BIT_HI[t])) continue;
        out[n++] = 1 | (t << 4);
      }
    }
    return n;
  }

  function blackInCheck(wk, wr, bk, br) {
    if (bk === PA || bk === PB) return true;
    const lo = BIT_LO[wk] | BIT_LO[br] | P_LO, hi = BIT_HI[wk] | BIT_HI[br] | P_HI;
    return rookSees(wr, bk, lo, hi);
  }

  // ---------- judging a conversion ----------

  // Lone black king to move against K + Q (+ R); no pawn left. True if stalemate.
  function stalemated(wk, wr, q, bk) {
    let lo = BIT_LO[wk] | BIT_LO[q], hi = BIT_HI[wk] | BIT_HI[q];
    if (wr >= 0) { lo |= BIT_LO[wr]; hi |= BIT_HI[wr]; }
    const attacked = (t) => ADJ[wk * 64 + t]
      || (wr >= 0 && wr !== t && rookSees(wr, t, lo, hi))
      || (q !== t && queenSees(q, t, lo, hi));
    const km = KING_MOVES[bk];
    for (let j = 0; j < km.length; j++) if (!attacked(km[j])) return false;
    return !attacked(bk);
  }

  // K + P vs K, pawn on the 7th: can White queen safely? Indexed [wk * 64 + bk].
  const pawnWinW = new Uint8Array(4096);   // White to move
  const pawnWinB = new Uint8Array(4096);   // Black to move
  {
    const queenHangs = (wk, bk) => ADJ[bk * 64 + Q8] && !ADJ[wk * 64 + Q8];
    const winsForWhite = (wk, bk) => {
      if (bk === PA || bk === PB) return false;       // illegal: Black already in check
      if (wk !== Q8 && bk !== Q8 && !queenHangs(wk, bk) && !stalemated(wk, -1, Q8, bk)) return true;
      for (const t of KING_MOVES[wk]) {
        if (t !== P && t !== bk && !ADJ[bk * 64 + t] && pawnWinB[t * 64 + bk]) return true;
      }
      return false;
    };
    const lostForBlack = (wk, bk) => {
      let any = false;
      for (const t of KING_MOVES[bk]) {
        if (ADJ[wk * 64 + t]) continue;
        if (t === P) return false;                     // takes the pawn
        if (t === PA || t === PB) continue;
        any = true;
        if (!pawnWinW[wk * 64 + t]) return false;
      }
      return any || bk === PA || bk === PB;            // no moves: mate or stalemate
    };
    for (let changed = true; changed;) {
      changed = false;
      for (let wk = 0; wk < 64; wk++) {
        for (let bk = 0; bk < 64; bk++) {
          if (wk === bk || wk === P || bk === P || ADJ[wk * 64 + bk]) continue;
          const i = wk * 64 + bk;
          if (!pawnWinW[i] && winsForWhite(wk, bk)) { pawnWinW[i] = 1; changed = true; }
          if (!pawnWinB[i] && lostForBlack(wk, bk)) { pawnWinB[i] = 1; changed = true; }
        }
      }
    }
  }

  // White has just taken the rook and still has K + R + P; lone king to move.
  function afterRookWon(wk, wr, bk) {
    const lo = BIT_LO[wk] | BIT_LO[wr] | P_LO, hi = BIT_HI[wk] | BIT_HI[wr] | P_HI;
    let any = false, takesRook = false;
    const km = KING_MOVES[bk];
    for (let j = 0; j < km.length; j++) {
      const t = km[j];
      if (ADJ[wk * 64 + t]) continue;
      if (t === wr) { if (t !== PA && t !== PB) any = takesRook = true; continue; }
      if (t === P) { if (!rookSees(wr, t, lo, hi)) any = true; continue; }
      if (t === PA || t === PB || rookSees(wr, t, lo, hi)) continue;
      any = true;
    }
    if (!any) return bk === PA || bk === PB || rookSees(wr, bk, lo, hi);   // mate, else stalemate
    return !takesRook || pawnWinW[wk * 64 + wr] === 1;
  }

  // White has just queened on Q8 by pushing; can Black take the queen for free?
  function promotionSafe(wk, wr, bk, br) {
    const lo = BIT_LO[wk] | BIT_LO[wr] | BIT_LO[bk] | BIT_LO[br] | BIT_LO[Q8];
    const hi = BIT_HI[wk] | BIT_HI[wr] | BIT_HI[bk] | BIT_HI[br] | BIT_HI[Q8];
    const kingGuards = ADJ[wk * 64 + Q8] === 1, kingNear = ADJ[bk * 64 + Q8] === 1;
    if (kingNear && !kingGuards && !rookSees(wr, Q8, lo & ~BIT_LO[bk], hi & ~BIT_HI[bk])) return false;
    if (rookSees(br, Q8, lo, hi)) {
      const lo2 = lo & ~BIT_LO[br], hi2 = hi & ~BIT_HI[br];
      if (!rookSees(wr, bk, lo2, hi2)) {               // the capture is legal
        const kingRetakes = kingGuards && !kingNear && !(ADJ[bk * 64 + wr] && !ADJ[Q8 * 64 + wr]);
        const rookRetakes = rookSees(wr, Q8, lo2, hi2) && !(kingNear && !kingGuards);
        if (!kingRetakes && !rookRetakes) return false;
      }
    }
    return true;
  }

  // Black has just taken the pawn (K + R vs K + R): can White win the rook straight back?
  function winsRookBack(wk, wr, bk, br) {
    const lo = BIT_LO[wk] | BIT_LO[wr] | BIT_LO[bk] | BIT_LO[br];
    const hi = BIT_HI[wk] | BIT_HI[wr] | BIT_HI[bk] | BIT_HI[br];
    if (ADJ[wk * 64 + br] && !ADJ[bk * 64 + br] && !(ADJ[bk * 64 + wr] && !ADJ[br * 64 + wr])) return true;
    return rookSees(wr, br, lo, hi) && !(ADJ[bk * 64 + br] && !ADJ[wk * 64 + br]);
  }

  // Black has just taken White's rook (K + P vs K + R), White to move.
  function afterRookLost(wk, bk, br) {
    if (ADJ[wk * 64 + br] && !ADJ[bk * 64 + br] && pawnWinB[br * 64 + bk]) return true;
    const queenHangs = (sq) => ADJ[bk * 64 + sq] && !ADJ[wk * 64 + sq];
    if (wk !== Q8 && bk !== Q8 && br !== Q8) {
      const lo = BIT_LO[wk] | BIT_LO[bk] | BIT_LO[br] | BIT_LO[Q8];
      const hi = BIT_HI[wk] | BIT_HI[bk] | BIT_HI[br] | BIT_HI[Q8];
      if (!rookSees(br, wk, lo, hi) && !rookSees(br, Q8, lo, hi) && !queenHangs(Q8)) return true;
    }
    return (br === PA || br === PB) && !queenHangs(br);
  }

  function whiteEventWins(wk, wr, bk, br, m) {
    const to = moveTo(m), kind = moveKind(m);
    if (kind === 1) return moveMan(m) === 0 ? afterRookWon(to, wr, bk) : afterRookWon(wk, to, bk);
    if (kind === 3) return !stalemated(wk, wr, to, bk);
    return promotionSafe(wk, wr, bk, br);
  }

  function blackEventWins(wk, wr, bk, br, m) {
    const to = moveTo(m);
    const bk2 = moveMan(m) === 0 ? to : bk, br2 = moveMan(m) === 1 ? to : br;
    return moveKind(m) === 2 ? winsRookBack(wk, wr, bk2, br2) : afterRookLost(wk, bk2, br2);
  }

  // ---------- tablebase ----------

  function generate(onProgress = () => {}) {
    const N = 1 << 24;
    const W = new Uint8Array(N).fill(UNKNOWN);
    const B = new Uint8Array(N).fill(UNKNOWN);
    const count = new Uint8Array(N);          // unresolved quiet moves per black-to-move position
    const moves = new Int32Array(64);
    const mates = new IntList(), seedW = new IntList(), seedB = new IntList();

    // Pass 1: judge every conversion, count Black's quiet moves, find the mates.
    for (let wk = 0; wk < 64; wk++) {
      onProgress(0.45 * wk / 64);
      if (wk === P) continue;
      for (let wr = 0; wr < 64; wr++) {
        if (wr === wk || wr === P) continue;
        for (let bk = 0; bk < 64; bk++) {
          if (bk === wk || bk === wr || bk === P || ADJ[wk * 64 + bk]) continue;
          const base = ((wk * 64 + wr) * 64 + bk) * 64;
          for (let br = 0; br < 64; br++) {
            if (br === wk || br === wr || br === bk || br === P) continue;
            const idx = base + br;
            const blackChecked = blackInCheck(wk, wr, bk, br);
            const whiteChecked = rookSees(br, wk, BIT_LO[wr] | BIT_LO[bk] | P_LO, BIT_HI[wr] | BIT_HI[bk] | P_HI);

            if (!blackChecked) {                // legal with White to move
              const n = whiteMoves(wk, wr, bk, br, moves);
              for (let j = 0; j < n; j++) {
                if (moves[j] >> 12 && whiteEventWins(wk, wr, bk, br, moves[j])) {
                  W[idx] = 1; seedW.push(idx); break;
                }
              }
            }
            if (!whiteChecked) {                // legal with Black to move
              const n = blackMoves(wk, wr, bk, br, moves);
              let quiet = 0, escapes = false;
              for (let j = 0; j < n && !escapes; j++) {
                if (!(moves[j] >> 12)) quiet++;
                else if (!blackEventWins(wk, wr, bk, br, moves[j])) escapes = true;
              }
              if (escapes) count[idx] = ESCAPES;
              else if (quiet) count[idx] = quiet;
              else if (n) { B[idx] = 1; seedB.push(idx); }       // only losing captures
              else if (blackChecked) { B[idx] = 0; mates.push(idx); }
            }
          }
        }
      }
    }

    // Pass 2: walk backwards one ply at a time through the quiet moves.
    let curB = mates, curW = new IntList();
    for (let ply = 0; ; ply++) {
      onProgress(Math.min(0.99, 0.45 + 0.55 * ply / 50));
      const nextW = ply === 0 ? seedW : new IntList();
      const nextB = ply === 0 ? seedB : new IntList();

      // White positions with a quiet move into a black position lost in `ply`.
      for (let k = 0; k < curB.length; k++) {
        const idx = curB.data[k];
        const br = idx & 63, bk = (idx >> 6) & 63, wr = (idx >> 12) & 63, wk = idx >>> 18;
        if (bk === PA || bk === PB) continue;   // pawn check: White cannot have just moved
        const lo = BIT_LO[wk] | BIT_LO[wr] | BIT_LO[bk] | BIT_LO[br] | P_LO;
        const hi = BIT_HI[wk] | BIT_HI[wr] | BIT_HI[bk] | BIT_HI[br] | P_HI;

        const klo = lo & ~BIT_LO[wk], khi = hi & ~BIT_HI[wk];
        const km = KING_MOVES[wk];
        for (let j = 0; j < km.length; j++) {
          const s = km[j];
          if ((BIT_LO[s] & lo) || (BIT_HI[s] & hi) || ADJ[bk * 64 + s]) continue;
          if (rookSees(wr, bk, klo | BIT_LO[s], khi | BIT_HI[s])) continue;   // Black was in check
          const p = idx + ((s - wk) << 18);
          if (W[p] === UNKNOWN) { W[p] = ply + 1; nextW.push(p); }
        }

        const rlo = lo & ~BIT_LO[wr], rhi = hi & ~BIT_HI[wr];
        const rays = ROOK_RAYS[wr];
        for (let r = 0; r < rays.length; r++) {
          const ray = rays[r];
          for (let j = 0; j < ray.length; j++) {
            const s = ray[j];
            if ((BIT_LO[s] & lo) || (BIT_HI[s] & hi)) break;
            if (rookSees(s, bk, rlo, rhi)) continue;
            const p = idx + ((s - wr) << 12);
            if (W[p] === UNKNOWN) { W[p] = ply + 1; nextW.push(p); }
          }
        }
      }

      // Black positions whose every move now loses.
      for (let k = 0; k < curW.length; k++) {
        const idx = curW.data[k];
        const br = idx & 63, bk = (idx >> 6) & 63, wr = (idx >> 12) & 63, wk = idx >>> 18;
        const lo = BIT_LO[wk] | BIT_LO[wr] | BIT_LO[bk] | BIT_LO[br] | P_LO;
        const hi = BIT_HI[wk] | BIT_HI[wr] | BIT_HI[bk] | BIT_HI[br] | P_HI;

        const klo = lo & ~BIT_LO[bk], khi = hi & ~BIT_HI[bk];
        const km = KING_MOVES[bk];
        for (let j = 0; j < km.length; j++) {
          const s = km[j];
          if ((BIT_LO[s] & lo) || (BIT_HI[s] & hi) || ADJ[wk * 64 + s]) continue;
          if (rookSees(br, wk, klo | BIT_LO[s], khi | BIT_HI[s])) continue;   // White was in check
          const p = idx + ((s - bk) << 6);
          if (--count[p] === 0) { B[p] = ply + 1; nextB.push(p); }
        }

        const rlo = lo & ~BIT_LO[br], rhi = hi & ~BIT_HI[br];
        const rays = ROOK_RAYS[br];
        for (let r = 0; r < rays.length; r++) {
          const ray = rays[r];
          for (let j = 0; j < ray.length; j++) {
            const s = ray[j];
            if ((BIT_LO[s] & lo) || (BIT_HI[s] & hi)) break;
            if (rookSees(s, wk, rlo, rhi)) continue;
            const p = idx + (s - br);
            if (--count[p] === 0) { B[p] = ply + 1; nextB.push(p); }
          }
        }
      }

      curB = nextB; curW = nextW;
      if (!curB.length && !curW.length) break;
    }

    // Histogram of win lengths in moves, over positions with the king in front of its pawn.
    const histogram = new Uint32Array(128);
    for (let i = Q8 << 18, end = (Q8 + 1) << 18; i < end; i++) {
      if (W[i] !== UNKNOWN) histogram[(W[i] + 1) >> 1]++;
    }
    return { table: W, histogram };
  }

  return { P, Q8, whiteMoves, blackMoves, blackInCheck, whiteEventWins, blackEventWins, generate };
}
