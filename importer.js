const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_PREVIEW_ROWS = 500;

const normalizeHeader = (value) => String(value || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .trim()
  .toLowerCase();

function parseAmount(value) {
  let text = String(value || "").trim();
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  text = text.replace(/[^\d,.-]/g, "").replace(/[()]/g, "");
  if (text.includes(",") && text.includes(".")) {
    text = text.lastIndexOf(",") > text.lastIndexOf(".")
      ? text.replace(/\./g, "").replace(",", ".")
      : text.replace(/,/g, "");
  } else if (text.includes(",")) {
    text = text.replace(",", ".");
  }
  const amount = Number(text);
  if (!Number.isFinite(amount)) return NaN;
  return negative ? -Math.abs(amount) : amount;
}

function parseDate(value) {
  const text = String(value || "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = text.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/);
  if (br) return `${br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
  const ofx = text.match(/^(\d{4})(\d{2})(\d{2})/);
  if (ofx) return `${ofx[1]}-${ofx[2]}-${ofx[3]}`;
  return "";
}

function csvRows(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const candidates = [",", ";", "\t"];
  const delimiter = candidates.sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') {
      field += '"';
      index++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function csvTransactions(text) {
  const rows = csvRows(text.replace(/^\uFEFF/, ""));
  if (rows.length < 2) throw new Error("O CSV precisa conter cabeçalho e pelo menos uma linha de dados.");

  const headers = rows[0].map(normalizeHeader);
  const dateIndex = headers.findIndex((header) => /^(data|date|dt|posted|data lancamento|data transacao)/.test(header));
  const descriptionIndex = headers.findIndex((header) => /descricao|historico|memo|description|payee|estabelecimento|nome/.test(header));
  const amountIndex = headers.findIndex((header) => /^(valor|amount|value|montante|quantia)(\b|[^a-z])/.test(header));
  const debitIndex = headers.findIndex((header) => /debito|debit|saida|withdrawal/.test(header));
  const creditIndex = headers.findIndex((header) => /credito|credit|entrada|deposit/.test(header));

  if (dateIndex < 0 || descriptionIndex < 0 || (amountIndex < 0 && debitIndex < 0 && creditIndex < 0)) {
    throw new Error("Não identifiquei as colunas. Use cabeçalhos de data, descrição e valor (ou débito/crédito).");
  }

  return rows.slice(1).map((row, index) => {
    const date = parseDate(row[dateIndex]);
    const debit = debitIndex >= 0 ? Math.abs(parseAmount(row[debitIndex])) : 0;
    const credit = creditIndex >= 0 ? Math.abs(parseAmount(row[creditIndex])) : 0;
    const amount = amountIndex >= 0 ? parseAmount(row[amountIndex]) : credit - debit;
    const description = String(row[descriptionIndex] || "").trim();
    if (!date || !Number.isFinite(amount) || amount === 0 || !description) return null;
    return {
      date,
      description,
      amount: Math.abs(amount),
      type: amount < 0 ? "expense" : "income",
      category: "Outros",
      importRow: index + 2
    };
  }).filter(Boolean);
}

function ofxTransactions(text) {
  const entries = [...text.matchAll(/<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/BANKTRANLIST>|<\/INVTRANLIST>|$)/gi)];
  if (!entries.length) throw new Error("Nenhuma transação OFX foi encontrada no arquivo.");
  return entries.map((entry, index) => {
    const block = entry[1].replace(/<\/?STMTTRN>/gi, "");
    const field = (name) => block.match(new RegExp(`<${name}>([^<\\r\\n]+)`, "i"))?.[1]?.trim() || "";
    const date = parseDate(field("DTPOSTED"));
    const amount = parseAmount(field("TRNAMT"));
    const description = [field("NAME"), field("MEMO")].filter(Boolean).join(" — ");
    if (!date || !Number.isFinite(amount) || amount === 0 || !description) return null;
    return {
      date,
      description,
      amount: Math.abs(amount),
      type: amount < 0 ? "expense" : "income",
      category: "Outros",
      importRow: index + 1
    };
  }).filter(Boolean);
}

export async function parseStatementFile(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["csv", "ofx"].includes(extension)) throw new Error("Selecione um arquivo .csv ou .ofx.");
  if (file.size > MAX_FILE_SIZE) throw new Error("O arquivo excede o limite de 5 MB.");
  const text = await file.text();
  const transactions = extension === "csv" ? csvTransactions(text) : ofxTransactions(text);
  if (!transactions.length) throw new Error("Não foram encontrados lançamentos válidos no arquivo.");
  if (transactions.length > MAX_PREVIEW_ROWS) throw new Error(`O arquivo contém mais de ${MAX_PREVIEW_ROWS} lançamentos. Divida-o em arquivos menores.`);
  return transactions;
}

export function renderImportPanel(preview, money, escapeHtml) {
  return `<section class="card mb-5 p-5 sm:p-6">
    <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div><h2 class="font-display text-base font-bold">Importar extrato</h2><p class="mt-1 text-xs text-stone-500">Arraste um arquivo OFX/CSV ou selecione para revisar antes de salvar.</p></div>
      <label class="btn-secondary cursor-pointer"><i data-lucide="file-up" width="15" height="15" aria-hidden="true"></i>Selecionar arquivo<input class="sr-only" type="file" id="statement-file" accept=".ofx,.csv,text/csv,application/x-ofx"></label>
    </div>
    <div id="statement-dropzone" class="import-dropzone rounded-xl border border-dashed border-line px-5 py-7 text-center transition-colors">
      <span class="text-violet-300"><i data-lucide="file-spreadsheet" width="24" height="24" aria-hidden="true"></i></span>
      <p class="mt-2 text-sm font-semibold">Solte o extrato aqui</p><p class="mt-1 text-[11px] text-stone-500">OFX ou CSV · máximo 5 MB</p>
    </div>
    ${preview ? `<div class="mt-5">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3"><div><h3 class="text-sm font-bold">Prévia de ${preview.items.length} lançamento(s)</h3><p class="mt-1 text-[11px] text-stone-500">${escapeHtml(preview.filename)}</p></div>
        <div class="flex gap-2"><button class="btn-secondary !min-h-9 !px-3 !text-xs" type="button" data-action="clear-import">Cancelar</button><button class="btn-primary !min-h-9 !px-3 !text-xs" type="button" data-action="approve-import"><i data-lucide="check" width="14" height="14" aria-hidden="true"></i>Importar selecionados</button></div>
      </div>
      <div id="import-preview-list" class="grid max-h-[360px] gap-2 overflow-auto pr-1">
        ${preview.items.map((item, index) => `<label class="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-black/10 p-3 hover:border-violet-500/60">
          <input class="mt-1 accent-indigo-500" type="checkbox" data-import-index="${index}" ${item.selected === false ? "" : "checked"}>
          <span class="min-w-0 flex-1"><span class="block truncate text-xs font-semibold">${escapeHtml(item.description)}</span><span class="mt-1 block text-[10px] text-stone-500">${new Intl.DateTimeFormat("pt-BR").format(new Date(`${item.date}T12:00:00`))} · ${item.type === "income" ? "Entrada" : "Saída"}</span></span>
          <strong class="shrink-0 text-xs ${item.type === "income" ? "text-emerald-200" : "text-rose-200"}">${item.type === "income" ? "+" : "−"} ${money(item.amount)}</strong>
        </label>`).join("")}
      </div>
    </div>` : ""}
  </section>`;
}
