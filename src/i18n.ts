export type Language = "en" | "pt";

interface Messages {
  brand: string;
  tagline: string;
  connConnecting: string;
  connOnline: string;
  connOffline: string;
  setupTitle: string;
  titleLabel: string;
  titlePh: string;
  prizeLabel: string;
  prizePh: string;
  titlePtLabel: string;
  titlePtPh: string;
  prizePtLabel: string;
  prizePtPh: string;
  countLabel: string;
  countPh: string;
  priceLabel: string;
  pricePh: string;
  currencyLabel: string;
  createBtn: string;
  raffleLabel: string;
  prizeName: string;
  availableName: string;
  soldName: string;
  raisedName: string;
  prizeAmountName: string;
  chooseLabel: string;
  buyBtn: string;
  namePh: string;
  drawBtn: string;
  drawing: string;
  noTickets: string;
  winnerLabel: string;
  wonNumber: string;
  drawAgain: string;
  resetBtn: string;
  soldOut: string;
  currencies: string[];
  money: (n: number, c: string) => string;
  payTitle: string;
  payEmailLabel: string;
  payEmailPh: string;
  payNameLabel: string;
  payNamePh: string;
  payTotal: string;
  payWithPix: string;
  payScan: string;
  payPixCopy: string;
  payCopy: string;
  payCopied: string;
  payWaiting: string;
  payApproved: string;
  payError: string;
  payClose: string;
  payUseAnother: string;
  paySuccess: string;
  paySuccessHint: string;
  adminLogin: string;
  adminPassLabel: string;
  adminPassPh: string;
  adminCreateBtn: string;
  adminLoginBtn: string;
  adminWrongPass: string;
  adminCreated: string;
  adminNoRaffle: string;
  noRaffle: string;
  noRaffleHint: string;
  drawingSoon: string;
  winnerEmailSent: string;
  winnerClaimLink: string;
  freeNumbers: string;
  buyEmailPh: string;
  buyNamePh: string;
  meTitle: string;
  meBadLink: string;
  meNoRaffles: string;
  meNumbers: string;
  meResult: string;
  meWon: string;
  meLost: string;
  mePending: string;
  meBack: string;
  footerTrust: string;
  footerSecurity: string;
  footerFoundation: string;
  wdTitle: string;
  wdPrize: string;
  wdPayout: string;
  wdKeyType: string;
  wdKeyPh: string;
  wdBtn: string;
  wdDone: string;
  wdAlready: string;
  wdError: string;
  continueBtn: string;
}

const sym: Record<string, string> = { BRL: "R$", USD: "$", EUR: "€" };

