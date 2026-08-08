import { store } from "../store";
import { t } from "../i18n";
import { createPixPayment, getPaymentStatus, getRaffle, type PublicRaffle } from "../api";
import lionImg from "../assets/lion.png";
import { buildFooter } from "./footer";

const POLL_MS = 3000;

export class RifaOverlay {
  // Minimum time the boot screen (lion + spinner + audio) stays visible so it
  // reads as an intentional startup sequence rather than a quick flash.
  private static readonly MIN_BOOT_MS = 1800;
  private root: HTMLElement;
  private selSet = new Set<number>();

  private raffle: PublicRaffle | null = null;
  private loading = true;
  private online: boolean | null = null;
  private connChip: HTMLElement | null = null;

  private lastKey = "";
  private built = false;
  private emailValue = "";
  private emailFocused = false;
  private nameValue = "";

  // live draw-date countdown (ticked in place, no page rebuild)
  private drawDeadline: number | null = null;
  private drawCountdown: HTMLElement | null = null;
  private countdownTimer: number | null = null;

  private pollTimer: number | null = null;
  private paymentPollTimer: number | null = null;
  private bootAt: number | null = null;
  private bootTimer: number | null = null;
  private paying = false;
  private paymentCanceled = false;
  private lastShownPlayed = "";

  constructor(private container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "ui";
    this.container.appendChild(this.root);

    store.subscribe(() => this.refresh());

    this.refresh();
    this.asyncLoop();
    this.build();
    // Live draw-date countdown: ticks in place without wiping the page.
    this.countdownTimer = window.setInterval(() => this.updateCountdown(), 1000);
  }

  private L() {
    return t(store.state.lang);
  }

  private el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  private wipe() {
    this.root.textContent = "";
    this.drawCountdown = null;
    this.drawDeadline = null;
  }

  private async refresh() {
    let r: PublicRaffle | null = null;
    try {
      r = await getRaffle(store.state.lang);
      this.online = true;
      this.loading = false; // leave the boot screen only once we connect
    } catch {
      r = null;
      this.online = false;
      // keep `loading` true so the boot spinner (lion + spinner + audio) stays
    }
    if (r) this.raffle = r;
    this.updateConn();
    // While a payment modal is open, never rebuild: a poll re-render would
    // wipe the modal (and closing it). The modal stays until closed manually.
    if (this.paying) return;
    // Only rebuild when the underlying raffle actually changed, so the poll
    // doesn't wipe the page (and the email input) while the user types.
    const current = r ?? this.raffle;
    const key = current
      ? `${store.state.lang}/${current.soldCount}/${current.available}/${current.drawing}/${current.winner ? current.winner.at : 0}`
      : "none";
    if (!this.built || key !== this.lastKey) {
      this.lastKey = key;
      this.build();
    }
  }

  private updateConn() {
    if (!this.connChip) return;
    const L = this.L();
    const spin = this.connChip.querySelector<HTMLElement>(".spinner");
    const label = this.connChip.querySelector<HTMLElement>(".conn-label");
    this.connChip.classList.toggle("off", this.online === false);
    this.connChip.classList.toggle("busy", this.online === null || this.online === false);
    if (spin) spin.style.display = this.online === true ? "none" : "";
    if (label) {
      label.textContent =
        this.online === false ? L.connOffline : this.online === null ? L.connConnecting : L.connOnline;
    }
  }

  private asyncLoop() {
    const tick = async () => {
      await this.refresh();
      this.pollTimer = window.setTimeout(tick, POLL_MS);
    };
    this.pollTimer = window.setTimeout(tick, POLL_MS);
  }

