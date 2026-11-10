import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  updateDoc,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  commitmentAmountAt,
  commitmentEndKey,
  getCommitmentsForMonth,
  isCommitmentActiveAt,
  monthKeyToInput,
  renderDashboardCommitments,
  renderCommitmentsPage,
  toMonthKey
} from "./fixed_commitments.js";
import { parseStatementFile, renderImportPanel } from "./importer.js";
import { renderGoalProjection } from "./projections.js";

const firebaseConfig = {
  apiKey: "AIzaSyCyw5KvXGQcSvddsa5FQYRl1ZimY6xSDAU",
  authDomain: "talvez-de336.firebaseapp.com",
  projectId: "talvez-de336",
  storageBucket: "talvez-de336.firebasestorage.app",
  messagingSenderId: "281895187431",
  appId: "1:281895187431:web:5ee6fda4b30c2166998342"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const appRoot = document.querySelector("#app");
const toastRegion = document.querySelector("#toast-region");
const categoryOptions = ["Moradia", "Alimentação", "Transporte", "Educação", "Saúde", "Lazer", "Assinaturas", "Investimentos", "Outros"];
const monthNames = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const navItems = [
  { route: "/dashboard", label: "Visão geral", icon: "layout-dashboard" },
  { route: "/lancamentos", label: "Lançamentos", icon: "receipt-text" },
  { route: "/compromissos", label: "Compromissos", icon: "calendar-clock" },
  { route: "/patrimonio", label: "Patrimônio", icon: "landmark" }
];

const today = new Date();
const state = {
  user: null,
  page: location.pathname,
  month: today.getMonth(),
  year: today.getFullYear(),
  transactions: [],
  commitments: [],
  investments: [],
  monthlyBudget: null,
  importPreview: null,
  assets: { savingsBalance: 0, mxrfShares: 0, mxrfPrice: 0, pendingDividends: 0 },
  settings: {
    savingsGoal: 5000,
    monthlySavings: 200,
    uninter: 200,
    cdiAnnualRate: 0
  },
  editingId: null,
  quickAddOpen: false,
  editModal: null,
  chart: null,
  unsubs: [],
  drawerOpen: false,
  dataReady: false
};
let countdownTimer = null;
let monthlyBudgetUnsub = null;
let monthlyBudgetSubscriptionKey = null;

const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
const number = (value) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(Number(value) || 0);
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);
const userPath = (name) => collection(db, "users", state.user.uid, name);
const settingsRef = () => doc(db, "users", state.user.uid, "configuracoes", "preferencias");
const assetsRef = () => doc(db, "users", state.user.uid, "patrimonio", "resumo");
const selectedMonthInput = () => monthKeyToInput(selectedMonthKey());
const monthlyBudgetRef = (month = selectedMonthInput()) => doc(db, "users", state.user.uid, "meses", month);
const formatDateInput = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const transactionDate = (transaction) => {
  const [year, month, day] = String(transaction.date || "").split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
};
const monthKey = (year, month) => year * 12 + month;
const selectedMonthKey = () => monthKey(state.year, state.month);
const savingsPlanEndMonthKey = () => monthKey(today.getMonth() <= 1 ? today.getFullYear() : today.getFullYear() + 1, 1);
function subscribeSelectedMonthBudget() {
  if (!state.user) return;
  const month = selectedMonthInput();
  const subscriptionKey = `${state.user.uid}:${month}`;
  if (monthlyBudgetSubscriptionKey === subscriptionKey) return;
  monthlyBudgetUnsub?.();
  monthlyBudgetSubscriptionKey = subscriptionKey;
  state.monthlyBudget = null;
  monthlyBudgetUnsub = onSnapshot(monthlyBudgetRef(month), (snapshot) => {
    if (monthlyBudgetSubscriptionKey !== subscriptionKey || auth.currentUser?.uid !== state.user?.uid) return;
    state.monthlyBudget = snapshot.exists() ? snapshot.data() : null;
    render();
  }, (error) => {
    if (monthlyBudgetSubscriptionKey === subscriptionKey) reportError(error, "Não foi possível carregar a renda deste mês.");
  });
}

function getUninterFallbackCommitment() {
  if (state.commitments.some((item) => /uninter/i.test(item.name))) return null;
  const adjustments = (Array.isArray(state.settings.uninterAdjustments) ? state.settings.uninterAdjustments : [])
    .map((item) => ({ effectiveMonth: item.effectiveMonth, monthlyAmount: item.monthlyAmount }));
  if ((Number(state.settings.uninter) || 0) <= 0 && !adjustments.some((item) => Number(item.monthlyAmount) > 0)) return null;
  return {
    id: "__uninter__",
    name: state.settings.uninterDescription || "Faculdade Uninter",
    description: state.settings.uninterDescription || "Faculdade Uninter",
    category: state.settings.uninterCategory || "Educação",
    type: "expense",
    monthlyAmount: Number(state.settings.uninter) || 0,
    startMonth: state.settings.uninterStartMonth || monthKeyToInput(monthKey(today.getFullYear(), today.getMonth())),
    endMonth: state.settings.uninterEndMonth || null,
    durationMonths: null,
    termType: "ongoing",
    dueDay: 1,
    adjustments,
    dateOverrides: Array.isArray(state.settings.uninterDateOverrides) ? state.settings.uninterDateOverrides : [],
    paidMonths: Array.isArray(state.settings.uninterPaidMonths) ? state.settings.uninterPaidMonths : [],
    isUninterFallback: true
  };
}

function commitmentsForDisplay() {
  const fallback = getUninterFallbackCommitment();
  return fallback ? state.commitments.concat(fallback) : state.commitments;
}

const savingsForSelectedMonth = () => {
  const key = selectedMonthKey();
  const baseContribution = key <= savingsPlanEndMonthKey() ? Number(state.settings.monthlySavings) || 0 : 0;
  const releasedCommitments = commitmentsForDisplay().reduce((sum, item) => {
    const endKey = commitmentEndKey(item);
    const paidMonths = Array.isArray(item.paidMonths) ? item.paidMonths : [];
    const endMonth = Number.isFinite(endKey) ? monthKeyToInput(endKey) : "";
    return Number.isFinite(endKey) && key > endKey && paidMonths.includes(endMonth)
      ? sum + commitmentAmountAt(item, endKey)
      : sum;
  }, 0);
  return baseContribution + releasedCommitments;
};
const commitmentsPath = () => userPath("compromissos");
const investmentsPath = () => userPath("investimentos");

function investmentContributionTotal(categoryPattern = null) {
  const selectedKey = selectedMonthKey();
  return state.investments.reduce((sum, item) => {
    if (item.isPaid === false) return sum;
    const contributionKey = toMonthKey(item.date);
    if (!Number.isFinite(contributionKey) || contributionKey > selectedKey) return sum;
    if (categoryPattern && !categoryPattern.test(String(item.category || ""))) return sum;
    return sum + Math.max(0, Number(item.amount) || 0);
  }, 0);
}

function getDateOverrideAt(overrides, month) {
  const match = (Array.isArray(overrides) ? overrides : []).find((item) => item.effectiveMonth === month);
  return match?.date || "";
}

function replacePeriodEntry(entries, effectiveMonth, patch) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry.effectiveMonth !== effectiveMonth)
    .concat({ effectiveMonth, ...patch })
    .sort((a, b) => toMonthKey(a.effectiveMonth) - toMonthKey(b.effectiveMonth));
}

function installmentCentsAt(purchase, index) {
  const baseCents = Number(purchase.installmentBaseCents) || 0;
  const remainderCents = Number(purchase.installmentRemainderCents) || 0;
  const month = monthKeyToInput(monthKey(transactionDate(purchase).getFullYear(), transactionDate(purchase).getMonth()) + index);
  const changes = (Array.isArray(purchase.installmentAdjustments) ? purchase.installmentAdjustments : [])
    .map((change) => ({ ...change, key: toMonthKey(change.effectiveMonth) }))
    .filter((change) => Number.isFinite(change.key) && change.key <= toMonthKey(month))
    .sort((a, b) => a.key - b.key);
  if (changes.length) return Math.max(0, Number(changes.at(-1).amountCents) || 0);
  return baseCents + (index < remainderCents ? 1 : 0);
}

function installmentDate(startDate, monthOffset) {
  const start = transactionDate({ date: startDate });
  const targetMonth = new Date(start.getFullYear(), start.getMonth() + monthOffset, 1);
  const day = Math.min(start.getDate(), new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate());
  targetMonth.setDate(day);
  return formatDateInput(targetMonth);
}

function selectedMonthTransactions() {
  const targetKey = selectedMonthKey();
  const transactions = state.transactions.flatMap((item) => {
    if (!item.isInstallment) {
      const date = transactionDate(item);
      return date.getFullYear() === state.year && date.getMonth() === state.month ? [item] : [];
    }

    const start = transactionDate(item);
    const offset = targetKey - monthKey(start.getFullYear(), start.getMonth());
    const count = Number(item.installmentCount) || 0;
    if (offset < 0 || offset >= count) return [];

    const occurrenceMonth = monthKeyToInput(targetKey);
    return [{
      ...item,
      amount: installmentCentsAt(item, offset) / 100,
      date: getDateOverrideAt(item.installmentDateOverrides, occurrenceMonth) || installmentDate(item.date, offset),
      isProjectedInstallment: true,
      installmentIndex: offset + 1
    }];
  });
  const investments = state.investments
    .filter((item) => {
      const date = transactionDate(item);
      return date.getFullYear() === state.year && date.getMonth() === state.month;
    })
    .map((item) => ({
      ...item,
      type: "expense",
      isInvestmentContribution: true,
      isPaid: item.isPaid !== false
    }));
  const fixedCommitments = getCommitmentsForMonth(commitmentsForDisplay(), state.year, state.month);
  return transactions.concat(investments, fixedCommitments);
}

