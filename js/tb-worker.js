import { generate } from './tablebase.js';

self.onmessage = (e) => {
  const pieces = e.data.pieces;
  const started = performance.now();
  const { table, histogram } = generate(pieces);
  self.postMessage(
    { pieces, table, histogram, ms: performance.now() - started },
    [table.buffer, histogram.buffer],
  );
};
