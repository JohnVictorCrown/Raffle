import { getMyRaffles, type MyRaffles } from "../api";
import { t } from "../i18n";
import { buildFooter } from "./footer";

export class MyRafflesOverlay {
  private root: HTMLElement;
  private body: HTMLElement | null = null;

  constructor(
    private container: HTMLElement,
    private code: string,
    private email: string
  ) {
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
    titleGroup.appendChild(this.el("div", "brand", L.meTitle));
    const back = this.el("button", "lang-btn", L.meBack);
    back.onclick = () => (window.location.href = "/");
    topBar.appendChild(titleGroup);
    topBar.appendChild(back);
    this.root.appendChild(topBar);

    this.root.appendChild(buildFooter(L));

    // No code or email: ask the user for their email, which is an alias for the
    // code and lets them see their raffles + results.
    if (!this.code && !this.email) {
      this.renderEmailForm();
      return;
    }

    try {
      const data = await getMyRaffles(this.code, this.email);
      this.render(data);
    } catch {
      this.renderBad();
    }
  }

  private renderEmailForm() {
    const L = this.L();
    const body = this.el("div", "admin-body");
    const card = this.el("div", "panel");
    card.appendChild(this.el("div", "panel-title", L.meTitle));

    const row = this.el("label", "field");
    row.appendChild(this.el("span", "field-label", L.meEmailLabel));
    const input = this.el("input", "input");
    input.type = "email";
    input.placeholder = L.meEmailPh;
    row.appendChild(input);
    card.appendChild(row);

    const msg = this.el("div", "modal-status");
    card.appendChild(msg);

    const btn = this.el("button", "btn btn-primary", L.meEmailBtn);
    btn.onclick = async () => {
      const email = input.value.trim();
      if (!email) return;
      btn.disabled = true;
      try {
        const data = await getMyRaffles("", email);
        if (this.body) this.body.remove();
        this.render(data);
      } catch (err: any) {
        msg.textContent = err?.message ?? L.meBadLink;
        msg.classList.add("err");
        btn.disabled = false;
      }
    };
    card.appendChild(btn);

    body.appendChild(card);
    this.body = body;
    this.root.appendChild(body);
  }

  private renderBad() {
    const L = this.L();
    const no = this.el("div", "panel setup center");
    no.appendChild(this.el("div", "panel-title", L.meBadLink));
    this.root.appendChild(no);
  }

  private render(data: MyRaffles) {
    const L = this.L();
    const body = this.el("div", "admin-body");
    const card = this.el("div", "panel");
    card.appendChild(this.el("div", "panel-title", `${L.meTitle} — ${data.name || data.email}`));

    if (!data.raffles.length) {
      const empty = this.el("div", "no-raffle-hint", L.meNoRaffles);
      card.appendChild(empty);
    } else {
      for (const r of data.raffles) {
        const row = this.el("div", "me-row");
        row.appendChild(this.el("div", "me-title", r.title));
        row.appendChild(this.el("div", "me-nums", `${L.meNumbers}: #${r.numbers.map((n) => String(n).padStart(2, "0")).join(", #")}`));
        row.appendChild(
          this.el(
            "div",
            `me-result ${r.won ? "won" : r.ended ? "lost" : "pending"}`,
            `${L.meResult}: ${r.won ? L.meWon : r.ended ? L.meLost : L.mePending}`
          )
        );
        card.appendChild(row);
      }
    }

    body.appendChild(card);
    this.root.appendChild(body);
  }
}