  private build() {
    this.wipe();
    this.built = true;
    const L = this.L();

    // Boot screen: show ONLY the lion + spinner (audio plays separately from
    // main.ts) until we connect to the backend — and for a minimum duration so
    // the boot is actually seen instead of flashing past.
    if (this.loading) {
      if (this.bootAt === null) this.bootAt = Date.now();
      this.buildBoot();
      return;
    }
    if (this.bootAt !== null) {
      const elapsed = Date.now() - this.bootAt;
      if (elapsed < RifaOverlay.MIN_BOOT_MS) {
        this.buildBoot();
        if (this.bootTimer === null) {
          const wait = RifaOverlay.MIN_BOOT_MS - elapsed;
          this.bootTimer = window.setTimeout(() => {
            this.bootTimer = null;
            this.build();
          }, wait);
        }
        return;
      }
      this.bootAt = null;
    }

    const strip = this.el("div", "strip");
    this.root.appendChild(strip);

    const topBar = this.el("div", "topbar");
    const langBtn = this.el("button", "lang-btn", (store.state.lang === "en" ? "pt" : "en").toUpperCase());
    langBtn.onclick = () => store.setLang(store.state.lang === "en" ? "pt" : "en");

    const supportBtn = document.createElement("a");
    supportBtn.className = "lang-btn support-btn";
    supportBtn.href = "https://www.stellarium.ddns-ip.net/contact";
    supportBtn.target = "_blank";
    supportBtn.rel = "noopener";
    supportBtn.title = L.supportTitle ?? "Support";
    supportBtn.setAttribute("aria-label", "Support chat");
    supportBtn.textContent = "💬";

    const titleGroup = this.el("div", "title-group");
    const brand = this.el("div", "brand", L.brand);
    const tagline = this.el("div", "tagline", L.tagline);
    titleGroup.appendChild(brand);
    titleGroup.appendChild(tagline);

    topBar.appendChild(titleGroup);

    const connChip = this.el("div", "conn");
    const spin = this.el("span", "spinner");
    const label = this.el("span", "conn-label", "");
    connChip.appendChild(spin);
    connChip.appendChild(label);
    this.connChip = connChip;
    topBar.appendChild(connChip);

    topBar.appendChild(langBtn);
    topBar.appendChild(supportBtn);
    this.root.appendChild(topBar);

    this.root.appendChild(buildFooter(L));

    this.updateConn();

    // show drawing state first if it's happening
    if ((this.raffle?.drawing || false) && !this.raffle?.winner) {
      this.showDrawingSoon();
      return;
    }

    if (!this.raffle) {
      const no = this.el("div", "panel setup center");
      no.appendChild(this.el("div", "panel-title", L.noRaffle));
      const hint = this.el("div", "no-raffle-hint", L.noRaffleHint);
      no.appendChild(hint);
      this.root.appendChild(no);
      return;
    }

    this.showRaffle();
  }

  private buildBoot() {
    const L = this.L();
    const boot = this.el("div", "boot");
    const img = this.el("img", "boot-lion");
    img.src = lionImg;
    img.alt = "";
    const spin = this.el("span", "spinner boot-spin");
    const label = this.el("div", "boot-label", L.connConnecting);
    boot.appendChild(img);
    boot.appendChild(spin);
    boot.appendChild(label);
    this.root.appendChild(boot);
  }

