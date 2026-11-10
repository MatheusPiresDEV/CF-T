import { commitmentAmountAt, commitmentEndKey, monthKeyToInput, toMonthKey } from "./fixed_commitments.js";

function monthlyReturn(balance, annualRate) {
  const cdi = Math.max(0, Number(annualRate) || 0) / 100;
  const monthlyCdi = Math.pow(1 + cdi, 1 / 12) - 1;
  const firstTier = Math.min(Math.max(0, balance), 5000);
  const secondTier = Math.max(0, balance - 5000);
  return firstTier * monthlyCdi * 1.2 + secondTier * monthlyCdi * 1.1;
}

function monthlyReleasedCommitments(commitments, key) {
  return commitments.reduce((sum, item) => {
    const endKey = commitmentEndKey(item);
    const paidMonths = Array.isArray(item.paidMonths) ? item.paidMonths : [];
    if (!Number.isFinite(endKey) || key <= endKey || !paidMonths.includes(monthKeyToInput(endKey))) return sum;
    return sum + commitmentAmountAt(item, endKey);
  }, 0);
}

export function projectGoal({
  balance,
  target,
  monthlyContribution,
  contributionThroughKey,
  commitments,
  annualCdiRate,
  startYear,
  startMonth
}) {
  const initialBalance = Math.max(0, Number(balance) || 0);
  const goal = Math.max(0, Number(target) || 0);
  if (goal <= initialBalance) return { months: 0, projectedBalance: initialBalance };

  let projectedBalance = initialBalance;
  const startKey = startYear * 12 + startMonth;
  for (let offset = 1; offset <= 1200; offset++) {
    const key = startKey + offset;
    const base = key <= contributionThroughKey ? Math.max(0, Number(monthlyContribution) || 0) : 0;
    const contribution = base + monthlyReleasedCommitments(commitments, key);
    projectedBalance += monthlyReturn(projectedBalance, annualCdiRate) + contribution;
    if (projectedBalance >= goal) return { months: offset, projectedBalance };
  }
  return { months: null, projectedBalance };
}

export function renderGoalProjection({ balance, target, settings, commitments, year, month, money, escapeHtml }) {
  const targetAmount = Number(target) > 0 ? Number(target) : Number(settings.savingsGoal) || 5000;
  const contributionThroughKey = (() => {
    const now = new Date();
    return now.getMonth() <= 1
      ? now.getFullYear() * 12 + 1
      : (now.getFullYear() + 1) * 12 + 1;
  })();
  const projection = projectGoal({
    balance,
    target: targetAmount,
    monthlyContribution: settings.monthlySavings,
    contributionThroughKey,
    commitments,
    annualCdiRate: settings.cdiAnnualRate,
    startYear: year,
    startMonth: month
  });
  let timing = "Meta ainda não alcançada no horizonte de 100 anos.";
  if (projection.months === 0) timing = "Meta já alcançada.";
  else if (projection.months !== null) {
    const due = new Date(year, month + projection.months, 1);
    const years = Math.floor(projection.months / 12);
    const months = projection.months % 12;
    const duration = [years ? `${years} ano(s)` : "", months ? `${months} mês(es)` : ""].filter(Boolean).join(" e ");
    timing = `Estimativa: ${duration} · ${due.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}.`;
  }

  return `<section class="card mt-5 p-5 sm:p-6">
    <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(260px,.8fr)] lg:items-center">
      <div>
        <div class="flex items-start gap-3"><span class="metric-icon"><i data-lucide="goal" width="18" height="18" aria-hidden="true"></i></span><div><h2 class="font-display text-base font-bold">Projeção de metas</h2><p class="mt-1 text-xs leading-relaxed text-stone-500">Considera saldo atual, aportes planejados, rendimento de referência e valores liberados ao fim dos compromissos.</p></div></div>
        <p class="mt-5 text-sm font-semibold text-violet-200">${escapeHtml(timing)}</p>
        <p class="mt-1 text-[11px] text-stone-500">Saldo projetado ao atingir a meta: ${money(projection.projectedBalance)}. Estimativa, sem garantia de rendimento.</p>
      </div>
      <form id="projection-goal-form" class="grid gap-3 rounded-xl border border-line bg-black/10 p-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <div><label class="field-label" for="projection-target">Meta de patrimônio (R$)</label><input class="field" id="projection-target" name="target" type="number" min="1" step="0.01" value="${targetAmount}" required></div>
        <button class="btn-primary" type="submit"><i data-lucide="calculator" width="15" height="15" aria-hidden="true"></i>Projetar</button>
      </form>
    </div>
  </section>`;
}
