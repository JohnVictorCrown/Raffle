import { RifaOverlay } from "./ui/overlay";
import { AdminOverlay } from "./ui/admin";
import { MyRafflesOverlay } from "./ui/mepage";
import { WithdrawOverlay } from "./ui/withdraw";
import bgAudioUrl from "./assets/audio.opus";
import bgAudioMp3 from "./assets/audio.mp3";

const mount = document.getElementById("app")!;
mount.innerHTML = `
  <div class="app">
    <div id="ui" class="ui-slot"></div>
  </div>
`;

// Background audio, autoplaying when the browser allows it. We ship two
// encodings: WebM/Opus (Chrome, Android, desktop) and MP3 (iOS Safari, which
// cannot decode WebM at all). The browser picks the first source it supports.
const audio = document.createElement("audio");
audio.loop = true;
audio.volume = 0.4;
audio.preload = "auto";
for (const [src, type] of [
  [bgAudioUrl, "audio/webm; codecs=opus"],
  [bgAudioMp3, "audio/mpeg"],
] as const) {
  const s = document.createElement("source");
  s.src = src;
  s.type = type;
  audio.appendChild(s);
}
// Keep it attached (hidden) so the media pipeline can pick the supported
// source and so autoplay policies behave like a normal page element.
audio.style.display = "none";
document.body.appendChild(audio);

// Full gesture chain a tap can produce on mobile (touchstart -> touchend ->
// pointer events -> mouse events -> click) plus keydown for keyboards; the
// first one that fires wins and the rest are cleaned up.
const GESTURES = [
  "touchstart",
  "touchend",
  "pointerdown",
  "pointerup",
  "mousedown",
  "click",
  "keydown",
] as const;

// Unmute + play inside the user's first gesture. Listeners are attached
// IMMEDIATELY (not inside a play().catch): on iOS a blocked autoplay promise
// can stay pending forever instead of rejecting, which would otherwise mean
// the unlock never gets wired up and taps do nothing.
const unlock = () => {
  for (const ev of GESTURES) {
    window.removeEventListener(ev, unlock);
  }
  audio.muted = false;
  audio.play().catch(() => {});
};
for (const ev of GESTURES) {
  window.addEventListener(ev, unlock, { once: true, passive: true });
}

// Try autoplay with sound first (desktop / Android where it is permitted). If
// the browser blocks it, fall back to muted autoplay (always allowed) and let
// the first tap unmute + start playback above.
audio.play().then(() => {
  for (const ev of GESTURES) {
    window.removeEventListener(ev, unlock);
  }
}).catch(() => {
  audio.muted = true;
  audio.play().catch(() => {});
});

const uiSlot = document.getElementById("ui")!;
const path = window.location.pathname;
const params = new URLSearchParams(window.location.search);

if (path.startsWith("/withdraw")) {
  new WithdrawOverlay(uiSlot, params.get("token") ?? "").start();
} else if (path.startsWith("/me")) {
  new MyRafflesOverlay(uiSlot, params.get("code") ?? "", params.get("email") ?? "").start();
} else if (path.startsWith("/admin")) {
  const admin = new AdminOverlay(uiSlot);
  admin.start();
} else {
  new RifaOverlay(uiSlot);
}