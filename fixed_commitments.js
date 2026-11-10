const monthNames = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

export const toMonthKey = (value) => {
  const [year, month] = String(value || "").split("-").map(Number);
  return year && month >= 1 && month <= 12 ? year * 12 + month - 1 : NaN;
};

export const monthKeyToInput = (key) => {
  const date = new Date(Math.floor(key / 12), key % 12, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};

export function commitmentEndKey(commitment) {
  const start = toMonthKey(commitment.startMonth);
  const hasExplicitEnd = commitment.endMonth !== null && commitment.endMonth !== undefined && commitment.endMonth !== "";
  const explicitEnd = toMonthKey(commitment.endMonth);
  const duration = Number(commitment.durationMonths);
  if (hasExplicitEnd) return Number.isFinite(start) && Number.isFinite(explicitEnd) && explicitEnd >= start ? explicitEnd : NaN;
  return Number.isFinite(start) && Number.isInteger(duration) && duration > 0 ? start + duration - 1 : NaN;
}

export function isOpenEndedCommitment(commitment) {
  const duration = Number(commitment.durationMonths);
  return commitment.termType === "ongoing"
    && (commitment.endMonth === null || commitment.endMonth === undefined || commitment.endMonth === "")
    && !(Number.isInteger(duration) && duration > 0);
}

export function commitmentDuration(commitment) {
  const start = toMonthKey(commitment.startMonth);
  const end = commitmentEndKey(commitment);
  return Number.isFinite(start) && Number.isFinite(end) ? end - start + 1 : null;
}

export function isCommitmentActiveAt(commitment, monthKey) {
  const start = toMonthKey(commitment.startMonth);
  const end = commitmentEndKey(commitment);
  return Number.isFinite(start) && monthKey >= start
    && (Number.isFinite(end) ? monthKey <= end : isOpenEndedCommitment(commitment));
}

export function commitmentAmountAt(commitment, monthKey) {
  if (!isCommitmentActiveAt(commitment, monthKey)) return 0;
  const changes = Array.isArray(commitment.adjustments) ? commitment.adjustments : [];
  const applicable = changes
    .map((change) => ({ ...change, key: toMonthKey(change.effectiveMonth) }))
    .filter((change) => Number.isFinite(change.key) && change.key <= monthKey)
    .sort((a, b) => a.key - b.key);
  const initial = Number(commitment.monthlyAmount) || 0;
  return applicable.length ? Math.max(0, Number(applicable.at(-1).monthlyAmount) || 0) : initial;
}

export function getCommitmentsForMonth(commitments, year, month) {
  const key = year * 12 + month;
  const monthInput = monthKeyToInput(key);
  return commitments.flatMap((commitment) => {
    const amount = commitmentAmountAt(commitment, key);
    if (!amount) return [];
    const date = commitmentDueDate(commitment, monthInput);
    const paidMonths = Array.isArray(commitment.paidMonths) ? commitment.paidMonths : [];
    return [{
      ...commitment,
      amount,
      type: "expense",
      isFixedCommitment: true,
      commitmentMonth: monthInput,
      isPaid: paidMonths.includes(monthInput),
      date
    }];
  });
}

export function commitmentDueDate(commitment, month) {
  const override = (Array.isArray(commitment.dateOverrides) ? commitment.dateOverrides : [])
    .find((item) => item.effectiveMonth === month)?.date;
  if (override) return override;
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const day = Math.min(Math.max(1, Number(commitment.dueDay) || 1), lastDay);
  return `${month}-${String(day).padStart(2, "0")}`;
}

export function commitmentProgress(commitment, periodMonth = "") {
  const duration = commitmentDuration(commitment);
  const start = toMonthKey(commitment.startMonth);
  const end = commitmentEndKey(commitment);
  const paidMonths = Array.isArray(commitment.paidMonths) ? [...new Set(commitment.paidMonths)] : [];
  const validPaid = paidMonths.filter((month) => {
    const key = toMonthKey(month);
    return Number.isFinite(key) && key >= start
      && (Number.isFinite(end) ? key <= end : isOpenEndedCommitment(commitment));
  });
  let remainingCents = 0;
  if (duration !== null) {
    for (let key = start; key <= end; key++) {
      if (!validPaid.includes(monthKeyToInput(key))) {
        remainingCents += Math.round(commitmentAmountAt(commitment, key) * 100);
      }
    }
  }
  const paidInPeriod = validPaid.includes(periodMonth);
  return {
    duration,
    paid: validPaid.length,
    remaining: duration === null ? null : Math.max(0, duration - validPaid.length),
    remainingAmount: duration === null ? null : remainingCents / 100,
    percent: duration ? Math.min(100, validPaid.length / duration * 100) : paidInPeriod ? 100 : 0,
    paidMonths: validPaid,
    paidInPeriod
  };
}

function monthLabel(value) {
  const key = toMonthKey(value);
  if (!Number.isFinite(key)) return "Período inválido";
  const date = new Date(Math.floor(key / 12), key % 12, 1);
  return `${monthNames[date.getMonth()]} de ${date.getFullYear()}`;
}

export function renderDashboardCommitments({ commitments, year, month, money, escapeHtml, icon }) {
  const selectedKey = year * 12 + month;
  const selectedMonth = monthKeyToInput(selectedKey);
  const cards = commitments
    .filter((item) => commitmentAmountAt(item, selectedKey) > 0)
    .map((item) => {
      const progress = commitmentProgress(item, selectedMonth);
      const amount = commitmentAmountAt(item, selectedKey);
      const dueDate = commitmentDueDate(item, selectedMonth);
      const deadline = new Date(`${dueDate}T23:59:59`).getTime();
      const durationLabel = progress.duration === null
        ? `${progress.paid} pagamento(s) confirmado(s) · plano contínuo`
        : `${progress.paid}/${progress.duration} parcelas pagas · faltam ${progress.remaining}`;

      return `<article class="card p-4 sm:p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0"><span class="pill">${escapeHtml(item.category || "Compromisso")}</span><h3 class="font-display mt-3 truncate text-sm font-bold">${escapeHtml(item.name)}</h3></div>
          <span class="shrink-0 text-sm font-bold text-violet-100">${money(amount)}<span class="text-[10px] font-medium text-stone-500">/mês</span></span>
        </div>
        <div class="mt-4 flex items-center justify-between text-[11px]"><span class="text-stone-400">${progress.duration === null ? "Confirmação do período" : "Progresso das parcelas"}</span><strong>${progress.percent.toFixed(0)}%</strong></div>
        <div class="progress-track mt-2"><div class="progress-fill" role="progressbar" aria-valuenow="${progress.percent.toFixed(0)}" aria-valuemin="0" aria-valuemax="100" style="width:${progress.percent}%"></div></div>
        <p class="mt-2 text-[10px] text-stone-400">${durationLabel}</p>
        <div class="mt-4 flex items-center gap-2 rounded-xl border border-line bg-black/10 px-3 py-2.5 text-[11px] text-violet-200">
          ${icon("clock-3", 14)}<span>Vencimento do período: ${dueDate.split("-").reverse().join("/")} · ${progress.paidInPeriod ? "Pago / Confirmado" : "Pendente"}</span>
        </div>
        <p class="mt-2 number-input text-xs font-semibold text-violet-100" data-countdown-target="${deadline}" aria-live="off">Calculando prazo</p>
      </article>`;
    });

  return `<section class="mt-5">
    <div class="mb-3 flex items-end justify-between gap-3"><div><h2 class="font-display text-base font-bold">Compromissos ativos</h2><p class="mt-1 text-xs text-stone-500">Vigência e progresso em ${monthLabel(selectedMonth)}.</p></div><a href="/compromissos" data-route="/compromissos" class="subtle-link text-xs font-semibold">Gerenciar compromissos</a></div>
    ${cards.length ? `<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">${cards.join("")}</div>` : `<div class="card empty-state">Nenhum compromisso ativo neste período.</div>`}
  </section>`;
}

export function renderCommitmentsPage({ commitments, year, month, money, escapeHtml, categories, icon }) {
  const selectedKey = year * 12 + month;
  const currentDate = new Date();
  const currentKey = currentDate.getFullYear() * 12 + currentDate.getMonth();
  const active = commitments.filter((item) => Number.isFinite(toMonthKey(item.startMonth)));
  const activeTotal = active.reduce((sum, item) => sum + commitmentAmountAt(item, selectedKey), 0);

  const cards = active.length ? active.map((item) => {
    const selectedMonth = monthKeyToInput(selectedKey);
    const progress = commitmentProgress(item, selectedMonth);
    const endKey = commitmentEndKey(item);
    const isActive = isCommitmentActiveAt(item, selectedKey);
    const canMarkPaid = isActive;
    const isOngoing = isOpenEndedCommitment(item);
    const isClosedOngoing = item.termType === "ongoing" && Number.isFinite(endKey);
    const endedBeforeSelectedMonth = Number.isFinite(endKey) && selectedKey > endKey;
    const displayedAmount = endedBeforeSelectedMonth
      ? commitmentAmountAt(item, endKey)
      : commitmentAmountAt(item, selectedKey);
    const editMonth = endedBeforeSelectedMonth ? monthKeyToInput(endKey) : selectedMonth;
    const canEditPeriod = isActive || (endedBeforeSelectedMonth && displayedAmount > 0);
    const adjustments = (Array.isArray(item.adjustments) ? item.adjustments : [])
      .slice()
      .sort((a, b) => toMonthKey(a.effectiveMonth) - toMonthKey(b.effectiveMonth));

    return `<article class="card p-5 sm:p-6">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0"><span class="pill">${escapeHtml(item.category || "Compromisso")}</span><h3 class="font-display mt-3 truncate text-base font-bold">${escapeHtml(item.name)}</h3><p class="mt-1 text-xs text-stone-500">${monthLabel(item.startMonth)} · ${isOngoing ? "Contínuo, sem término definido" : isClosedOngoing ? `Plano encerrado em ${monthLabel(item.endMonth)}` : `${progress.duration} parcelas`} · ${endedBeforeSelectedMonth ? `Plano encerrado · último valor ${money(displayedAmount)}/mês` : `${money(displayedAmount)}/mês neste período`}</p></div>
        <div class="flex gap-2">
          ${isOngoing && isCommitmentActiveAt(item, currentKey) ? `<button type="button" class="btn-secondary !min-h-9 !px-3 text-xs" data-action="end-commitment" data-id="${escapeHtml(item.id)}">Encerrar plano</button>` : ""}
          ${canEditPeriod ? `<button type="button" class="icon-button !h-9 !w-9" data-action="edit-commitment-period" data-id="${escapeHtml(item.id)}" data-month="${editMonth}" aria-label="Editar este compromisso no período">${icon("pencil", 15)}</button>` : ""}
          <button type="button" class="icon-button !h-9 !w-9 text-rose-200" data-action="delete-commitment" data-id="${escapeHtml(item.id)}" aria-label="Excluir compromisso">${icon("trash-2", 15)}</button>
        </div>
      </div>
      <div class="mt-5 flex items-center justify-between text-xs"><span class="text-stone-400">Progresso confirmado</span><strong>${progress.percent.toFixed(0)}%</strong></div>
      <div class="progress-track mt-2"><div class="progress-fill" role="progressbar" aria-valuenow="${progress.percent.toFixed(0)}" aria-valuemin="0" aria-valuemax="100" style="width:${progress.percent}%"></div></div>
      <div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-stone-400"><span>${isOngoing ? `${progress.paid} mês(es) pago(s) · sem parcelas restantes definidas` : `Faltam ${progress.remaining} parcelas (${money(progress.remainingAmount)} restantes)`}</span><span>${progress.paid} ${isOngoing ? "pagamentos" : `/${progress.duration} pagas`}</span></div>
      <div class="mt-4 flex items-center gap-2 rounded-xl border border-line bg-black/10 px-3 py-2.5 text-xs ${progress.paidInPeriod ? "text-emerald-200" : "text-violet-200"}">${icon(progress.paidInPeriod ? "circle-check" : "clock-3", 15)}<span>${progress.paidInPeriod ? "Pago / Confirmado" : isActive ? "Pendente neste período" : selectedKey < toMonthKey(item.startMonth) ? `Começa em ${monthLabel(item.startMonth)}` : "Contrato encerrado"}</span></div>
      ${canMarkPaid ? `<label class="mt-3 flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line bg-black/10 px-3 text-sm"><input type="checkbox" class="commitment-checkbox" data-action="toggle-commitment-payment" data-id="${escapeHtml(item.id)}" data-month="${selectedMonth}" aria-label="Pago / Confirmado em ${monthLabel(selectedMonth)}"${progress.paidInPeriod ? " checked" : ""}><span>Pago / Confirmado em ${monthLabel(selectedMonth)}</span></label>` : ""}
      ${item.isUninterFallback ? "" : `<div class="mt-5 border-t border-line pt-4">
        <h4 class="text-xs font-bold">Histórico de reajustes</h4>
        ${adjustments.length ? `<ul class="mt-2 grid gap-1.5">${adjustments.map((change) => `<li class="flex justify-between gap-3 text-[11px] text-stone-400"><span>A partir de ${monthLabel(change.effectiveMonth)}</span><strong class="text-stone-200">${money(change.monthlyAmount)}/mês</strong></li>`).join("")}</ul>` : `<p class="mt-2 text-[11px] text-stone-500">Nenhum reajuste cadastrado.</p>`}
        <form id="commitment-adjustment-form" class="mt-3 grid grid-cols-2 gap-2">
          <input type="hidden" name="commitmentId" value="${escapeHtml(item.id)}">
          <div><label class="field-label" for="adjustment-month-${escapeHtml(item.id)}">Mês de início</label><input id="adjustment-month-${escapeHtml(item.id)}" class="field" type="month" name="effectiveMonth" value="${selectedMonth}" required></div>
          <div><label class="field-label" for="adjustment-amount-${escapeHtml(item.id)}">Novo valor mensal</label><input id="adjustment-amount-${escapeHtml(item.id)}" class="field" type="number" name="monthlyAmount" min="0.01" step="0.01" placeholder="R$" required></div>
          <button class="btn-secondary col-span-2" type="submit">${icon("trending-up", 15)}Registrar reajuste</button>
        </form>
      </div>`}
    </article>`;
  }).join("") : `<div class="card empty-state sm:col-span-2">Cadastre um compromisso para acompanhar parcelas, progresso e reajustes.</div>`;

  return `<section class="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
      <article class="card p-4"><p class="text-xs text-stone-400">Contas ativas no período</p><p class="font-display mt-2 text-xl font-extrabold">${active.filter((item) => commitmentAmountAt(item, selectedKey) > 0).length}</p></article>
      <article class="card p-4"><p class="text-xs text-stone-400">Comprometido por mês</p><p class="font-display mt-2 text-xl font-extrabold">${money(activeTotal)}</p></article>
      <article class="card col-span-2 p-4 sm:col-span-1"><p class="text-xs text-stone-400">Período consultado</p><p class="font-display mt-2 text-xl font-extrabold">${monthLabel(monthKeyToInput(selectedKey))}</p></article>
    </section>
    <section class="grid items-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,.65fr)]">
      <div class="grid content-start gap-4">${cards}</div>
      <aside class="card p-5 sm:p-6">
        <div class="mb-5"><span class="metric-icon">${icon("calendar-plus", 18)}</span><h2 class="font-display mt-4 text-base font-bold">Novo compromisso</h2><p class="mt-1 text-xs text-stone-500">Cadastre uma conta temporal e acompanhe os valores por período.</p></div>
        <form id="commitment-form" class="grid gap-4">
          <div><label class="field-label" for="commitment-name">Nome do compromisso</label><input class="field" id="commitment-name" name="name" maxlength="80" placeholder="Ex.: Faculdade, Moto" required></div>
          <div><label class="field-label" for="commitment-category">Categoria</label><select class="field" id="commitment-category" name="category">${categories.map((category) => `<option>${escapeHtml(category)}</option>`).join("")}</select></div>
          <div><label class="field-label" for="commitment-amount">Valor mensal atual (R$)</label><input class="field" id="commitment-amount" name="monthlyAmount" type="number" min="0.01" step="0.01" placeholder="0,00" required></div>
          <div><label class="field-label" for="commitment-start">Mês de início</label><input class="field" id="commitment-start" name="startMonth" type="month" value="${monthKeyToInput(currentKey)}" required></div>
          <div><label class="field-label" for="commitment-due-day">Dia de vencimento</label><input class="field" id="commitment-due-day" name="dueDay" type="number" min="1" max="31" step="1" value="1" required></div>
          <div><label class="field-label" for="commitment-term-type">Vigência</label><select class="field" id="commitment-term-type" name="termType"><option value="fixed">Com número total de parcelas</option><option value="ongoing">Contínuo, encerrar manualmente</option></select></div>
          <div id="commitment-duration-wrap"><label class="field-label" for="commitment-duration">Número total de parcelas</label><input class="field" id="commitment-duration" name="durationMonths" type="number" min="1" max="600" step="1" placeholder="Ex.: 12" required></div>
          <button class="btn-primary mt-1 w-full" type="submit">${icon("plus", 16)}Adicionar compromisso</button>
        </form>
      </aside>
    </section>`;
}
