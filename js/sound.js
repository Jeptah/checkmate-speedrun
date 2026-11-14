// Sounds, synthesised with the Web Audio API: no audio files to load, so nothing
// can lag behind a move. Every sound is scheduled on the audio clock and never
// blocks the game.

//
// Moves, captures, wins and failed runs can instead use recordings from the sounds/
// folder (the "wood" set). Those are fetched at startup and decoded on the first user gesture;
// until they are ready, or if the browser cannot decode them, the synthesised
// sound plays instead.

let ctx = null, master = null, noise = null;
let enabled = true, recorded = true;

// Recordings per sound; one is picked at random each time. Sounds not listed here
// (new record) are always synthesised.
const FILES = {
  move: ['chess3.wav'],
  capture: ['footstep_concrete_001.ogg', 'footstep_concrete_002.ogg'],
  check: ['impactMetal_heavy_003.ogg'],
  checked: ['impactGlass_heavy_004.ogg'],
  win: ['win-bell4.wav'],
  fail: ['fail-sound1.wav'],
};
const EVENTS = ['move', 'capture', 'check', 'checked', 'win', 'record', 'fail'];

// Development aid: the local sound picker (sound-candidates/, not part of the site)
// saves a trial set in localStorage. If one is there, it replaces the list above.
let trial = null;
try { trial = JSON.parse(localStorage.getItem('cs:soundmap')); } catch { /* none */ }

const samples = Object.fromEntries(EVENTS.map((name) => [name, []]));   // decoded AudioBuffers
const downloads = [];                             // [name, Promise<ArrayBuffer | null>]
for (const name of EVENTS) {
  const picked = Array.isArray(trial?.[name]) ? trial[name] : null;
  const urls = picked
    ? picked.filter((path) => /^[\w-]+\/[\w-]+\.(ogg|wav|mp3)$/.test(path))
      .map((path) => new URL(`../sound-candidates/${path}`, import.meta.url))
    : (FILES[name] ?? []).map((file) => new URL(`../sounds/${file}`, import.meta.url));
  for (const url of urls) {
    downloads.push([name, fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null)]);
  }
}

// mode: 'wood' (recorded knocks), 'synth' (all generated) or 'off'.
export function setMode(mode) {
  enabled = mode !== 'off';
  recorded = mode === 'wood';
}

// Browsers only allow audio after a user gesture; call this from input handlers.
export function unlock() {
  if (!enabled) return;
  if (!ctx) {
    const AudioContext = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContext) { enabled = false; return; }
    ctx = new AudioContext({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    // One second of white noise, reused for every click.
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    for (const [name, download] of downloads) {
      download
        .then((bytes) => bytes && ctx.decodeAudioData(bytes))
        .then((buffer) => { if (buffer) samples[name].push(buffer); })
        .catch(() => { /* this browser cannot decode it; the synth stands in */ });
    }
  }
  if (ctx.state === 'suspended') ctx.resume();
}

// A gain node that jumps to `peak` and dies away over `duration` seconds.
function envelope(t, peak, duration, attack = 0.002) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  gain.connect(master);
  return gain;
}

function tone(t, from, to, duration, peak, type = 'sine') {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + duration);
  osc.connect(envelope(t, peak, duration));
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

function click(t, frequency, duration, peak, q = 1.5) {
  const source = ctx.createBufferSource();
  source.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = frequency;
  filter.Q.value = q;
  source.connect(filter).connect(envelope(t, peak, duration, 0.001));
  source.start(t, Math.random() * 0.5);
  source.stop(t + duration + 0.02);
}

const NOTE = { G4: 392, B4: 493.9, C5: 523.3, E5: 659.3, G5: 784, C6: 1046.5, E6: 1318.5, G6: 1568 };

const SOUNDS = {
  // A piece put down on wood: a short knock with a bright tick on top.
  move(t, pitch) {
    tone(t, 240 * pitch, 120 * pitch, 0.07, 0.7);
    click(t, 1900 * pitch, 0.03, 0.5);
  },
  // Heavier and sharper, with a second knock as the taken piece goes.
  capture(t, pitch) {
    tone(t, 190 * pitch, 80 * pitch, 0.1, 0.9);
    click(t, 2600 * pitch, 0.05, 0.8, 0.9);
    click(t + 0.045, 1400 * pitch, 0.04, 0.4);
  },
  check(t) {
    tone(t, 880, 880, 0.12, 0.16, 'triangle');
    tone(t, 1320, 1320, 0.1, 0.07, 'triangle');
  },
  // The defender checks us: the same idea, lower and a little uneasy.
  checked(t) {
    tone(t, 587, 587, 0.14, 0.16, 'triangle');
    tone(t, 831, 831, 0.12, 0.08, 'triangle');
  },
  win(t) {
    [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6].forEach((f, i) => {
      tone(t + i * 0.075, f, f, i === 3 ? 0.5 : 0.2, 0.22, 'triangle');
    });
  },
  record(t) {
    [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6, NOTE.E6, NOTE.G6].forEach((f, i) => {
      tone(t + i * 0.065, f, f, i === 5 ? 0.7 : 0.2, 0.2, 'triangle');
    });
    tone(t + 0.39, NOTE.C6, NOTE.C6, 0.7, 0.12, 'sine');
  },
  fail(t) {
    tone(t, NOTE.B4, NOTE.B4, 0.16, 0.2, 'triangle');
    tone(t + 0.15, NOTE.G4, 370, 0.35, 0.2, 'triangle');
  },
};

// name: move | capture | check | checked | win | record | fail. `delay` is in seconds;
// `pitch` scales the knock (the defender's pieces sound a little lower).
export function play(name, delay = 0, pitch = 1) {
  if (!enabled || !ctx) return;
  try {
    const t = ctx.currentTime + delay;
    const set = recorded ? samples[name] : null;
    if (set?.length) {
      const source = ctx.createBufferSource();
      source.buffer = set[Math.floor(Math.random() * set.length)];
      source.playbackRate.value = pitch;
      const gain = ctx.createGain();
      gain.gain.value = 1.6;
      source.connect(gain).connect(master);
      source.start(t);
    } else {
      SOUNDS[name](t, pitch);
    }
  } catch { /* audio is never essential */ }
}
