import { t } from "../i18n";
import { createAdminRaffle, getRaffle, type PublicRaffle } from "../api";

export class AdminOverlay {
  private root: HTMLElement;
  private raffle: PublicRaffle | null = null;

  constructor(private container: HTMLElement) {
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
    titleGroup.appendChild(this.el("div", "brand", `⚙ ${L.adminLogin}`));
    const back = this.el("button", "lang-btn", "← Home");
    back.onclick = () => (window.location.href = "/");
    topBar.appendChild(titleGroup);
    topBar.appendChild(back);
    this.root.appendChild(topBar);

    try {
      this.raffle = await getRaffle();
    } catch {
      this.raffle = null;
    }
    this.buildAdmin();
  }

  private buildAdmin() {
    const L = this.L();

    const body = this.el("div", "admin-body");

    // create form
    const form = this.el("form", "form create");
    const card = this.el("div", "panel");
    card.appendChild(this.el("div", "panel-title", L.setupTitle));

    const fields = [
      { key: "title", label: L.titleLabel, ph: L.titlePh },
      { key: "prize", label: L.prizeLabel, ph: L.prizePh },
      { key: "titlePt", label: L.titlePtLabel, ph: L.titlePtPh },
      { key: "prizePt", label: L.prizePtLabel, ph: L.prizePtPh },
    ];
    const values: Record<string, HTMLInputElement> = {};
    for (const f of fields) {
      const row = this.el("label", "field");
      row.appendChild(this.el("span", "field-label", f.label));
      const input = this.el("input", "input");
      input.placeholder = f.ph;
      input.value = this.raffle?.title && f.key === "title" ? this.raffle.title : "";
      row.appendChild(input);
      values[f.key] = input;
      form.appendChild(row);
    }

    // Numeric share settings (count + price) in a compact side-by-side row so
    // the price per share is always visible without scrolling.
    const numRow = this.el("div", "field-row");
    const mkNum = (key: "count" | "price", label: string, ph: string, inputmode: "numeric" | "decimal") => {
      const row = this.el("label", "field");
      row.appendChild(this.el("span", "field-label", label));
      const input = this.el("input", "input");
      input.inputMode = inputmode;
      input.placeholder = ph;
      row.appendChild(input);
      values[key] = input;
      numRow.appendChild(row);
    };
    mkNum("count", L.countLabel, L.countPh, "numeric");
    mkNum("price", L.priceLabel, L.pricePh, "decimal");
    form.appendChild(numRow);

    const curRow = this.el("label", "field");
    curRow.appendChild(this.el("span", "field-label", L.currencyLabel));
    const sel = this.el("select", "input");
    for (const c of t("en").currencies) {
      const opt = this.el("option");
      opt.value = c;
      opt.textContent = c;
      sel.appendChild(opt);
    }
    curRow.appendChild(sel);
    form.appendChild(curRow);

    const passRow = this.el("label", "field");
    passRow.appendChild(this.el("span", "field-label", L.adminPassLabel));
    const pass = this.el("input", "input");
    pass.type = "password";
    pass.placeholder = L.adminPassPh;
    passRow.appendChild(pass);
    form.appendChild(passRow);

    const msg = this.el("div", "modal-status");
    form.appendChild(msg);

    const createBtn = this.el("button", "btn btn-primary", L.createBtn);
    createBtn.type = "submit";
    form.appendChild(createBtn);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const title = values.title.value.trim();
      const prize = values.prize.value.trim();
      const titlePt = values.titlePt.value.trim();
      const prizePt = values.prizePt.value.trim();
      const count = parseInt(values.count.value, 10);
      const price = parseFloat(values.price.value.replace(",", "."));
      if (!title || !prize || isNaN(count) || count < 1 || isNaN(price) || price <= 0) {
        msg.textContent = L.adminWrongPass;
        msg.classList.add("err");
        return;
      }
      try {
        await createAdminRaffle({ password: pass.value, title, titlePt, prize, prizePt, price, currency: sel.value, ticketCount: count });
        msg.textContent = L.adminCreated;
        msg.classList.remove("err");
        this.raffle = await getRaffle();
        this.start();
      } catch (err: any) {
        msg.textContent = err?.message ?? L.adminWrongPass;
        msg.classList.add("err");
      }
    };
    card.appendChild(form);

    // current raffle status
    const statusPanel = this.el("div", "panel");
    if (this.raffle) {
      statusPanel.appendChild(this.el("div", "panel-title", this.raffle.title));
      statusPanel.appendChild(
        this.el("div", "info-prize", `${L.prizeName}: ${this.raffle.prize} • ${this.raffle.soldCount}/${this.raffle.ticketCount} ${L.soldName}`)
      );
      if (this.raffle.winner) {
        const w = this.el("div", "info-val gold", `${L.winnerLabel}: #${String(this.raffle.winner.number).padStart(2, "0")} (${this.raffle.winner.email})`);
        statusPanel.appendChild(w);
      }
    } else {
      statusPanel.appendChild(this.el("div", "panel-title", L.adminNoRaffle));
    }

    body.appendChild(card);
    body.appendChild(statusPanel);
    this.root.appendChild(body);
  }

  destroy() {
    this.root.remove();
  }
}