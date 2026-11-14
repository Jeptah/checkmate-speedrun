import { generate } from './tablebase.js';
import { createLucena } from './lucena.js';
import { createGame } from './wintable.js';

// job: { kind: 'mate', pieces }, { kind: 'lucena', file } or { kind: 'win', white, black, options }
self.onmessage = (e) => {
  const job = e.data;
  const started = performance.now();
  let last = 0;
  const onProgress = (fraction) => {
    const now = performance.now();
    if (now - last > 100) { last = now; self.postMessage({ progress: fraction }); }
  };
  const { table, histogram } = job.kind === 'lucena' ? createLucena(job.file).generate(onProgress)
    : job.kind === 'win' ? createGame(job.white, job.black, job.options).generate(onProgress)
    : generate(job.pieces);
  self.postMessage(
    { table, histogram, ms: performance.now() - started },
    [table.buffer, histogram.buffer],
  );
};