export const messages: Record<Language, Messages> = {
  en: {
    brand: "Golden Lion Raffle",
    tagline: "Pick your lucky number and win the prize",
    connConnecting: "Connecting…",
    connOnline: "Online",
    connOffline: "Offline",
    setupTitle: "New Raffle",
    titleLabel: "Raffle title",
    titlePh: "e.g. Beach trip",
    prizeLabel: "Prize",
    prizePh: "e.g. Vacation package",
    titlePtLabel: "Title (Portuguese)",
    titlePtPh: "e.g. Viagem para a praia",
    prizePtLabel: "Prize (Portuguese)",
    prizePtPh: "e.g. Pacote de férias",
    countLabel: "Number of tickets",
    countPh: "e.g. 50",
    priceLabel: "Price per ticket",
    pricePh: "e.g. 10",
    currencyLabel: "Currency",
    createBtn: "Create Raffle",
    raffleLabel: "Rifa",
    prizeName: "Prize",
    availableName: "Available",
    soldName: "Sold",
    raisedName: "Raised",
    prizeAmountName: "Prize value",
    chooseLabel: "Choose your number",
    buyBtn: "Buy Ticket",
    namePh: "Your name",
    drawBtn: "Draw Winner",
    drawing: "Drawing...",
    noTickets: "No tickets sold yet. Be the first to buy one!",
    winnerLabel: "WINNER!",
    wonNumber: "won number",
    drawAgain: "Draw Again",
    resetBtn: "New Raffle",
    soldOut: "Sold out!",
    currencies: ["BRL", "USD", "EUR"],
    money: (n, c) => `${sym[c] ?? ""} ${n.toLocaleString("en-US")}`,
    payTitle: "Payment",
    payEmailLabel: "Email",
    payEmailPh: "you@example.com",
    payNameLabel: "Name",
    payNamePh: "Full name",
    payTotal: "Total",
    payWithPix: "Payment",
    payScan: "Pay with PIX. Scan the QR code with your banking app, or copy the code below:",
    payPixCopy: "PIX code",
    payCopy: "Copy",
    payCopied: "Copied!",
    payWaiting: "Waiting for payment...",
    payApproved: "Payment approved!",
    payError: "Something went wrong. Try again.",
    payClose: "Close",
    payUseAnother: "Try again",
    paySuccess: "Payment successful!",
    paySuccessHint: "Your numbers have been reserved.",
    adminLogin: "Admin",
    adminPassLabel: "Admin password",
    adminPassPh: "password",
    adminCreateBtn: "Create Raffle",
    adminLoginBtn: "Unlock",
    adminWrongPass: "Wrong password.",
    adminCreated: "Raffle created and replaces the previous one.",
    adminNoRaffle: "No raffle has been created yet.",
    noRaffle: "No raffle is active yet.",
    noRaffleHint: "The raffle is created by the admin on /admin. A draw happens automatically when it fills up.",
    drawingSoon: "The raffle is full. The winner is being drawn...",
    winnerEmailSent: "The winner has been notified by email.",
    winnerClaimLink: "Claim prize",
    freeNumbers: "free",
    buyEmailPh: "your@email.com",
    buyNamePh: "Your name",
    meTitle: "My Raffles",
    meBadLink: "Invalid or expired link.",
    meNoRaffles: "You haven't participated in any raffles yet.",
    meNumbers: "Numbers",
    meResult: "Result",
    meWon: "Won",
    meLost: "Didn't win",
mePending: "In progress",
    meBack: "← Home",
    footerTrust: "Open source — auditable & transparent.",
    footerSecurity: "Protected by Mercado Pago • PIX",
    footerFoundation: "A share of every raffle supports the Stellar Foundation.",
    wdTitle: "Withdraw Prize",
    wdPrize: "Prize",
    wdPayout: "Prize payout",
    wdKeyType: "PIX key type",
    wdKeyPh: "Select your PIX key",
    wdBtn: "Withdraw via PIX",
    wdDone: "Payout sent!",
    wdAlready: "This prize has already been paid.",
    wdError: "Payout could not be processed.",
    continueBtn: "Continue",
  },
  pt: {
    brand: "Rifa Leão Dourado",
    tagline: "Escolha seu número da sorte e concorra ao prêmio",
    connConnecting: "Conectando…",
    connOnline: "Online",
    connOffline: "Offline",
    setupTitle: "Nova Rifa",
    titleLabel: "Título da rifa",
    titlePh: "ex.: Viagem para a praia",
    prizeLabel: "Prêmio",
    prizePh: "ex.: Pacote de férias",
    titlePtLabel: "Título (Português)",
    titlePtPh: "ex.: Viagem para a praia",
    prizePtLabel: "Prêmio (Português)",
    prizePtPh: "ex.: Pacote de férias",
    countLabel: "Quantidade de números",
    countPh: "ex.: 50",
    priceLabel: "Preço do número",
    pricePh: "ex.: 10",
    currencyLabel: "Moeda",
    createBtn: "Criar Rifa",
    raffleLabel: "Rifa",
    prizeName: "Prêmio",
    availableName: "Disponíveis",
    soldName: "Vendidos",
    raisedName: "Arrecadado",
    prizeAmountName: "Valor do prêmio",
    chooseLabel: "Escolha seu número",
    buyBtn: "Comprar",
    namePh: "Seu nome",
    drawBtn: "Sortear Vencedor",
    drawing: "Sorteando...",
    noTickets: "Nenhum número vendido ainda. Seja o primeiro a comprar!",
    winnerLabel: "VENCEDOR",
    wonNumber: "ganhou o número",
    drawAgain: "Sortear novamente",
    resetBtn: "Nova Rifa",
    soldOut: "Esgotado!",
    currencies: ["BRL", "USD", "EUR"],
    money: (n, c) => `${sym[c] ?? ""} ${n.toLocaleString("pt-BR")}`,
    payTitle: "Pagamento",
    payEmailLabel: "Email",
    payEmailPh: "voce@exemplo.com",
    payNameLabel: "Nome",
    payNamePh: "Nome completo",
    payTotal: "Total",
    payWithPix: "Pagamento",
    payScan: "Pague com PIX. Escaneie o QR Code com seu app de banco ou copie o código abaixo:",
    payPixCopy: "Código PIX",
    payCopy: "Copiar",
    payCopied: "Copiado!",
    payWaiting: "Aguardando pagamento...",
    payApproved: "Pagamento aprovado!",
    payError: "Algo deu errado. Tente novamente.",
    payClose: "Fechar",
    payUseAnother: "Tentar novamente",
    paySuccess: "Pagamento realizado!",
    paySuccessHint: "Seus números foram reservados.",
    adminLogin: "Administração",
    adminPassLabel: "Senha de administrador",
    adminPassPh: "senha",
    adminCreateBtn: "Criar Rifa",
    adminLoginBtn: "Desbloquear",
    adminWrongPass: "Senha incorreta.",
    adminCreated: "Rifa criada e substitui a anterior.",
    adminNoRaffle: "Nenhuma rifa foi criada ainda.",
    noRaffle: "Nenhuma rifa ativa no momento.",
    noRaffleHint: "A rifa é criada pelo admin em /admin. Um sorteio acontece automaticamente quando ela esgotar.",
    drawingSoon: "A rifa esgotou. O vencedor está sendo sorteado...",
    winnerEmailSent: "O vencedor foi notificado por email.",
    winnerClaimLink: "Resgatar prêmio",
    freeNumbers: "livres",
    buyEmailPh: "voce@email.com",
    buyNamePh: "Seu nome",
    meTitle: "Minhas Rifas",
    meBadLink: "Link inválido ou expirado.",
    meNoRaffles: "Você ainda não participou de nenhuma rifa.",
    meNumbers: "Números",
    meResult: "Resultado",
    meWon: "Ganhou",
    meLost: "Não ganhou",
    mePending: "Em andamento",
    meBack: "← Início",
    footerTrust: "Código aberto — auditável e transparente.",
    footerSecurity: "Pagamentos seguros por Mercado Pago • PIX",
    footerFoundation: "Parte de cada rifa apoia a Fundação Stellar.",
    wdTitle: "Retirar Prêmio",
    wdPrize: "Prêmio",
    wdPayout: "Pagamento do prêmio",
    wdKeyType: "Tipo de chave PIX",
    wdKeyPh: "Digite sua chave PIX",
    wdBtn: "Retirar via PIX",
    wdDone: "Pagamento enviado!",
    wdAlready: "Este prêmio já foi pago.",
    wdError: "Não foi possível processar o pagamento.",
    continueBtn: "Continuar",
  },
};

export function t(lang: Language): Messages {
  return messages[lang];
}

export function detectLanguage(): Language {
  const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  for (const code of langs) {
    const base = code.toLowerCase().split("-")[0];
    if (base === "pt") return "pt";
    if (base === "en") return "en";
  }
  return "en";
}