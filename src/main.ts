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

const play = () => audio.play().catch(() => {});

audio.play().catch(() => {
  // Autoplay with sound is blocked until the user interacts (this happens on
  // production/https, while localhost is allowed). Start muted so autoplay is
  // permitted, then unmute + play on the first interaction. Touchstart covers
  // older iOS that does not fire pointerdown.
  audio.muted = true;
  audio.play().catch(() => {});
  const unlock = () => {
    audio.muted = false;
    play();
  };
  for (const ev of ["pointerdown", "touchstart", "mousedown", "keydown"] as const) {
    window.addEventListener(ev, unlock, { once: true });
  }
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