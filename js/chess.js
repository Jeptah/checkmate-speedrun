// Board geometry and attack generation for "K + pieces vs lone K" endings.
// Squares are 0..63, a1 = 0, h1 = 7, a8 = 56.

export const fileOf = (s) => s & 7;
export const rankOf = (s) => s >> 3;
export const squareName = (s) => 'abcdefgh'[s & 7] + ((s >> 3) + 1);

const STEP = {
  K: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]],
  N: [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]],
};
const SLIDE = {
  B: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  R: [[1, 0], [-1, 0], [0, 1], [0, -1]],
};
SLIDE.Q = [...SLIDE.B, ...SLIDE.R];

function stepTable(deltas) {
  const table = [];
  for (let s = 0; s < 64; s++) {
    const out = [];
    for (const [df, dr] of deltas) {
      const f = (s & 7) + df, r = (s >> 3) + dr;
      if (f >= 0 && f < 8 && r >= 0 && r < 8) out.push(r * 8 + f);
    }
    table.push(out);
  }
  return table;
}

function rayTable(deltas) {
  const table = [];
  for (let s = 0; s < 64; s++) {
    const rays = [];
    for (const [df, dr] of deltas) {
      const ray = [];
      let f = (s & 7) + df, r = (s >> 3) + dr;
      while (f >= 0 && f < 8 && r >= 0 && r < 8) {
        ray.push(r * 8 + f);
        f += df; r += dr;
      }
      if (ray.length) rays.push(ray);
    }
    table.push(rays);
  }
  return table;
}

export const KING_MOVES = stepTable(STEP.K);
export const KNIGHT_MOVES = stepTable(STEP.N);
export const RAYS = { B: rayTable(SLIDE.B), R: rayTable(SLIDE.R), Q: rayTable(SLIDE.Q) };

export function kingsAdjacent(a, b) {
  return Math.abs((a & 7) - (b & 7)) <= 1 && Math.abs((a >> 3) - (b >> 3)) <= 1;
}

// Squares a piece of `type` on `from` attacks. `occ` is a 64-entry array, truthy
// where a square is occupied. Sliders stop at (and include) the first blocker.
export function attacksFrom(type, from, occ) {
  if (type === 'K') return KING_MOVES[from];
  if (type === 'N') return KNIGHT_MOVES[from];
  const out = [];
  for (const ray of RAYS[type][from]) {
    for (const t of ray) {
      out.push(t);
      if (occ[t]) break;
    }
  }
  return out;
}
