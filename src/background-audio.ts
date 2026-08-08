// Background music via a real <audio> element using the muted-autoplay trick
// (the pattern that actually works on mobile):
//   * Muted autoplay is ALWAYS permitted on mobile browsers (iOS/Android), so
//     playback starts immediately — no AudioContext "resume inside a tap"
//     dance and no "audio only starts after the first tap" gating.
//   * We begin muted and un-mute on the first user interaction (tap, click,
//     drag, scroll or key). If none arrives within 1s we un-mute anyway.
import bgAudioMp3 from "./assets/audio.mp3";

// Every .opus file under src/assets/ becomes a playlist entry (shuffled).
// Drop more files in to grow the rotation. The MP3 is the decode fallback for
// browsers that cannot play WebM/Opus.
const trackModules = import.meta.glob<string>("./assets/*.opus", {
  eager: true,
  query: "?url",
  import: "default",
});

const OPUS = shuffle(Object.values(trackModules));
const sources: string[] = OPUS.length ? [...OPUS, bgAudioMp3] : [bgAudioMp3];

let audio: HTMLAudioElement | null = null;
let idx = 0;
let muted = true;
let firstInteraction = true;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function playUrl(): void {
  if (!audio) return;
  audio.src = sources[idx % sources.length];
  audio.load();
  audio.play().catch(() => {});
}

function nextTrack(): void {
  idx = (idx + 1) % sources.length;
  playUrl();
}

// idx of the first source in the current failure streak (-1 = none). If every
// source fails in a row we give up instead of churning media-error events and
// network requests forever on a device that cannot play any of the formats.
let failureStart = -1;

function onSourceError(): void {
  if (failureStart === -1) failureStart = idx;
  idx = (idx + 1) % sources.length;
  if (idx === failureStart) {
    // Wrapped all the way back: nothing can play here — stop retrying.
    failureStart = -1;
    return;
  }
  playUrl();
}

// Everything that can count as a first user interaction. Drags are covered by
// the touch/move/up + pointer/mouse chain; scroll catches momentum scrolling
// that fires after the finger lifts. All are passive so they never block
// scrolling.
const GESTURES = [
  "click",
  "keydown",
  "touchstart",
  "touchmove",
  "touchend",
  "pointerdown",
  "pointermove",
  "pointerup",
  "mousedown",
  "wheel",
] as const;

function setMuted(next: boolean): void {
  muted = next;
  if (audio) audio.muted = next;
  updateButton();
}

function unlock(): void {
  for (const ev of GESTURES) {
    window.removeEventListener(ev, unlock);
  }
  // Scroll doesn't bubble, so it's captured on the document instead.
  document.removeEventListener("scroll", unlock, { capture: true });
  firstInteraction = false;
  if (audio?.muted) setMuted(false);
  else updateButton(); // already audible — just refresh the button state
}

/** Toggle mute state. Returns the new muted state. */
export function toggleAudio(): boolean {
  if (firstInteraction) unlock();
  else setMuted(!muted);
  return muted;
}

// ---------- floating mute/unmute toggle ----------

let btn: HTMLButtonElement | null = null;

function updateButton(): void {
  if (!btn) return;
  btn.textContent = muted ? "🔇" : "🔊";
  btn.classList.toggle("on", !muted);
  btn.classList.toggle("pulse", muted && firstInteraction);
}

function mountButton(): void {
  if (btn) return;
  btn = document.createElement("button");
  btn.type = "button";
  btn.className = "audio-btn pulse";
  btn.title = "Music / Música";
  btn.setAttribute("aria-label", "Toggle background music");
  btn.addEventListener("click", () => toggleAudio());
  updateButton();
  document.body.appendChild(btn);
}

export function startBackgroundAudio(): void {
  audio = new Audio();
  audio.preload = "auto";
  audio.volume = 0.5;
  audio.muted = true; // muted autoplay is permitted on every browser
  audio.addEventListener("ended", nextTrack);
  audio.addEventListener("error", onSourceError);

  // Start on a random track so repeat visits don't begin with the same song.
  idx = Math.floor(Math.random() * sources.length);
  playUrl();

  for (const ev of GESTURES) {
    window.addEventListener(ev, unlock, { passive: true });
  }
  document.addEventListener("scroll", unlock, { capture: true, passive: true });

  // No interaction within 1s? Un-mute anyway (mirrors the Svelte reference).
  window.setTimeout(() => {
    if (firstInteraction) unlock();
  }, 1000);

  mountButton();
}