function shiftSelectedMonth(amount) {
  const next = new Date(state.year, state.month + amount, 1);
  state.year = next.getFullYear();
  state.month = next.getMonth();
  subscribeSelectedMonthBudget();
  render();
}

function toast(message, error = false) {
  const element = document.createElement("div");
  element.className = `toast${error ? " error" : ""}`;
  element.textContent = message;
  toastRegion.append(element);
  window.setTimeout(() => element.remove(), 4200);
}

function reportError(error, fallback = "Não foi possível concluir a operação.") {
  console.error(error);
  toast(error?.message || fallback, true);
}

function icon(name, size = 18) {
  return `<i data-lucide="${name}" width="${size}" height="${size}" aria-hidden="true"></i>`;
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function navigate(path) {
  if (location.pathname !== path) history.pushState({}, "", path);
  state.page = path;
  state.drawerOpen = false;
  render();
}

function navLinks(drawer = false) {
  return navItems.map((item) => {
    const active = state.page === item.route;
    return `<a href="${item.route}" data-route="${item.route}" class="${drawer ? "drawer-link" : "nav-link"}${active ? " active" : ""}">
      ${icon(item.icon, 17)}<span>${item.label}</span>
    </a>`;
  }).join("");
}

function shell(content) {
  const displayName = escapeHtml(state.user?.displayName || state.user?.email?.split("@")[0] || "Minha conta");
  return `
    <div class="min-h-screen">
      <header class="app-header sticky top-0 z-30">
        <div class="mx-auto flex h-[68px] max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div class="flex items-center gap-3">
            <button type="button" class="icon-button md:hidden" data-action="toggle-drawer" aria-label="Abrir menu">${icon("menu")}</button>
            <a href="/dashboard" data-route="/dashboard" class="flex items-center gap-3">
              <span class="brand-mark">${icon("trending-up", 19)}</span>
              <span class="font-display text-[16px] font-extrabold tracking-tight">Vértice<span class="text-violet-300">.</span></span>
            </a>
          </div>
          <nav class="hidden items-center gap-8 text-[13px] font-semibold md:flex">${navLinks()}</nav>
          <div class="flex items-center gap-3">
            <span class="hidden max-w-36 truncate text-xs text-stone-400 sm:inline">${displayName}</span>
            <button type="button" class="icon-button" data-action="signout" aria-label="Sair">${icon("log-out", 17)}</button>
          </div>
        </div>
      </header>
      <div class="drawer-backdrop${state.drawerOpen ? " open" : ""}" data-action="close-drawer"></div>
      <aside class="mobile-drawer${state.drawerOpen ? " open" : ""}" aria-label="Menu de navegação">
        <div class="mb-8 flex items-center justify-between">
          <span class="flex items-center gap-3 font-display font-extrabold">${icon("trending-up", 19)} Vértice</span>
          <button type="button" class="icon-button" data-action="close-drawer" aria-label="Fechar menu">${icon("x")}</button>
        </div>
        <nav class="grid gap-2">${navLinks(true)}</nav>
        <div class="mt-8 border-t border-line pt-5 text-xs text-stone-500">Seu dinheiro, com mais clareza.</div>
      </aside>
      <main class="mx-auto max-w-7xl px-4 py-7 sm:px-6 sm:py-9 lg:px-8">${content}</main>
      <footer class="mx-auto max-w-7xl px-4 pb-7 text-center text-[11px] text-stone-600 sm:px-6 lg:px-8">Seus dados financeiros são pessoais e protegidos pela sua conta.</footer>
    </div>`;
}

function pageHeading(title, description, right = "") {
  return `<div class="mb-7 flex flex-wrap items-end justify-between gap-4">
    <div><p class="mb-2 text-[11px] font-bold uppercase tracking-[.16em] text-violet-300">Controle financeiro</p>
      <h1 class="font-display text-2xl font-extrabold tracking-tight sm:text-[30px]">${title}</h1>
      <p class="mt-1.5 text-sm text-stone-400">${description}</p>
    </div>${right}
  </div>`;
}

function metricCard(title, value, caption, iconName, color = "text-white") {
  return `<article class="card metric-card p-5 sm:p-5">
    <div class="flex items-start justify-between gap-3">
      <div><p class="text-[12px] font-medium text-stone-400">${title}</p><p class="font-display mt-3 text-[22px] font-extrabold tracking-tight ${color} sm:text-[25px]">${value}</p></div>
      <span class="metric-icon">${icon(iconName, 18)}</span>
    </div><p class="mt-3 text-[11px] text-stone-500">${caption}</p>
  </article>`;
}

function computedMonth() {
  const transactions = selectedMonthTransactions();
  const actualExpense = transactions
    .filter((item) => item.type === "expense"
      && (!item.isFixedCommitment || item.isPaid)
      && (!item.isInvestmentContribution || item.isPaid))
    .reduce((sum, item) => sum + Number(item.amount), 0);
  const pendingCommitmentTotal = transactions
    .filter((item) => (item.isFixedCommitment || item.isInvestmentContribution) && !item.isPaid)
    .reduce((sum, item) => sum + Number(item.amount), 0);
  const extraIncome = transactions.filter((item) => item.type === "income").reduce((sum, item) => sum + Number(item.amount), 0);
  const baseIncome = Number(state.monthlyBudget?.baseIncome) || 0;
  const monthlySavings = savingsForSelectedMonth();
  const uninter = transactions.find((item) => item.isUninterFallback)?.amount || 0;
  const totalSpent = actualExpense;
  const free = baseIncome - totalSpent;
  return { transactions, actualExpense, pendingCommitmentTotal, extraIncome, baseIncome, monthlySavings, uninter, totalSpent, free };
}

function monthSelector() {
  return `<div class="flex items-center gap-2">
    <button class="icon-button !h-10 !w-10" type="button" data-action="previous-month" aria-label="Mês anterior">${icon("chevron-left", 17)}</button>
    <label class="sr-only" for="period-month">Período</label>
    <input id="period-month" class="field !w-[168px] !py-2.5 text-xs" type="month" value="${state.year}-${String(state.month + 1).padStart(2, "0")}">
    <button class="icon-button !h-10 !w-10" type="button" data-action="next-month" aria-label="Próximo mês">${icon("chevron-right", 17)}</button>
  </div>`;
}

function dashboardPage() {
  const values = computedMonth();
  const goal = Number(state.settings.savingsGoal) || 0;
  const baseSavings = Number(state.assets.savingsBalance) || 0;
  const savings = baseSavings + investmentContributionTotal(/caixinha|reserva/i);
  const investmentTotal = investmentContributionTotal();
  const totalAssets = baseSavings + (Number(state.assets.mxrfShares) * Number(state.assets.mxrfPrice)) + investmentTotal;
  const goalPercent = goal > 0 ? Math.min(100, savings / goal * 100) : 0;
  const goalRemaining = Math.max(0, goal - savings);
  const alert = values.free < 100;
  return shell(`
    ${pageHeading("Visão geral", `Seu panorama de ${monthNames[state.month]} de ${state.year}.`, monthSelector())}
    ${alert ? `<section class="alert-card mb-5 flex items-start gap-3 rounded-2xl p-4" role="status">
      <span class="mt-0.5 text-rose-300">${icon("triangle-alert", 19)}</span>
      <div><p class="text-sm font-bold text-rose-200">Atenção à sua margem livre</p><p class="mt-1 text-xs leading-relaxed text-rose-100/70">A projeção para este mês está abaixo de R$ 100,00. Revise gastos e parcelas antes de novos compromissos.</p></div>
    </section>` : ""}
    <section class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      ${metricCard("Renda base", money(values.baseIncome + values.extraIncome), `${money(values.baseIncome)} de renda base${values.extraIncome ? ` + ${money(values.extraIncome)} extra` : ""}`, "wallet", "text-white")}
      ${metricCard("Total gasto no mês", money(values.totalSpent), `${money(values.actualExpense)} confirmados · ${money(values.pendingCommitmentTotal)} em compromissos e aportes pendentes`, "arrow-down-right", "text-rose-200")}
      ${metricCard("Margem livre no bolso", money(values.free), `${money(values.actualExpense)} em gastos confirmados no período`, "hand-coins", values.free < 100 ? "text-rose-200" : "text-emerald-200")}
      ${metricCard("Patrimônio total", money(totalAssets), `${money(savings)} Caixinha + MXRF11 + ${money(investmentTotal)} em aportes`, "landmark", "text-violet-100")}
    </section>
    <section class="mt-5 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
      <article class="card p-5 sm:p-6">
        <div class="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div><h2 class="font-display text-base font-bold">Gastos por categoria</h2><p class="mt-1 text-xs text-stone-500">${monthNames[state.month]} de ${state.year}</p></div>
          <span class="pill">${money(values.actualExpense)} registrados</span>
        </div>
        ${values.actualExpense > 0 ? `<div class="chart-box"><canvas id="category-chart" aria-label="Gráfico de gastos por categoria"></canvas></div>` : `<div class="empty-state">${values.pendingCommitmentTotal > 0 ? `${money(values.pendingCommitmentTotal)} em compromissos pendentes. Eles entram no gráfico somente após confirmação do pagamento.` : "Adicione lançamentos de despesas para visualizar a distribuição por categoria."}</div>`}
      </article>
      <article class="card p-5 sm:p-6">
        <div class="flex items-start justify-between gap-3">
          <div><h2 class="font-display text-base font-bold">Meta da Caixinha</h2><p class="mt-1 text-xs text-stone-500">Reserva de segurança</p></div>
          <span class="metric-icon">${icon("target", 18)}</span>
        </div>
        <div class="mt-7 flex items-end justify-between gap-3"><span class="font-display text-2xl font-extrabold">${money(savings)}</span><span class="text-xs text-stone-400">de ${money(goal)}</span></div>
        <div class="progress-track mt-3"><div class="progress-fill" style="width:${goalPercent}%"></div></div>
        <div class="mt-2 flex justify-between text-[11px] text-stone-500"><span>${number(goalPercent)}% da meta</span><span>Faltam ${money(goalRemaining)}</span></div>
        <div class="mt-6 border-t border-line pt-5">
          <div class="flex items-center justify-between"><span class="text-xs text-stone-400">Aporte mensal planejado</span><span class="text-sm font-bold">${money(values.monthlySavings)}</span></div>
          <p class="mt-2 text-[11px] leading-relaxed text-stone-500">Aporte configurado até fevereiro de ${today.getMonth() <= 1 ? today.getFullYear() : today.getFullYear() + 1}. A projeção considera também ${money(values.uninter)} mensais de faculdade.</p>
          <a href="/patrimonio" data-route="/patrimonio" class="subtle-link mt-4 inline-flex items-center gap-2 text-xs font-semibold">Atualizar patrimônio ${icon("arrow-up-right", 14)}</a>
        </div>
      </article>
    </section>
    ${renderDashboardCommitments({
      commitments: commitmentsForDisplay(),
      year: state.year,
      month: state.month,
      money,
      escapeHtml,
      icon
    })}
    ${renderGoalProjection({
      balance: totalAssets,
      target: state.settings.projectionTarget || goal,
      settings: state.settings,
      commitments: commitmentsForDisplay(),
      year: today.getFullYear(),
      month: today.getMonth(),
      money,
      escapeHtml
    })}
    <section class="card mt-5 p-5 sm:p-6">
      <div class="mb-4 flex items-center justify-between gap-3"><div><h2 class="font-display text-base font-bold">Parcelas do período</h2><p class="mt-1 text-xs text-stone-500">Compras parceladas com vencimento em ${monthNames[state.month]} de ${state.year}.</p></div><a href="/lancamentos" data-route="/lancamentos" class="subtle-link text-xs font-semibold">Ver lançamentos</a></div>
      <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        ${values.transactions.filter((item) => item.isInstallment).map((item) => `
          <div class="flex items-center justify-between gap-3 rounded-xl border border-line bg-black/10 px-4 py-3">
            <span class="min-w-0"><span class="block truncate text-xs font-semibold">${escapeHtml(item.description || item.category)}</span><span class="mt-1 block text-[10px] text-stone-500">Parcela ${item.installmentIndex}/${item.installmentCount}</span></span>
            <span class="shrink-0 text-xs font-bold text-rose-200">${money(item.amount)}</span>
          </div>`).join("") || `<p class="text-xs text-stone-500">Nenhuma parcela prevista para este período.</p>`}
      </div>
    </section>`);
}

function transactionForm() {
  const editing = state.transactions.find((item) => item.id === state.editingId);
  const defaultDate = formatDateInput(new Date(state.year, state.month, state.month === today.getMonth() && state.year === today.getFullYear() ? today.getDate() : 1));
  const item = editing || { type: "expense", amount: "", category: "Alimentação", date: defaultDate, description: "" };
  const isInstallment = Boolean(item.isInstallment);
  const valueMode = item.installmentValueMode || "total";
  const initialAmount = !editing ? "" : isInstallment
    ? valueMode === "installment"
      ? (Number(item.installmentBaseCents) || 0) / 100
      : (Number(item.installmentTotalCents) || 0) / 100
    : item.amount;

  return `<form id="transaction-form" class="grid gap-4 sm:grid-cols-2">
    <div><label class="field-label" for="transaction-type">Tipo</label><select class="field" id="transaction-type" name="type"><option value="expense"${item.type === "expense" ? " selected" : ""}>Despesa</option><option value="income"${item.type === "income" ? " selected" : ""}>Renda extra</option></select></div>
    <div><label class="field-label" for="transaction-kind">Lançamento</label><select class="field" id="transaction-kind" name="kind"><option value="single"${!isInstallment ? " selected" : ""}>Único</option><option value="installment"${isInstallment ? " selected" : ""} ${item.type === "income" ? "disabled" : ""}>Compra parcelada</option></select></div>
    <div id="transaction-value-mode-wrap" class="${isInstallment ? "" : "hidden"}"><label class="field-label" for="transaction-value-mode">Valor informado</label><select class="field" id="transaction-value-mode" name="valueMode"><option value="total"${valueMode === "total" ? " selected" : ""}>Valor total da compra</option><option value="installment"${valueMode === "installment" ? " selected" : ""}>Valor de cada parcela</option></select></div>
    <div><label class="field-label" for="transaction-amount"><span id="transaction-amount-label">${isInstallment ? valueMode === "installment" ? "Valor da parcela (R$)" : "Valor total (R$)" : "Valor (R$)"}</span></label><input class="field number-input" id="transaction-amount" name="amount" type="number" min="0.01" step="0.01" placeholder="0,00" required value="${escapeHtml(initialAmount)}"></div>
    <div><label class="field-label" for="transaction-category">Categoria</label><select class="field" id="transaction-category" name="category">${categoryOptions.map((name) => `<option${item.category === name ? " selected" : ""}>${name}</option>`).join("")}</select></div>
    <div><label class="field-label" for="transaction-date">Data de início</label><input class="field" id="transaction-date" name="date" type="date" required value="${escapeHtml(item.date)}"></div>
    <div id="transaction-count-wrap" class="${isInstallment ? "" : "hidden"}"><label class="field-label" for="transaction-count">Número de parcelas</label><input class="field" id="transaction-count" name="installmentCount" type="number" min="2" max="600" step="1" value="${isInstallment ? Number(item.installmentCount) : 2}" ${isInstallment ? "required" : "disabled"}></div>
    <div class="sm:col-span-2"><label class="field-label" for="transaction-description">Descrição</label><input class="field" id="transaction-description" name="description" maxlength="100" placeholder="Ex.: mercado, celular..." value="${escapeHtml(item.description)}"></div>
    <div class="flex gap-2 sm:col-span-2">
      <button class="btn-primary flex-1" type="submit">${icon(editing ? "save" : "plus", 16)}${editing ? "Salvar alterações" : "Salvar lançamento"}</button>
      ${editing ? `<button class="btn-secondary" type="button" data-action="cancel-edit">Cancelar</button>` : ""}
    </div>
  </form>`;
}

function transactionRows() {
  const transactions = selectedMonthTransactions().sort((a, b) => b.date.localeCompare(a.date));
  const rows = transactions.map((item) => `<tr>
    <td>${new Intl.DateTimeFormat("pt-BR").format(transactionDate(item))}</td>
    <td>${item.isProjectedInstallment ? `<span class="pill">Parcela ${item.installmentIndex}/${item.installmentCount}</span>` : item.isFixedCommitment ? `<span class="pill">${item.isPaid ? "Recorrente · Pago" : "Recorrente · Pendente"}</span>` : item.isInvestmentContribution ? `<label class="inline-flex cursor-pointer items-center gap-2"><input class="commitment-checkbox" type="checkbox" data-action="toggle-investment-payment" data-id="${escapeHtml(item.id)}" aria-label="Aporte ${item.isPaid ? "pago" : "pendente"}"${item.isPaid ? " checked" : ""}><span class="pill">${escapeHtml(item.category)} · ${item.isPaid ? "Pago" : "Pendente"}</span></label>` : `<span class="pill">${escapeHtml(item.category)}</span>`}</td>
    <td class="max-w-[200px] truncate">${escapeHtml(item.description || item.category)}</td>
    <td class="text-right font-semibold ${item.type === "income" ? "text-emerald-200" : "text-rose-200"}">${item.type === "income" ? "+" : "−"} ${money(item.amount)}</td>
    <td><div class="flex justify-end gap-2">
      <button type="button" class="icon-button !h-8 !w-8" data-action="edit-ledger-item" data-id="${escapeHtml(item.id)}" data-kind="${item.isUninterFallback ? "uninter" : item.isFixedCommitment ? "commitment" : item.isInvestmentContribution ? "investment" : item.isProjectedInstallment ? "installment" : "transaction"}" aria-label="Editar lançamento">${icon("pencil", 14)}</button>
      <button type="button" class="icon-button !h-8 !w-8 text-rose-200" data-action="delete-ledger-item" data-id="${escapeHtml(item.id)}" data-kind="${item.isUninterFallback ? "uninter" : item.isFixedCommitment ? "commitment" : item.isInvestmentContribution ? "investment" : item.isProjectedInstallment ? "installment" : "transaction"}" aria-label="Excluir lançamento">${icon("trash-2", 14)}</button>
    </div></td>
  </tr>`).join("");
  if (!rows) return `<tr><td colspan="5"><div class="empty-state">Nenhum lançamento neste mês. Adicione uma despesa ou renda extra acima.</div></td></tr>`;
  return rows;
}

function transactionEditModal() {
  const modal = state.editModal;
  if (!modal) return "";
  const item = modal.item;
  const amountLabel = modal.kind === "installment"
    ? "Valor mensal a partir deste período (R$)"
    : modal.kind === "commitment"
      ? "Valor mensal a partir deste período (R$)"
      : "Valor (R$)";
  const categories = [...new Set([item.category, ...categoryOptions].filter(Boolean))];
  const categoryOptionsHtml = categories.map((name) => `<option${item.category === name ? " selected" : ""}>${escapeHtml(name)}</option>`).join("");
  return `<div id="ledger-edit-backdrop" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" role="presentation" data-action="close-ledger-modal">
    <section class="card w-full max-w-lg p-5 shadow-2xl sm:p-6" role="dialog" aria-modal="true" aria-labelledby="ledger-edit-title">
      <div class="mb-5 flex items-start justify-between gap-3"><div><p class="mb-1 text-[10px] font-bold uppercase tracking-[.14em] text-violet-300">Editar período ${monthNames[state.month]} ${state.year}</p><h2 id="ledger-edit-title" class="font-display text-lg font-bold">${escapeHtml(item.description || item.name || item.category)}</h2>
        <p class="mt-1 text-xs text-stone-400">${modal.kind === "installment" || modal.kind === "commitment" || modal.kind === "uninter" ? "O valor será atualizado somente a partir do período selecionado." : "Atualize os dados deste lançamento."}</p></div>
        <button type="button" class="icon-button" data-action="close-ledger-modal" aria-label="Fechar">${icon("x", 16)}</button></div>
      <form id="ledger-edit-form" class="grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="id" value="${escapeHtml(item.id)}">
        <input type="hidden" name="kind" value="${modal.kind}">
        <div><label class="field-label" for="ledger-edit-amount">${amountLabel}</label><input class="field" id="ledger-edit-amount" name="amount" type="number" min="0.01" step="0.01" value="${Number(item.amount) || 0}" required autofocus></div>
        <div><label class="field-label" for="ledger-edit-date">Data</label><input class="field" id="ledger-edit-date" name="date" type="date" value="${escapeHtml(item.date)}" required></div>
        <div><label class="field-label" for="ledger-edit-category">Categoria</label><select class="field" id="ledger-edit-category" name="category">${categoryOptionsHtml}</select></div>
        <div><label class="field-label" for="ledger-edit-description">Descrição</label><input class="field" id="ledger-edit-description" name="description" maxlength="100" value="${escapeHtml(item.description || item.name || "")}" required></div>
        <div class="flex justify-end gap-2 sm:col-span-2"><button class="btn-secondary" type="button" data-action="close-ledger-modal">Cancelar</button><button class="btn-primary" type="submit">${icon("save", 15)}Salvar alterações</button></div>
      </form>
    </section>
  </div>`;
}

function transactionsPage() {
  const values = computedMonth();
  const headingActions = `<div class="flex flex-wrap items-center gap-2">${monthSelector()}
    <button type="button" class="btn-primary" data-action="quick-add" aria-label="Novo lançamento">${icon("plus", 16)}<span class="hidden sm:inline">Novo lançamento</span></button>
  </div>`;
  const showForm = state.quickAddOpen || state.editingId !== null;
  return shell(`
    ${pageHeading("Lançamentos", "Registre despesas, receitas e compras parceladas em qualquer período.", headingActions)}
    ${renderImportPanel(state.importPreview, money, escapeHtml)}
    ${showForm ? `<section id="quick-add-panel" class="card mb-5 p-5 sm:p-6">
      <div class="mb-5 flex items-start justify-between gap-3"><div><h2 class="font-display text-base font-bold">${state.editingId ? "Editar lançamento" : "Novo lançamento"}</h2><p class="mt-1 text-xs text-stone-500">Salve uma vez; as parcelas futuras entram automaticamente nos meses correspondentes.</p></div>
        <button type="button" class="icon-button" data-action="close-quick-add" aria-label="Fechar formulário">${icon("x", 17)}</button>
      </div>${transactionForm()}
    </section>` : ""}
    <div>
      <section class="card overflow-hidden">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line p-5 sm:px-6">
          <div><h2 class="font-display text-base font-bold">Movimentações</h2><p class="mt-1 text-xs text-stone-500">${monthNames[state.month]} de ${state.year} · ${values.transactions.length} lançamento(s)</p></div>
          <span class="pill">${money(values.totalSpent)} comprometidos</span>
        </div>
        <div class="table-wrap">
          <table class="data-table min-w-[720px]">
            <thead><tr><th>Data</th><th>Categoria</th><th>Descrição</th><th class="text-right">Valor</th><th class="text-right">Ações</th></tr></thead>
            <tbody>${transactionRows()}</tbody>
          </table>
        </div>
      </section>
    </div>
    ${transactionEditModal()}`);
}

function commitmentsPage() {
  return shell(`
    ${pageHeading("Compromissos e contas temporais", "Acompanhe contratos, parcelas, pagamentos e reajustes ao longo do tempo.", monthSelector())}
    ${renderCommitmentsPage({
      commitments: commitmentsForDisplay(),
      year: state.year,
      month: state.month,
      money,
      escapeHtml,
      categories: categoryOptions,
      icon
    })}`);
}

function monthlyYield(balance) {
  const annual = Math.max(0, Number(state.settings.cdiAnnualRate) || 0) / 100;
  const below = Math.min(Math.max(0, balance), 5000);
  const above = Math.max(0, balance - 5000);
  const annualRate = (Math.pow(1 + annual, 1 / 12) - 1);
  return (below * annualRate * 1.2) + (above * annualRate * 1.1);
}

function assetsPage() {
  const selectedMonthLabel = `${monthNames[state.month]} de ${state.year}`;
  const savings = Number(state.assets.savingsBalance) || 0;
  const cashContributions = investmentContributionTotal(/caixinha|reserva/i);
  const shares = Number(state.assets.mxrfShares) || 0;
  const price = Number(state.assets.mxrfPrice) || 0;
  const marketValue = shares * price;
  const marketContributions = investmentContributionTotal(/aç|acoes|ações|fii|fundo/i);
  const investmentTotal = investmentContributionTotal();
  const totalAssets = savings + marketValue + investmentTotal;
  const pending = Number(state.assets.pendingDividends) || 0;
  const monthlyIncome = monthlyYield(savings + cashContributions);
  const target = Number(state.settings.savingsGoal) || 0;
  const projection = renderGoalProjection({
    balance: totalAssets,
    target: state.settings.projectionTarget || target,
    settings: state.settings,
    commitments: commitmentsForDisplay(),
    year: today.getFullYear(),
    month: today.getMonth(),
    money,
    escapeHtml
  });
  return shell(`
    ${pageHeading("Patrimônio", "Acompanhe sua reserva e seus investimentos.", monthSelector())}
    <section class="grid gap-4 sm:grid-cols-3">
      ${metricCard("Caixinha", money(savings + cashContributions), `${money(cashContributions)} em aportes registrados · rendimento estimado ${money(monthlyIncome)}/mês`, "piggy-bank", "text-violet-100")}
      ${metricCard("Ações e FIIs", money(marketValue + marketContributions), `${number(shares)} cotas × ${money(price)} + ${money(marketContributions)} em aportes`, "chart-no-axes-combined", "text-white")}
      ${metricCard("Patrimônio total", money(totalAssets), `${money(pending)} em dividendos aguardando reinvestimento`, "landmark", "text-emerald-100")}
    </section>
    <section class="card mt-5 p-5 sm:p-6">
      <div class="mb-5"><h2 class="font-display text-base font-bold">Registrar aporte</h2><p class="mt-1 text-xs text-stone-500">Aporte confirmado atualiza o patrimônio e é contabilizado como saída no mês selecionado.</p></div>
      <form id="investment-form" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div><label class="field-label" for="investment-category">Categoria</label><select class="field" id="investment-category" name="category"><option>Aporte Caixinha</option><option>Ações</option><option>FIIs</option><option>Outros investimentos</option></select></div>
        <div><label class="field-label" for="investment-amount">Valor (R$)</label><input class="field" id="investment-amount" name="amount" type="number" min="0.01" step="0.01" required></div>
        <div><label class="field-label" for="investment-date">Data do aporte</label><input class="field" id="investment-date" name="date" type="date" value="${formatDateInput(new Date(state.year, state.month, 1))}" required></div>
        <div><label class="field-label" for="investment-description">Descrição</label><input class="field" id="investment-description" name="description" maxlength="100" placeholder="Ex.: aporte mensal" required></div>
        <label class="flex min-h-11 cursor-pointer items-center gap-2 self-end text-xs text-stone-300"><input class="commitment-checkbox" type="checkbox" name="isPaid" checked><span>Aporte realizado</span></label>
        <button class="btn-primary sm:col-span-2 lg:col-span-5" type="submit">${icon("plus", 15)}Salvar aporte</button>
      </form>
    </section>
    <section class="mt-5 grid gap-5 lg:grid-cols-2">
      <article class="card p-5 sm:p-6">
        <div class="mb-5 flex items-start justify-between gap-3">
          <div><h2 class="font-display text-base font-bold">Caixinha</h2><p class="mt-1 text-xs text-stone-500">120% do CDI até R$ 5.000; 110% sobre o excedente.</p></div>
          <span class="metric-icon">${icon("vault", 18)}</span>
        </div>
        <form id="savings-form" class="grid gap-4 sm:grid-cols-2">
          <div><label class="field-label" for="savings-balance">Saldo anterior aos aportes (R$)</label><input class="field" id="savings-balance" name="savingsBalance" type="number" min="0" step="0.01" value="${savings}"></div>
          <div><label class="field-label" for="savings-goal">Meta (R$)</label><input class="field" id="savings-goal" name="savingsGoal" type="number" min="1" step="0.01" value="${target}"></div>
          <div><label class="field-label" for="monthly-savings">Aporte mensal planejado (R$)</label><input class="field" id="monthly-savings" name="monthlySavings" type="number" min="0" step="0.01" value="${Number(state.settings.monthlySavings) || 0}"></div>
          <div><label class="field-label" for="cdi-rate">CDI anual de referência (%)</label><input class="field" id="cdi-rate" name="cdiAnnualRate" type="number" min="0" max="100" step="0.01" value="${Number(state.settings.cdiAnnualRate) || 0}" placeholder="Informe a taxa vigente"></div>
          <p class="sm:col-span-2 text-[11px] leading-relaxed text-stone-500">Informe aqui o saldo anterior aos aportes registrados acima. A estimativa usa a taxa anual informada por você e capitalização mensal; não representa garantia de rendimento.</p>
          <button class="btn-primary sm:col-span-2" type="submit">${icon("save", 15)}Salvar Caixinha</button>
        </form>
      </article>
      <article class="card p-5 sm:p-6">
        <div class="mb-5 flex items-start justify-between gap-3">
          <div><h2 class="font-display text-base font-bold">FII MXRF11</h2><p class="mt-1 text-xs text-stone-500">Registre cotas, preço de referência e dividendos recebidos.</p></div>
          <span class="metric-icon">${icon("chart-no-axes-combined", 18)}</span>
        </div>
        <form id="mxrf-form" class="grid gap-4 sm:grid-cols-2">
          <div><label class="field-label" for="mxrf-shares">Cotas</label><input class="field" id="mxrf-shares" name="mxrfShares" type="number" min="0" step="0.0001" value="${shares}"></div>
          <div><label class="field-label" for="mxrf-price">Preço por cota (R$)</label><input class="field" id="mxrf-price" name="mxrfPrice" type="number" min="0" step="0.01" value="${price}"></div>
          <div class="sm:col-span-2"><label class="field-label" for="dividends">Adicionar dividendos recebidos (R$)</label><input class="field" id="dividends" name="dividends" type="number" min="0" step="0.01" placeholder="0,00"></div>
          <button class="btn-primary sm:col-span-2" type="submit">${icon("save", 15)}Salvar posição</button>
        </form>
        <div class="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-black/10 p-4">
          <div><p class="text-xs font-semibold">Dividendos para reinvestir</p><p class="mt-1 text-sm font-bold text-emerald-200">${money(pending)}</p></div>
          <button class="btn-secondary" type="button" data-action="reinvest" ${pending <= 0 || price <= 0 ? "disabled" : ""}>${icon("repeat-2", 15)}Reinvestir${price > 0 ? ` · ${number(pending / price)} cotas` : ""}</button>
        </div>
        ${price <= 0 && pending > 0 ? `<p class="mt-3 text-[11px] text-amber-200/80">Informe o preço da cota para calcular o reinvestimento.</p>` : ""}
      </article>
    </section>
    <section class="card mt-5 p-5 sm:p-6">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div><h2 class="font-display text-base font-bold">Estratégia de aportes</h2><p class="mt-1 text-xs leading-relaxed text-stone-500">Aporte de ${money(computedMonth().monthlySavings)} até fevereiro de ${today.getMonth() <= 1 ? today.getFullYear() : today.getFullYear() + 1} e faculdade de ${money(state.settings.uninter)} por mês. Ajuste esses valores conforme sua margem desejada.</p></div>
        <span class="pill">Margem projetada: ${money(computedMonth().free)}</span>
      </div>
      <form id="budget-form" class="mt-5 grid gap-4 border-t border-line pt-5 sm:grid-cols-3">
        <div><label class="field-label" for="base-income">Renda base de ${selectedMonthLabel} (R$)</label><input class="field" id="base-income" name="baseIncome" type="number" min="0" step="0.01" value="${Number(state.monthlyBudget?.baseIncome) || 0}" required><p class="mt-1 text-[11px] text-stone-500">Este valor é exclusivo do período selecionado.</p></div>
        <div><label class="field-label" for="uninter">Faculdade Uninter mensal (R$)</label><input class="field" id="uninter" name="uninter" type="number" min="0" step="0.01" value="${Number(state.settings.uninter) || 0}"></div>
        <button class="btn-secondary self-end" type="submit">${icon("save", 15)}Salvar orçamento</button>
      </form>
    </section>
    ${projection}`);
}

function authPage() {
  return `<main class="auth-bg flex min-h-screen items-center justify-center px-4 py-10">
    <section class="auth-card p-6 sm:p-9">
      <a href="/login" data-route="/login" class="mb-8 flex items-center gap-3">
        <span class="brand-mark">${icon("trending-up", 19)}</span><span class="font-display text-lg font-extrabold">Vértice<span class="text-violet-300">.</span></span>
      </a>
      <p class="mb-2 text-[11px] font-bold uppercase tracking-[.16em] text-violet-300">Finanças pessoais</p>
      <h1 class="font-display text-2xl font-extrabold">Bem-vindo de volta</h1>
      <p class="mt-2 text-sm text-stone-400">Acesse seu controle financeiro e patrimônio.</p>
      <form id="login-form" class="mt-7 grid gap-4">
        <div><label class="field-label" for="auth-email">E-mail</label><input class="field" id="auth-email" name="email" type="email" autocomplete="email" required></div>
        <div><label class="field-label" for="auth-password">Senha</label><input class="field" id="auth-password" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn-primary mt-1 w-full" type="submit">Entrar ${icon("arrow-right", 16)}</button>
      </form>
      <p id="login-error" class="mt-3 hidden text-sm leading-relaxed text-rose-300" role="alert" aria-live="polite"></p>
      <p class="mt-6 text-center text-[10px] leading-relaxed text-stone-600">Entre com sua conta para acessar seu controle financeiro.</p>
    </section>
  </main>`;
}

function renderChart() {
  const canvas = document.querySelector("#category-chart");
  if (!canvas || !window.Chart) return;
  const categoryTotals = new Map();
  selectedMonthTransactions().filter((item) => item.type === "expense"
    && (!item.isFixedCommitment || item.isPaid)
    && (!item.isInvestmentContribution || item.isPaid)).forEach((item) => {
    categoryTotals.set(item.category, (categoryTotals.get(item.category) || 0) + Number(item.amount));
  });
  if (state.chart) state.chart.destroy();
  state.chart = new window.Chart(canvas, {
    type: "doughnut",
    data: {
      labels: [...categoryTotals.keys()],
      datasets: [{
        data: [...categoryTotals.values()],
        backgroundColor: ["#8178ff", "#56cda0", "#f7b955", "#f47d9b", "#56a8f3", "#b687ff", "#f28a5b", "#52c3d4", "#8791a8"],
        borderColor: "#18152c",
        borderWidth: 3,
        hoverOffset: 5
      }]
    },
    options: {
      maintainAspectRatio: false,
      cutout: "70%",
      plugins: {
        legend: { position: "right", labels: { color: "#b7b2cc", usePointStyle: true, pointStyle: "circle", boxWidth: 7, padding: 15, font: { family: "DM Sans", size: 11 } } },
        tooltip: { callbacks: { label: (context) => ` ${context.label}: ${money(context.raw)}` } }
      }
    }
  });
}

function startCountdownTimer() {
  if (countdownTimer !== null) window.clearInterval(countdownTimer);
  if (!document.querySelector("[data-countdown-target]")) {
    countdownTimer = null;
    return;
  }
  const update = () => {
    document.querySelectorAll("[data-countdown-target]").forEach((element) => {
      const target = Number(element.dataset.countdownTarget);
      if (!Number.isFinite(target)) return;
      const seconds = Math.max(0, Math.floor((target - Date.now()) / 1000));
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const remainder = seconds % 60;
      element.textContent = seconds === 0
        ? "Vencimento atingido"
        : `${days} d ${String(hours).padStart(2, "0")} h ${String(minutes).padStart(2, "0")} min ${String(remainder).padStart(2, "0")} s`;
    });
  };
  update();
  countdownTimer = window.setInterval(update, 1000);
}

function render() {
  if (!state.user) {
    if (countdownTimer !== null) window.clearInterval(countdownTimer);
    countdownTimer = null;
    appRoot.innerHTML = authPage();
    refreshIcons();
    return;
  }
  if (!state.dataReady) {
    appRoot.innerHTML = `<div class="boot-screen"><span class="spinner"></span><span>Carregando seus dados</span></div>`;
    return;
  }
  if (!["/dashboard", "/lancamentos", "/compromissos", "/patrimonio"].includes(state.page)) {
    navigate("/dashboard");
    return;
  }
  if (state.page === "/dashboard") appRoot.innerHTML = dashboardPage();
  else if (state.page === "/lancamentos") appRoot.innerHTML = transactionsPage();
  else if (state.page === "/compromissos") appRoot.innerHTML = commitmentsPage();
  else appRoot.innerHTML = assetsPage();
  refreshIcons();
  renderChart();
  startCountdownTimer();
}

async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await setDoc(settingsRef(), state.settings, { merge: true });
  render();
}

