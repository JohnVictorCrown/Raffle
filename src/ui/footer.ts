export function buildFooter(L: any): HTMLDivElement {
  const footer = document.createElement("div");
  footer.className = "footer";

  const trust = document.createElement("div");
  trust.className = "footer-line";
  trust.textContent = `🔒 ${L.footerTrust}`;

  const secure = document.createElement("div");
  secure.className = "footer-line";
  secure.textContent = `${L.footerSecurity}`;

  const foundation = document.createElement("a");
  foundation.className = "footer-line footer-link";
  foundation.href = "https://www.stellarium.ddns-ip.net";
  foundation.target = "_blank";
  foundation.rel = "noopener";
  foundation.textContent = `⭐ ${L.footerFoundation}`;

  const link = document.createElement("a");
  link.className = "footer-line footer-link";
  link.href = "https://github.com/JohnVictorCrown/Raffle";
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "github.com/JohnVictorCrown/Raffle";

  footer.appendChild(trust);
  footer.appendChild(secure);
  footer.appendChild(foundation);
  footer.appendChild(link);
  return footer;
}