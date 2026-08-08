// Background music via the Web Audio API — the pattern that actually works on
// mobile browsers:
//   * Desktop: AudioContext starts in the "running" state -> play immediately.
//   * Mobile:  starts "suspended" -> playback is unlocked by ctx.resume()
//              inside the first user gesture (tap / click / keydown).
// Decoded through fetch + decodeAudioData + AudioBufferSourceNode, so no
// <audio> autoplay policy is involved at all.
import bgAudioMp3 from "./assets/audio.mp3";

// Every .opus file under src/assets/ becomes a playlist entry (shuffled).
// Drop more files into src/assets/ to grow the rotation automatically.
const trackModules = import.meta.glob<string>("./assets/*.opus", {
  eager: true,
  query: "?url",
  import: "default",
});

// The MP3 copy is a decode fallback: some browsers (older iOS Safari) cannot
// decode WebM/Opus through decodeAudioData even though they could play MP3.
const fallbackSources: string[] = [bgAudioMp3];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const audioTracks = shuffle(Object.values(trackModules));

let ctx: AudioContext | null = null;
function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

// Decoded buffers are cached per URL so a looping playlist never re-fetches
// or re-decodes the same track.
const bufferCache = new Map<string, Promise<AudioBuffer>>();

let sourceRef: AudioBufferSourceNode | null = null;
let idxRef = 0;
let playingRef = false;
let startedRef = false; // true once any audio has actually started

function decode(url: string): Promise<AudioBuffer> {
  let p = bufferCache.get(url);
  if (!p) {
    p = (async () => {
      const resp = await fetch(url);
      const arrayBuffer = await resp.arrayBuffer();
      return getCtx().decodeAudioData(arrayBuffer);
    })();
    bufferCache.set(url, p);
  }
  return p;
}

async function playTrack(): Promise<void> {
  if (playingRef) return;
  playingRef = true;

  const url = audioTracks[idxRef];
  const context = getCtx();

  // Try the opus track first, then the mp3 fallback, then move on.
  let buffer: AudioBuffer | null = null;
  for (const candidate of url ? [url, ...fallbackSources] : fallbackSources) {
    try {
      buffer = await decode(candidate);
      if (buffer) break;
    } catch {
      // try the next source
    }
  }
  if (!buffer) {
    playingRef = false;
    return;
  }

  try {
    sourceRef?.stop();
  } catch {
    /* already stopped */
  }
  sourceRef?.disconnect();

  const source = context.createBufferSource();
  source.buffer = buffer;

  const gain = context.createGain();
  gain.gain.value = 0.4;

  source.connect(gain);
  gain.connect(context.destination);
  source.start(0);
  sourceRef = source;
  startedRef = true;
  playingRef = false;

  source.onended = () => {
    if (audioTracks.length > 1) {
      idxRef = (idxRef + 1) % audioTracks.length;
    }
    playTrack();
  };
}

const GESTURES = ["click", "keydown", "touchstart", "pointerdown", "mousedown"] as const;

function unlock(): void {
  for (const ev of GESTURES) {
    window.removeEventListener(ev, unlock);
  }
  // Desktop autoplay already has music going: nothing to do but clean up.
  if (startedRef) return;
  const c = getCtx();
  if (c.state === "suspended") {
    c.resume().then(() => playTrack()).catch(() => {});
  } else {
    playTrack();
  }
}

export function startBackgroundAudio(): void {
  // Desktop: AudioContext starts "running" -> play immediately.
  // Mobile: starts "suspended" -> wait for the first interaction.
  if (getCtx().state === "running") {
    playTrack();
  }
  for (const ev of GESTURES) {
    window.addEventListener(ev, unlock);
  }
}
