import { RifaOverlay } from "./ui/overlay";
import { AdminOverlay } from "./ui/admin";
import { MyRafflesOverlay } from "./ui/mepage";
import { WithdrawOverlay } from "./ui/withdraw";
import bgAudioUrl from "./assets/audio.opus";

const mount = document.getElementById("app")!;
mount.innerHTML = `
  <div class="app">
    <div id="ui" class="ui-slot"></div>
  </div>
`;

// Background audio, autoplaying when the browser allows it.
const audio = new Audio(bgAudioUrl);
audio.loop = true;
audio.volume = 0.4;
audio.preload = "auto";

const play = () => audio.play().catch(() => {});

audio.play().catch(() => {
  // Autoplay with sound is blocked until the user interacts (this happens on
  // production/https, while localhost is allowed). Start muted so autoplay is
  // permitted, then unmute + play on the first interaction.
  audio.muted = true;
  audio.play().catch(() => {});
  const unlock = () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
    audio.muted = false;
    play();
  };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
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