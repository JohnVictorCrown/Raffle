import { RifaOverlay } from "./ui/overlay";
import { AdminOverlay } from "./ui/admin";
import { MyRafflesOverlay } from "./ui/mepage";
import { WithdrawOverlay } from "./ui/withdraw";
import { startBackgroundAudio } from "./background-audio";

const mount = document.getElementById("app")!;
mount.innerHTML = `
  <div class="app">
    <div id="ui" class="ui-slot"></div>
  </div>
`;

// Background music via a real <audio muted autoplay> element (see
// background-audio.ts): playback starts muted — allowed on mobile — and
// unmutes on the first tap/click/drag/scroll or after 1s. Also mounts the
// floating mute toggle.
startBackgroundAudio();

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