async function startUserData(user) {
  state.unsubs.forEach((unsubscribe) => unsubscribe());
  state.unsubs = [];
  monthlyBudgetUnsub?.();
  monthlyBudgetUnsub = null;
  monthlyBudgetSubscriptionKey = null;
  state.dataReady = false;
  state.transactions = [];
  state.commitments = [];
  state.investments = [];
  state.monthlyBudget = null;
  state.assets = { savingsBalance: 0, mxrfShares: 0, mxrfPrice: 0, pendingDividends: 0 };
  state.settings = {
    savingsGoal: 5000,
    monthlySavings: 200,
    uninter: 200,
    cdiAnnualRate: 0
  };
  render();

  try {
    const month = selectedMonthInput();
    const [settingsSnap, assetsSnap, monthlyBudgetSnap] = await Promise.all([
      getDoc(settingsRef()),
      getDoc(assetsRef()),
      getDoc(monthlyBudgetRef(month))
    ]);
    if (auth.currentUser?.uid !== user.uid) return;
    if (settingsSnap.exists()) state.settings = { ...state.settings, ...settingsSnap.data() };
    if (assetsSnap.exists()) state.assets = { ...state.assets, ...assetsSnap.data() };
    const hasLegacyBaseIncome = Object.prototype.hasOwnProperty.call(state.settings, "baseIncome");
    if (monthlyBudgetSnap.exists()) {
      state.monthlyBudget = monthlyBudgetSnap.data();
    } else if (hasLegacyBaseIncome && Number.isFinite(Number(state.settings.baseIncome)) && Number(state.settings.baseIncome) >= 0) {
      state.monthlyBudget = { month, baseIncome: Number(state.settings.baseIncome) };
      await setDoc(monthlyBudgetRef(month), { ...state.monthlyBudget, updatedAt: new Date().toISOString() }, { merge: true });
    }
    if (hasLegacyBaseIncome) {
      delete state.settings.baseIncome;
      await setDoc(settingsRef(), { baseIncome: deleteField(), updatedAt: new Date().toISOString() }, { merge: true });
    }
    if (Array.isArray(state.settings.installments) && !state.settings.legacyInstallmentsMigratedAt) {
      const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
      const batch = writeBatch(db);
      let migrated = 0;
      state.settings.installments.forEach((item, index) => {
        const monthlyAmount = Number(item.amount) || 0;
        const durationMonths = Number(item.months) || 0;
        if (monthlyAmount <= 0 || !Number.isInteger(durationMonths) || durationMonths < 1) return;
        batch.set(doc(commitmentsPath(), `legacy-installment-${index}`), {
          name: String(item.name || "Parcela migrada"),
          category: "Outros",
          monthlyAmount,
          startMonth: month,
          durationMonths,
          adjustments: [],
          paidMonths: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        migrated++;
      });
      if (migrated) await batch.commit();
      await setDoc(settingsRef(), {
        installments: deleteField(),
        legacyInstallmentsMigratedAt: new Date().toISOString()
      }, { merge: true });
      delete state.settings.installments;
      state.settings.legacyInstallmentsMigratedAt = true;
    }
    if (!Number.isFinite(toMonthKey(state.settings.uninterStartMonth))) {
      const uninterStartMonth = monthKeyToInput(monthKey(today.getFullYear(), today.getMonth()));
      await setDoc(settingsRef(), { uninterStartMonth, updatedAt: new Date().toISOString() }, { merge: true });
      state.settings.uninterStartMonth = uninterStartMonth;
    }
  } catch (error) {
    reportError(error, "Não foi possível carregar as configurações financeiras.");
    return;
  }
  state.dataReady = true;
  subscribeSelectedMonthBudget();
  state.unsubs.push(onSnapshot(userPath("transacoes"), (snapshot) => {
    state.transactions = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    render();
  }, reportError));
  state.unsubs.push(onSnapshot(commitmentsPath(), (snapshot) => {
    state.commitments = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    render();
  }, reportError));
  state.unsubs.push(onSnapshot(investmentsPath(), (snapshot) => {
    state.investments = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    render();
  }, reportError));
  state.unsubs.push(onSnapshot(assetsRef(), (snapshot) => {
    if (snapshot.exists()) state.assets = { ...state.assets, ...snapshot.data() };
    render();
  }, reportError));
  state.unsubs.push(onSnapshot(settingsRef(), (snapshot) => {
    if (snapshot.exists()) state.settings = { ...state.settings, ...snapshot.data() };
    render();
  }, reportError));
  render();
}

appRoot.addEventListener("click", async (event) => {
  const routeLink = event.target.closest("[data-route]");
  if (routeLink) {
    event.preventDefault();
    navigate(routeLink.dataset.route);
    return;
  }
  const actionElement = event.target.closest("[data-action]");
  if (!actionElement) return;
  const action = actionElement.dataset.action;
  try {
    if (action === "toggle-drawer") {
      state.drawerOpen = true;
      render();
    } else if (action === "close-drawer") {
      state.drawerOpen = false;
      render();
    } else if (action === "signout") {
      await signOut(auth);
    } else if (action === "previous-month") {
      shiftSelectedMonth(-1);
    } else if (action === "next-month") {
      shiftSelectedMonth(1);
    } else if (action === "delete-commitment") {
      const commitment = commitmentsForDisplay().find((item) => item.id === actionElement.dataset.id);
      if (!commitment) throw new Error("O compromisso não foi encontrado.");
      const scope = commitment.isUninterFallback
        ? "Excluir Faculdade Uninter e todo o seu histórico de pagamentos e reajustes?"
        : "Excluir este compromisso e seu histórico de pagamentos?";
      if (!window.confirm(scope)) return;
      if (commitment.isUninterFallback) {
        await setDoc(settingsRef(), {
          uninter: 0,
          uninterAdjustments: deleteField(),
          uninterDateOverrides: deleteField(),
          uninterPaidMonths: deleteField(),
          uninterStartMonth: deleteField(),
          uninterEndMonth: deleteField(),
          uninterEndedAt: deleteField(),
          uninterCategory: deleteField(),
          uninterDescription: deleteField(),
          updatedAt: new Date().toISOString()
        }, { merge: true });
        const {
          uninterAdjustments,
          uninterDateOverrides,
          uninterPaidMonths,
          uninterStartMonth,
          uninterEndMonth,
          uninterEndedAt,
          uninterCategory,
          uninterDescription,
          ...remainingSettings
        } = state.settings;
        state.settings = { ...remainingSettings, uninter: 0 };
      } else {
        await deleteDoc(doc(commitmentsPath(), commitment.id));
        state.commitments = state.commitments.filter((item) => item.id !== commitment.id);
      }
      render();
      toast("Compromisso excluído.");
    } else if (action === "end-commitment") {
      const commitment = commitmentsForDisplay().find((item) => item.id === actionElement.dataset.id);
      if (!commitment) throw new Error("O compromisso não foi encontrado.");
      if (commitment.termType !== "ongoing" || Number.isFinite(commitmentEndKey(commitment))) {
        throw new Error("Somente planos contínuos ainda ativos podem ser encerrados manualmente.");
      }
      const currentDate = new Date();
      const currentMonth = monthKeyToInput(monthKey(currentDate.getFullYear(), currentDate.getMonth()));
      if (!window.confirm(`Encerrar ${commitment.name} ao fim de ${currentMonth}? Não haverá projeções nos meses seguintes.`)) return;
      const patch = { endMonth: currentMonth, endedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      if (commitment.isUninterFallback) {
        await setDoc(settingsRef(), { uninterEndMonth: currentMonth, uninterEndedAt: patch.endedAt, updatedAt: patch.updatedAt }, { merge: true });
        state.settings = { ...state.settings, uninterEndMonth: currentMonth };
      } else {
        await updateDoc(doc(commitmentsPath(), commitment.id), patch);
        state.commitments = state.commitments.map((item) => item.id === commitment.id ? { ...item, ...patch } : item);
      }
      render();
      toast("Plano encerrado. Não haverá recorrências após este mês.");
    } else if (action === "toggle-commitment-payment") {
      const commitment = commitmentsForDisplay().find((item) => item.id === actionElement.dataset.id);
      if (!commitment) throw new Error("O compromisso não foi encontrado.");
      const month = actionElement.dataset.month;
      const paymentKey = toMonthKey(month);
      if (!Number.isFinite(paymentKey) || !isCommitmentActiveAt(commitment, paymentKey)) {
        throw new Error("Este período não está dentro da vigência do compromisso.");
      }
      const paidMonths = Array.isArray(commitment.paidMonths) ? commitment.paidMonths : [];
      const nextPaidMonths = paidMonths.includes(month)
        ? paidMonths.filter((paidMonth) => paidMonth !== month)
        : [...paidMonths, month];
      const updatedAt = new Date().toISOString();
      if (commitment.isUninterFallback) {
        await setDoc(settingsRef(), { uninterPaidMonths: nextPaidMonths, updatedAt }, { merge: true });
        state.settings = { ...state.settings, uninterPaidMonths: nextPaidMonths };
      } else {
        await updateDoc(doc(commitmentsPath(), commitment.id), { paidMonths: nextPaidMonths, updatedAt });
        state.commitments = state.commitments.map((item) => item.id === commitment.id ? { ...item, paidMonths: nextPaidMonths } : item);
      }
      render();
      toast(nextPaidMonths.includes(month) ? "Parcela marcada como paga." : "Pagamento desmarcado.");
    } else if (action === "toggle-investment-payment") {
      const investment = state.investments.find((item) => item.id === actionElement.dataset.id);
      if (!investment) throw new Error("O aporte não foi encontrado.");
      const isPaid = investment.isPaid === false;
      const patch = { isPaid, updatedAt: new Date().toISOString() };
      await updateDoc(doc(investmentsPath(), investment.id), patch);
      state.investments = state.investments.map((item) => item.id === investment.id ? { ...item, ...patch } : item);
      render();
      toast(isPaid ? "Aporte marcado como pago." : "Aporte marcado como pendente.");
    } else if (action === "edit-commitment-period") {
      const month = actionElement.dataset.month;
      const monthKeyValue = toMonthKey(month);
      if (Number.isFinite(monthKeyValue)) {
        state.year = Math.floor(monthKeyValue / 12);
        state.month = monthKeyValue % 12;
      }
      const item = selectedMonthTransactions().find((transaction) =>
        transaction.id === actionElement.dataset.id && transaction.isFixedCommitment
      );
      if (!item) throw new Error("O compromisso não está vigente no período selecionado.");
      state.editModal = { item: { ...item }, kind: item.isUninterFallback ? "uninter" : "commitment" };
      render();
      document.querySelector("#ledger-edit-amount")?.focus();
    } else if (action === "edit-ledger-item") {
      const kind = actionElement.dataset.kind;
      const item = selectedMonthTransactions().find((transaction) => transaction.id === actionElement.dataset.id && (
        kind === "uninter" ? transaction.isUninterFallback :
          kind === "commitment" ? transaction.isFixedCommitment && !transaction.isUninterFallback :
            kind === "investment" ? transaction.isInvestmentContribution :
            kind === "installment" ? transaction.isProjectedInstallment :
              !transaction.isFixedCommitment && !transaction.isInvestmentContribution && !transaction.isProjectedInstallment
      ));
      if (!item) throw new Error("O lançamento não foi encontrado neste período.");
      state.editModal = { item: { ...item }, kind };
      render();
      document.querySelector("#ledger-edit-amount")?.focus();
    } else if (action === "delete-ledger-item") {
      const id = actionElement.dataset.id;
      const kind = actionElement.dataset.kind;
      const item = selectedMonthTransactions().find((transaction) => transaction.id === id && (
        kind === "uninter" ? transaction.isUninterFallback :
          kind === "commitment" ? transaction.isFixedCommitment && !transaction.isUninterFallback :
            kind === "investment" ? transaction.isInvestmentContribution :
            kind === "installment" ? transaction.isProjectedInstallment :
              !transaction.isFixedCommitment && !transaction.isInvestmentContribution && !transaction.isProjectedInstallment
      ));
      const label = item?.description || item?.name || "este lançamento";
      const scope = kind === "installment" ? " e todas as parcelas desta compra" : kind === "commitment" ? " e todo o histórico deste compromisso" : "";
      if (!window.confirm(`Excluir ${label}${scope}?`)) return;
      if (kind === "uninter") {
        const effectiveMonth = monthKeyToInput(selectedMonthKey());
        const uninterAdjustments = replacePeriodEntry(state.settings.uninterAdjustments, effectiveMonth, { monthlyAmount: 0 });
        await setDoc(settingsRef(), { uninterAdjustments, updatedAt: new Date().toISOString() }, { merge: true });
        state.settings = { ...state.settings, uninterAdjustments };
      } else if (kind === "commitment") {
        await deleteDoc(doc(commitmentsPath(), id));
        state.commitments = state.commitments.filter((commitment) => commitment.id !== id);
      } else if (kind === "investment") {
        await deleteDoc(doc(investmentsPath(), id));
        state.investments = state.investments.filter((investment) => investment.id !== id);
      } else {
        await deleteDoc(doc(userPath("transacoes"), id));
        state.transactions = state.transactions.filter((transaction) => transaction.id !== id);
      }
      render();
      toast("Lançamento excluído.");
    } else if (action === "close-ledger-modal") {
      if (actionElement.id === "ledger-edit-backdrop" && event.target !== actionElement) return;
      state.editModal = null;
      render();
    } else if (action === "clear-import") {
      state.importPreview = null;
      render();
    } else if (action === "approve-import") {
      const selectedIndexes = [...document.querySelectorAll("[data-import-index]:checked")]
        .map((input) => Number(input.dataset.importIndex));
      if (!selectedIndexes.length) throw new Error("Selecione ao menos um lançamento para importar.");
      const selectedItems = selectedIndexes.map((index) => state.importPreview?.items[index]).filter(Boolean);
      const batch = writeBatch(db);
      const timestamp = new Date().toISOString();
      selectedItems.forEach((item) => {
        const transactionRef = doc(userPath("transacoes"));
        batch.set(transactionRef, {
          type: item.type,
          amount: item.amount,
          category: item.category || "Outros",
          date: item.date,
          description: item.description,
          createdAt: timestamp,
          updatedAt: timestamp,
          importSource: state.importPreview.filename
        });
      });
      await batch.commit();
      state.importPreview = null;
      toast(`${selectedItems.length} lançamento(s) importado(s).`);
      render();
    } else if (action === "quick-add") {
      state.editingId = null;
      state.quickAddOpen = true;
      render();
      document.querySelector("#transaction-amount")?.focus();
    } else if (action === "close-quick-add") {
      state.editingId = null;
      state.quickAddOpen = false;
      render();
    } else if (action === "cancel-edit") {
      state.editingId = null;
      state.quickAddOpen = false;
      render();
    } else if (action === "edit-transaction") {
      state.editingId = actionElement.dataset.id;
      state.quickAddOpen = true;
      render();
      document.querySelector("#transaction-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
      document.querySelector("#transaction-amount")?.focus();
    } else if (action === "reinvest") {
      const currentPrice = Number(state.assets.mxrfPrice);
      const pending = Number(state.assets.pendingDividends);
      if (currentPrice <= 0 || pending <= 0) return;
      await updateDoc(assetsRef(), {
        mxrfShares: Number(state.assets.mxrfShares) + pending / currentPrice,
        pendingDividends: 0,
        updatedAt: new Date().toISOString()
      });
      toast("Dividendos reinvestidos na posição de MXRF11.");
    }
  } catch (error) {
    if (action === "toggle-commitment-payment" || action === "toggle-investment-payment") render();
    reportError(error);
  }
});

appRoot.addEventListener("change", (event) => {
  if (event.target.id === "statement-file") {
    const [file] = event.target.files || [];
    if (file) void loadStatementFile(file);
  } else if (event.target.hasAttribute("data-import-index")) {
    const index = Number(event.target.dataset.importIndex);
    if (state.importPreview?.items[index]) state.importPreview.items[index].selected = event.target.checked;
  } else if (event.target.id === "period-month") {
    const [year, month] = event.target.value.split("-").map(Number);
    if (year && month >= 1 && month <= 12) {
      state.year = year;
      state.month = month - 1;
      subscribeSelectedMonthBudget();
    }
    render();
  } else if (event.target.id === "transaction-kind" || event.target.id === "transaction-type" || event.target.id === "transaction-value-mode") {
    const typeInput = document.querySelector("#transaction-type");
    const kindInput = document.querySelector("#transaction-kind");
    const modeInput = document.querySelector("#transaction-value-mode");
    const modeWrap = document.querySelector("#transaction-value-mode-wrap");
    const countWrap = document.querySelector("#transaction-count-wrap");
    const countInput = document.querySelector("#transaction-count");
    const amountLabel = document.querySelector("#transaction-amount-label");
    const installmentOption = kindInput.querySelector('option[value="installment"]');
    installmentOption.disabled = typeInput.value === "income";
    if (typeInput.value === "income") kindInput.value = "single";
    const isInstallment = kindInput.value === "installment";
    modeWrap.classList.toggle("hidden", !isInstallment);
    countWrap.classList.toggle("hidden", !isInstallment);
    countInput.disabled = !isInstallment;
    countInput.required = isInstallment;
    amountLabel.textContent = isInstallment
      ? modeInput.value === "installment" ? "Valor da parcela (R$)" : "Valor total (R$)"
      : "Valor (R$)";
  } else if (event.target.id === "commitment-term-type") {
    const ongoing = event.target.value === "ongoing";
    const durationWrap = document.querySelector("#commitment-duration-wrap");
    const durationInput = document.querySelector("#commitment-duration");
    durationWrap.classList.toggle("hidden", ongoing);
    durationInput.disabled = ongoing;
    durationInput.required = !ongoing;
  }
});

async function loadStatementFile(file) {
  try {
    const items = await parseStatementFile(file);
    state.importPreview = { filename: file.name, items: items.map((item) => ({ ...item, selected: true })) };
    render();
  } catch (error) {
    reportError(error, "Não foi possível ler o extrato.");
  }
}

async function saveLedgerEdit(formData) {
  const id = String(formData.get("id"));
  const kind = String(formData.get("kind"));
  const amount = Number(formData.get("amount"));
  const date = String(formData.get("date"));
  const category = String(formData.get("category") || "Outros");
  const description = String(formData.get("description") || "").trim();
  const effectiveMonth = monthKeyToInput(selectedMonthKey());
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Informe um valor maior que zero.");
  if (!date || !description) throw new Error("Informe data e descrição.");

  if (kind === "installment" || kind === "commitment" || kind === "uninter" || kind === "investment") {
    if (date.slice(0, 7) !== effectiveMonth) {
      throw new Error("Para manter o histórico, a data desta alteração deve permanecer no período selecionado.");
    }
  }

  if (kind === "uninter") {
    const uninterAdjustments = replacePeriodEntry(state.settings.uninterAdjustments, effectiveMonth, { monthlyAmount: amount });
    const uninterDateOverrides = replacePeriodEntry(state.settings.uninterDateOverrides, effectiveMonth, { date });
    const uninterCategory = category;
    const uninterDescription = description;
    await setDoc(settingsRef(), { uninterAdjustments, uninterDateOverrides, uninterCategory, uninterDescription, updatedAt: new Date().toISOString() }, { merge: true });
    state.settings = { ...state.settings, uninterAdjustments, uninterDateOverrides, uninterCategory, uninterDescription };
  } else if (kind === "commitment") {
    const commitment = state.commitments.find((item) => item.id === id);
    if (!commitment) throw new Error("O compromisso não foi encontrado.");
    const adjustments = replacePeriodEntry(commitment.adjustments, effectiveMonth, { monthlyAmount: amount });
    const dateOverrides = replacePeriodEntry(commitment.dateOverrides, effectiveMonth, { date });
    const patch = { name: description, category, adjustments, dateOverrides, updatedAt: new Date().toISOString() };
    await updateDoc(doc(commitmentsPath(), id), patch);
    state.commitments = state.commitments.map((item) => item.id === id ? { ...item, ...patch } : item);
  } else if (kind === "investment") {
    const investment = state.investments.find((item) => item.id === id);
    if (!investment) throw new Error("O aporte não foi encontrado.");
    const patch = { amount, date, category, description, updatedAt: new Date().toISOString() };
    await updateDoc(doc(investmentsPath(), id), patch);
    state.investments = state.investments.map((item) => item.id === id ? { ...item, ...patch } : item);
  } else {
    const transaction = state.transactions.find((item) => item.id === id);
    if (!transaction) throw new Error("O lançamento não foi encontrado.");
    let patch = { amount, date, category, description, updatedAt: new Date().toISOString() };
    if (kind === "installment") {
      const amountCents = Math.round(amount * 100);
      const installmentAdjustments = replacePeriodEntry(transaction.installmentAdjustments, effectiveMonth, { amountCents });
      const installmentDateOverrides = replacePeriodEntry(transaction.installmentDateOverrides, effectiveMonth, { date });
      patch = {
        category,
        description,
        installmentAdjustments,
        installmentDateOverrides,
        updatedAt: new Date().toISOString()
      };
    }
    await updateDoc(doc(userPath("transacoes"), id), patch);
    state.transactions = state.transactions.map((item) => item.id === id ? { ...item, ...patch } : item);
  }

  state.editModal = null;
  render();
  toast("Lançamento atualizado.");
}

appRoot.addEventListener("dragover", (event) => {
  const dropzone = event.target.closest("#statement-dropzone");
  if (!dropzone) return;
  event.preventDefault();
  dropzone.classList.add("dragging");
});

appRoot.addEventListener("dragleave", (event) => {
  const dropzone = event.target.closest("#statement-dropzone");
  if (dropzone && !dropzone.contains(event.relatedTarget)) dropzone.classList.remove("dragging");
});

appRoot.addEventListener("drop", (event) => {
  const dropzone = event.target.closest("#statement-dropzone");
  if (!dropzone) return;
  event.preventDefault();
  dropzone.classList.remove("dragging");
  const [file] = event.dataTransfer?.files || [];
  if (file) void loadStatementFile(file);
});

appRoot.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  try {
    if (form.id === "ledger-edit-form") {
      await saveLedgerEdit(formData);
    } else if (form.id === "login-form") {
      const emailInput = form.querySelector("#auth-email");
      const passwordInput = form.querySelector("#auth-password");
      const loginError = document.querySelector("#login-error");
      loginError.textContent = "";
      loginError.classList.add("hidden");
      try {
        await signInWithEmailAndPassword(auth, emailInput.value, passwordInput.value);
      } catch (error) {
        loginError.textContent = error.message;
        loginError.classList.remove("hidden");
      }
    } else if (form.id === "commitment-form") {
      const monthlyAmount = Number(formData.get("monthlyAmount"));
      const durationMonths = Number(formData.get("durationMonths"));
      const startMonth = String(formData.get("startMonth"));
      const termType = String(formData.get("termType"));
      const dueDay = Number(formData.get("dueDay"));
      const name = String(formData.get("name") || "").trim();
      if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) throw new Error("Informe um valor mensal válido.");
      if (!name) throw new Error("Informe o nome do compromisso.");
      if (!Number.isFinite(toMonthKey(startMonth))) throw new Error("Selecione o mês de início.");
      if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) throw new Error("O dia de vencimento deve estar entre 1 e 31.");
      if (!["fixed", "ongoing"].includes(termType)) throw new Error("Selecione uma vigência válida.");
      if (termType === "fixed" && (!Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 600)) {
        throw new Error("A duração deve ser de 1 a 600 parcelas.");
      }
      await addDoc(commitmentsPath(), {
        name,
        category: String(formData.get("category") || "Outros"),
        monthlyAmount,
        startMonth,
        dueDay,
        termType,
        durationMonths: termType === "fixed" ? durationMonths : null,
        adjustments: [],
        paidMonths: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      toast("Compromisso cadastrado.");
    } else if (form.id === "commitment-adjustment-form") {
      const commitmentId = String(formData.get("commitmentId"));
      const commitment = state.commitments.find((item) => item.id === commitmentId);
      if (!commitment) throw new Error("O compromisso não foi encontrado.");
      const effectiveMonth = String(formData.get("effectiveMonth"));
      const monthlyAmount = Number(formData.get("monthlyAmount"));
      const effectiveKey = toMonthKey(effectiveMonth);
      const endKey = commitmentEndKey(commitment);
      if (!Number.isFinite(effectiveKey) || effectiveKey < toMonthKey(commitment.startMonth) || (Number.isFinite(endKey) && effectiveKey > endKey)) {
        throw new Error("O reajuste precisa estar dentro do período do compromisso.");
      }
      if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) throw new Error("Informe um novo valor mensal válido.");
      const adjustments = (Array.isArray(commitment.adjustments) ? commitment.adjustments : [])
        .filter((item) => item.effectiveMonth !== effectiveMonth)
        .concat({ effectiveMonth, monthlyAmount })
        .sort((a, b) => toMonthKey(a.effectiveMonth) - toMonthKey(b.effectiveMonth));
      const patch = { adjustments, updatedAt: new Date().toISOString() };
      await updateDoc(doc(commitmentsPath(), commitmentId), patch);
      state.commitments = state.commitments.map((item) => item.id === commitmentId ? { ...item, ...patch } : item);
      render();
      toast("Reajuste registrado.");
    } else if (form.id === "transaction-form") {
      const rawAmount = Number(formData.get("amount"));
      if (!Number.isFinite(rawAmount) || rawAmount <= 0) throw new Error("Informe um valor maior que zero.");
      const type = String(formData.get("type"));
      const isInstallment = type === "expense" && formData.get("kind") === "installment";
      const date = String(formData.get("date"));
      const baseTransaction = {
        type,
        category: String(formData.get("category")),
        date,
        description: String(formData.get("description") || "").trim(),
        updatedAt: new Date().toISOString()
      };
      let transaction = { ...baseTransaction, amount: rawAmount };

      if (isInstallment) {
        const count = Number(formData.get("installmentCount"));
        if (!Number.isInteger(count) || count < 2 || count > 600) {
          throw new Error("Informe de 2 a 600 parcelas.");
        }
        const enteredCents = Math.round(rawAmount * 100);
        const valueMode = String(formData.get("valueMode"));
        const installmentBaseCents = valueMode === "installment" ? enteredCents : Math.floor(enteredCents / count);
        const installmentRemainderCents = valueMode === "installment" ? 0 : enteredCents % count;
        const installmentTotalCents = valueMode === "installment" ? enteredCents * count : enteredCents;
        if (installmentBaseCents < 1 || !Number.isSafeInteger(installmentTotalCents)) {
          throw new Error("O valor não pode ser dividido entre as parcelas informadas.");
        }
        transaction = {
          ...baseTransaction,
          amount: installmentTotalCents / 100,
          isInstallment: true,
          installmentCount: count,
          installmentValueMode: valueMode,
          installmentTotalCents,
          installmentBaseCents,
          installmentRemainderCents
        };
      }

      if (state.editingId) {
        if (!isInstallment && state.transactions.find((item) => item.id === state.editingId)?.isInstallment) {
          Object.assign(transaction, {
            isInstallment: deleteField(),
            installmentCount: deleteField(),
            installmentValueMode: deleteField(),
            installmentTotalCents: deleteField(),
            installmentBaseCents: deleteField(),
            installmentRemainderCents: deleteField()
          });
        }
        await updateDoc(doc(db, "users", state.user.uid, "transacoes", state.editingId), transaction);
      } else {
        await addDoc(userPath("transacoes"), { ...transaction, createdAt: new Date().toISOString() });
      }
      const selectedDate = transactionDate({ date });
      state.year = selectedDate.getFullYear();
      state.month = selectedDate.getMonth();
      state.editingId = null;
      state.quickAddOpen = false;
      toast("Lançamento salvo.");
      render();
    } else if (form.id === "investment-form") {
      const amount = Number(formData.get("amount"));
      const date = String(formData.get("date") || "");
      const description = String(formData.get("description") || "").trim();
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Informe um valor de aporte maior que zero.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !description) throw new Error("Informe a data e a descrição do aporte.");
      const investment = {
        type: "expense",
        amount,
        category: String(formData.get("category") || "Outros investimentos"),
        date,
        description,
        isPaid: formData.get("isPaid") === "on",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      const reference = await addDoc(investmentsPath(), investment);
      state.investments = [...state.investments, { id: reference.id, ...investment }];
      const selectedDate = transactionDate({ date });
      state.year = selectedDate.getFullYear();
      state.month = selectedDate.getMonth();
      toast(investment.isPaid ? "Aporte registrado e contabilizado." : "Aporte pendente registrado.");
      render();
    } else if (form.id === "savings-form") {
      const savingsBalance = Math.max(0, Number(formData.get("savingsBalance")) || 0);
      const savingsGoal = Math.max(1, Number(formData.get("savingsGoal")) || 5000);
      const monthlySavings = Math.max(0, Number(formData.get("monthlySavings")) || 0);
      const cdiAnnualRate = Math.min(100, Math.max(0, Number(formData.get("cdiAnnualRate")) || 0));
      await Promise.all([
        setDoc(assetsRef(), { ...state.assets, savingsBalance, updatedAt: new Date().toISOString() }, { merge: true }),
        saveSettings({ savingsGoal, monthlySavings, cdiAnnualRate })
      ]);
      toast("Caixinha atualizada.");
    } else if (form.id === "mxrf-form") {
      const mxrfShares = Math.max(0, Number(formData.get("mxrfShares")) || 0);
      const mxrfPrice = Math.max(0, Number(formData.get("mxrfPrice")) || 0);
      const dividends = Math.max(0, Number(formData.get("dividends")) || 0);
      await setDoc(assetsRef(), {
        ...state.assets,
        mxrfShares,
        mxrfPrice,
        pendingDividends: (Number(state.assets.pendingDividends) || 0) + dividends,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      toast("Posição de MXRF11 atualizada.");
    } else if (form.id === "budget-form") {
      const baseIncome = Number(formData.get("baseIncome"));
      const uninter = Number(formData.get("uninter"));
      if (!Number.isFinite(baseIncome) || baseIncome < 0) throw new Error("Informe uma renda base válida para o período.");
      if (!Number.isFinite(uninter) || uninter < 0) throw new Error("Informe um valor válido para a Faculdade Uninter.");
      const month = selectedMonthInput();
      await Promise.all([
        setDoc(monthlyBudgetRef(month), { month, baseIncome, updatedAt: new Date().toISOString() }, { merge: true }),
        saveSettings({ uninter })
      ]);
      state.monthlyBudget = { ...(state.monthlyBudget || {}), month, baseIncome };
      render();
      toast(`Orçamento de ${monthNames[state.month]} atualizado.`);
    } else if (form.id === "projection-goal-form") {
      const target = Number(formData.get("target"));
      if (!Number.isFinite(target) || target <= 0) throw new Error("Informe uma meta maior que zero.");
      await saveSettings({ projectionTarget: target });
      toast("Meta atualizada.");
    }
  } catch (error) {
    reportError(error);
  }
});

window.addEventListener("popstate", () => {
  state.page = location.pathname;
  render();
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    state.unsubs.forEach((unsubscribe) => unsubscribe());
    state.unsubs = [];
    monthlyBudgetUnsub?.();
    monthlyBudgetUnsub = null;
    monthlyBudgetSubscriptionKey = null;
    state.user = null;
    state.dataReady = false;
    state.transactions = [];
    state.commitments = [];
    state.investments = [];
    state.monthlyBudget = null;
    if (location.pathname !== "/login") history.replaceState({}, "", "/login");
    state.page = "/login";
    render();
    return;
  }
  state.user = user;
  if (location.pathname === "/login" || location.pathname === "/") {
    history.replaceState({}, "", "/dashboard");
    state.page = "/dashboard";
  } else {
    state.page = location.pathname;
  }
  await startUserData(user);
});
