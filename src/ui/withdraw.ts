import { getClaim, submitWithdraw } from "../api";
import { t } from "../i18n";
import { buildFooter } from "./footer";

export class WithdrawOverlay {
  private root: HTMLElement;

  constructor(private container: HTMLElement, private token: string) {
    this.root = document.createElement("div");
    this.root.className = "ui";
    this.container.appendChild(this.root);
  }

  private L() {
    return t(navigator.language.toLowerCase().startsWith("pt") ? "pt" : "en");
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

  async start() {
    const L = this.L();
    this.root.textContent = "";

    const strip = this.el("div", "strip");
    this.root.appendChild(strip);

    const topBar = this.el("div", "topbar");
    const titleGroup = this.el("div", "title-group");
    titleGroup.appendChild(this.el("div", "brand", L.wdTitle));
    const back = this.el("button", "lang-btn", L.meBack);
    back.onclick = () => (window.location.href = "/");
    topBar.appendChild(titleGroup);
    topBar.appendChild(back);
    this.root.appendChild(topBar);

    this.root.appendChild(buildFooter(L));

    const body = this.el("div", "admin-body");
    const card = this.el("div", "panel");

    try {
      const claim = await getClaim(this.token);
      if (claim.paid) {
        card.appendChild(this.el("div", "panel-title", L.wdTitle));
        card.appendChild(this.el("div", "me-result won", L.wdAlready));
      } else {
        card.appendChild(this.el("div", "panel-title", L.wdTitle));
        card.appendChild(this.el("div", "me-title", claim.raffleTitle));
        card.appendChild(this.el("div", "info-prize", `${L.wdPrize}: ${claim.prize}`));
        card.appendChild(this.el("div", "info-val gold", `${L.wdPayout}: ${claim.payout.toFixed(2)}`));
        card.appendChild(this.el("div", "no-raffle-hint", `${L.meNumbers}: #${String(claim.number).padStart(2, "0")}`));

        const typeSel = this.el("select", "input");
        for (const v of ["email", "cpf", "phone", "random"]) {
          const opt = this.el("option");
          opt.value = v;
          opt.textContent = v.toUpperCase();
          typeSel.appendChild(opt);
        }
        card.appendChild(this.el("div", "field-label", L.wdKeyType));
        card.appendChild(typeSel);

        const keyInput = this.el("input", "input");
        keyInput.placeholder = L.wdKeyPh;
        card.appendChild(keyInput);

        const msg = this.el("div", "modal-status");
        card.appendChild(msg);

        const btn = this.el("button", "btn btn-primary", L.wdBtn);
        btn.onclick = async () => {
          const key = keyInput.value.trim();
          if (!key) return;
          btn.disabled = true;
          msg.textContent = L.payWaiting;
          try {
            const res = await submitWithdraw({ token: this.token, pixKey: key, pixKeyType: typeSel.value as any });
            if (res.ok) {
              msg.textContent = L.wdDone;
              msg.classList.add("blue");
            } else {
              msg.textContent = res.error ?? L.wdError;
              msg.classList.add("err");
              btn.disabled = false;
            }
          } catch (err: any) {
            msg.textContent = err?.message ?? L.payError;
            msg.classList.add("err");
            btn.disabled = false;
          }
        };
        card.appendChild(btn);
      }
    } catch {
      const no = this.el("div", "panel-title", L.meBadLink);
      card.appendChild(no);
    }

    body.appendChild(card);
    this.root.appendChild(body);
  }
}