  private showRaffle() {
    const L = this.L();
    const raffle = this.raffle!;
    const sold = raffle.soldCount;
    const available = raffle.available;
    const raised = sold * raffle.price;

    // left column: raffle info card + live countdown below it
    const infoCol = this.el("div", "info-col");
    const info = this.el("div", "panel info");
    info.appendChild(this.el("div", "info-title", raffle.title));
    info.appendChild(this.el("div", "info-prize", `${L.prizeName}: ${raffle.prize}`));
    const mk = (name: string, val: string, cls: string) => {
      const row = this.el("div", "info-row");
      row.appendChild(this.el("span", "info-name", name));
      row.appendChild(this.el("span", `info-val ${cls}`, val));
      info.appendChild(row);
    };
    mk(L.availableName, `${available} ${L.freeNumbers}`, "text");
    mk(L.soldName, `${sold}/${raffle.ticketCount}`, "blue");
    // Prize at full sell-out = 70% of all tickets (mirrors server/money.ts).
    const totalPrize = Math.round(raffle.ticketCount * raffle.price * 0.7 * 100) / 100;
    mk(L.prizeAmountName, L.money(totalPrize, raffle.currency), "gold");
    mk(L.raisedName, L.money(raised, raffle.currency), "text");
    if (raffle.drawDate) {
      mk(
        L.drawDateLabel,
        new Date(raffle.drawDate).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }),
        "gold"
      );
    }
    infoCol.appendChild(info);

    if (raffle.drawDate) {
      // live countdown to the draw date, below the raffle card
      const cd = this.el("div", "draw-countdown");
      cd.appendChild(this.el("span", "cd-name", L.drawInLabel));
      const val = this.el("span", "cd-val", "");
      cd.appendChild(val);
      infoCol.appendChild(cd);
      this.drawDeadline = raffle.drawDate;
      this.drawCountdown = val;
    }
    this.updateCountdown();
    this.root.appendChild(infoCol);

    // number grid
    const gridArea = this.el("div", "panel grid-area");
    gridArea.appendChild(this.buildGrid());
    this.root.appendChild(gridArea);

    const img = this.el("img", "raffle-img");
    img.src = lionImg;
    img.alt = "";
    this.root.appendChild(img);

    if (raffle.winner) {
      this.handleWinner(raffle);
    }
  }

  /** Paint the remaining time to the draw date (called every second). */
  private updateCountdown() {
    const val = this.drawCountdown;
    if (!val || this.drawDeadline === null) return;
    const L = this.L();
    const diff = this.drawDeadline - Date.now();
    if (diff <= 0) {
      val.textContent = this.raffle?.winner ? "✓" : L.drawing;
      return;
    }
    const total = Math.floor(diff / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    val.textContent = `${d}d ${h}h ${m}m ${s}s`;
  }

  private buildGrid(): HTMLElement {
    const L = this.L();
    const raffle = this.raffle!;
    const soldSet: Record<number, true> = {};
    raffle.soldNumbers.forEach((n) => (soldSet[n] = true));

    const wrap = this.el("div", "grid");
    const header = this.el("div", "grid-head");
    header.appendChild(this.el("span", "grid-label", `${L.chooseLabel}:`));
    wrap.appendChild(header);

    const cells = this.el("div", "cells");
    for (let i = 0; i < raffle.ticketCount; i++) {
      const n = i + 1;
      const cell = this.el("button", "cell");
      cell.textContent = String(n).padStart(2, "0");
      const isSold = !!soldSet[n];
      const isSel = this.selSet.has(n);
      if (isSold) cell.classList.add("sold");
      else if (isSel) cell.classList.add("sel");
      else cell.classList.add("free");
      cell.disabled = isSold;
      cell.onclick = () => {
        if (isSold) return;
        if (this.selSet.has(n)) this.selSet.delete(n);
        else this.selSet.add(n);
        this.build();
      };
      cells.appendChild(cell);
    }
    wrap.appendChild(cells);

    // size the grid so all shares fill the panel with near-square cells
    requestAnimationFrame(() => {
      const cw = cells.clientWidth;
      const ch = cells.clientHeight;
      if (!cw || !ch) return;
      // On narrow screens cap the column count so cells stay readable
      // (mirrors the CSS minmax(44px, 1fr) fallback); desktop keeps the
      // original near-square sizing untouched.
      const maxCols = cw < 480 ? Math.floor(cw / 44) : raffle.ticketCount;
      const cols = Math.max(1, Math.min(raffle.ticketCount, Math.round(Math.sqrt((raffle.ticketCount * cw) / ch)), maxCols));
      // minmax(0, 1fr): plain `1fr` tracks refuse to shrink below the cell's
      // content width, overflowing narrow mobile containers.
      cells.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    });

    // buy bar — name, email + selected count
    const bar = this.el("div", "buybar");
    bar.appendChild(this.el("span", "buy-count", `${L.soldName}: ${this.selSet.size}`));

    const nameInput = this.el("input", "input buy-name");
    nameInput.placeholder = L.buyNamePh;
    nameInput.value = this.nameValue;
    nameInput.addEventListener("input", () => {
      this.nameValue = nameInput.value;
    });
    bar.appendChild(nameInput);

    const input = this.el("input", "input buy-name");
    input.placeholder = L.buyEmailPh;
    input.type = "email";
    input.value = this.emailValue;
    input.addEventListener("input", () => {
      this.emailValue = input.value;
    });
    bar.appendChild(input);
    if (this.emailFocused) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    input.addEventListener("focus", () => (this.emailFocused = true));
    input.addEventListener("blur", () => (this.emailFocused = false));

    const buyBtn = this.el("button", "btn btn-primary", L.buyBtn);
    buyBtn.disabled = this.selSet.size === 0;
    buyBtn.onclick = () => {
      const email = input.value.trim();
      const name = nameInput.value.trim();
      const numbers = Array.from(this.selSet).filter((n) => !soldSet[n]);
      if (!this.isEmail(email) || numbers.length === 0 || this.paying) return;
      this.openPaymentModal(email, numbers, name);
    };
    bar.appendChild(buyBtn);
    wrap.appendChild(bar);

    return wrap;
  }

  private isEmail(v: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  // manages auto "drawing / winner" triggers driven by polling
  private handleWinner(raffle: PublicRaffle) {
    if (raffle.winner) {
      const key = `${raffle.winner.number}-${raffle.winner.at}`;
      if (this.lastShownPlayed !== key) {
        this.lastShownPlayed = key;
      }
      this.showWinner(raffle.winner.number, raffle.winner.email);
      return;
    }
    if (raffle.drawing) {
      this.showDrawingSoon();
    }
  }

  private showDrawingSoon() {
    const L = this.L();
    const overlay = this.el("div", "modal");
    const card = this.el("div", "modal-card center");
    card.appendChild(this.el("div", "winner-label", "🎰"));
    card.appendChild(this.el("div", "drawing-text", L.drawing));
    card.appendChild(this.el("div", "winner-sub", L.drawingSoon));
    overlay.appendChild(card);
    this.root.appendChild(overlay);
  }

  private showWinner(number: number, email: string) {
    const L = this.L();
    const overlay = this.el("div", "modal");
    const card = this.el("div", "modal-card winner-card");
    const t1 = this.el("div", "winner-label", L.winnerLabel);
    const num = this.el("div", "winner-number", `#${String(number).padStart(2, "0")}`);
    const sub = this.el("div", "winner-sub", `${email} — ${L.wonNumber}`);
    const claim = this.el("a", "btn btn-link", L.winnerClaimLink);
    if (this.raffle?.claimPath) claim.href = this.raffle.claimPath;
    card.appendChild(t1);
    card.appendChild(num);
    card.appendChild(sub);
    card.appendChild(claim);
    overlay.appendChild(card);
    this.root.appendChild(overlay);
  }

  private openPaymentModal(email: string, numbers: number[], name?: string) {
    const L = this.L();
    const raffle = this.raffle!;
    const amount = numbers.length * raffle.price;
    this.selSet.clear();
    this.paying = false;
    this.paymentCanceled = false;

    const modal = this.el("div", "modal");
    const card = this.el("div", "modal-card");

    card.appendChild(this.el("div", "modal-head", `${L.payTitle} • ${raffle.title}`));
    card.appendChild(this.el("div", "modal-sub", `${L.chooseLabel}: #${numbers.join(", #")}`));
    card.appendChild(this.el("div", "modal-total", `${L.payTotal}: ${L.money(amount, raffle.currency)}`));

    const emailLine = this.el("div", "modal-status");
    emailLine.textContent = `📧 ${email}`;
    card.appendChild(emailLine);

    const statusEl = this.el("div", "modal-status");
    card.appendChild(statusEl);

    const resultBox = this.el("div", "modal-result");
    resultBox.style.display = "none";
    card.appendChild(resultBox);

    // Payment processed by Mercado Pago (PIX) directly inside this modal.
    const btnRow = this.el("div", "modal-btns");
    const closeBtn = this.el("button", "btn btn-draw", L.payClose);
    closeBtn.onclick = () => {
      this.paymentCanceled = true;
      this.closePay();
    };
    btnRow.appendChild(closeBtn);
    card.appendChild(btnRow);

    modal.appendChild(card);
    this.root.appendChild(modal);

    // Open the Mercado Pago payment (PIX) immediately.
    this.paying = true;
    this.buildPaymentStage(statusEl, resultBox, email, numbers, name);
  }

  private buildPaymentStage(
    statusEl: HTMLElement,
    resultBox: HTMLElement,
    email: string,
    numbers: number[],
    name?: string
  ) {
    const L = this.L();

    const doPoll = async (paymentId: string | number) => {
      if (this.paymentCanceled) return;
      const tick = async () => {
        if (this.paymentCanceled) return;
        try {
          const st = await getPaymentStatus(paymentId);
          if (st.status === "approved") {
            this.paying = false;
            this.showPaymentSuccess(statusEl, resultBox);
            return;
          }
          if (st.status === "rejected" || st.status === "cancelled") {
            this.paying = false;
            statusEl.textContent = L.payError;
            statusEl.classList.add("err");
            return;
          }
        } catch {
          // transient; keep polling
        }
        this.paymentPollTimer = window.setTimeout(tick, 2500);
      };
      tick();
    };

    statusEl.textContent = L.payWaiting;

    try {
      createPixPayment({ email, name, numbers })
        .then((payment) => {
          if (this.paymentCanceled) return;
          statusEl.textContent = L.payScan;
          statusEl.classList.add("blue");

          const qrImg = this.el("img", "qr");
          if (payment.qr_code_base64) qrImg.src = `data:image/png;base64,${payment.qr_code_base64}`;
          const code = this.el("input", "input qr-code");
          code.readOnly = true;
          code.value = payment.qr_code || "";
          const copyBtn = this.el("button", "btn btn-primary", L.payCopy);
          copyBtn.onclick = () => {
            if (code.value) {
              navigator.clipboard?.writeText(code.value);
              copyBtn.textContent = L.payCopied;
            }
          };

          resultBox.innerHTML = "";
          resultBox.style.display = "flex";
          const mp = this.el("div", "mp-brand", "Mercado Pago PIX");
          resultBox.appendChild(mp);
          resultBox.appendChild(qrImg);
          resultBox.appendChild(code);
          resultBox.appendChild(copyBtn);

          doPoll(payment.id);
        })
        .catch((err) => {
          if (this.paymentCanceled) return;
          this.paying = false;
          statusEl.textContent = err?.message ? String(err.message) : L.payError;
          statusEl.classList.add("err");
          console.error(err);
        });
    } catch (err: any) {
      this.paying = false;
      statusEl.textContent = err?.message ? String(err.message) : L.payError;
      statusEl.classList.add("err");
      console.error(err);
    }
  }

  private showPaymentSuccess(statusEl: HTMLElement, resultBox: HTMLElement) {
    const L = this.L();
    statusEl.textContent = "";
    resultBox.style.display = "flex";
    resultBox.innerHTML = "";
    const s = this.el("div", "success", `✓ ${L.paySuccess}`);
    const h = this.el("div", "success-hint", L.paySuccessHint);
    const okBtn = this.el("button", "btn btn-primary", L.payClose);
    okBtn.onclick = () => this.closePay();
    resultBox.appendChild(s);
    resultBox.appendChild(h);
    resultBox.appendChild(okBtn);
  }

  private closePay() {
    if (this.paymentPollTimer) {
      window.clearTimeout(this.paymentPollTimer);
      this.paymentPollTimer = null;
    }
    this.paying = false;
    this.build();
  }

  destroy() {
    if (this.pollTimer) window.clearTimeout(this.pollTimer);
    if (this.paymentPollTimer) window.clearTimeout(this.paymentPollTimer);
    if (this.bootTimer) window.clearTimeout(this.bootTimer);
    if (this.countdownTimer) window.clearInterval(this.countdownTimer);
    this.root.remove();
  }
}