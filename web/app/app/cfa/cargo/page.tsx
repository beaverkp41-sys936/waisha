"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, seatPermissions } from "../../api-client";
import { ExportButtons } from "@/components/ExportButtons";
import { CargoBatchButton } from "@/components/CargoBatchButton";
function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface Shipment {
  id: string; file_number: string; shipment_type: string; hs_code: string | null;
  container_type: string; container_count: number | null;
  consignee_name: string; consignor_name: string; eta: string | null;
  payment_status: string; stage: string; status: string;
  weight_tonnes: string | null; open_tasks: number; created_at: string;
  /** The two codes 130's tables hold, with the words the same tables label them. */
  mode_code: number | null; mode_label: string | null;
  cpc_code: string | null; cpc_label: string | null;
  /** 'signed' | 'draft' | null — whether this file has 111's master sheet, and whether it is declared. */
  master_state: string | null;
}

/**
 * The code lists, exactly as `/cargo/codes` hands them over.
 *
 * Migration 130 turned the EAC's modes of transport and customs procedure codes into tables, and
 * bound each CPC to the movement its own first digit names — the same digit the file number starts
 * on. The desk used to keep its own copy of those four pairs, which is how a clerk came to type
 * statutory words into a free-text box while the register printed a number nobody had checked.
 * Nothing here spells a prefix, a mode or a procedure out again.
 */
interface MovementType { value: string; label: string; prefix: string }
interface TransportMode {
  code: number; key: string; label: string; note: string | null;
  carrier_word: string | null; bill_kind: string | null; bill_label: string | null;
}
interface Procedure { code: string; label: string; shipment_type: string; note: string | null }
interface CodeLists { types: MovementType[]; modes: TransportMode[]; procedures: Procedure[] }

/* What each book is for, in the office's own words. Which type stands in which book, and what
   the books are called, is the API's answer (`/cargo/books`) — never a second copy here, so the
   tab a clerk reads and the rows behind it are one story. */
const BOOK_NOTES: Record<string, string> = {
  clearing: "Inbound files this office clears at the border — import and transhipment",
  transport: "Outbound movement — export and transit files that take goods away"
};

/** One book as `/cargo/books` describes it. */
interface BookMeta {
  key: string; label: string; count: number;
  types: { value: string; count: number }[];
}
const CONTAINER_LABELS: Record<string, string> = {
  "20ft": "20FT", "40ft": "40FT", loose_cargo: "Loose Cargo", car: "Car"
};
const STAGE_LABELS: Record<string, string> = {
  pre_arrival: "Pre-arrival", arrival: "Arrival", customs: "Customs",
  inspection: "Inspection", release: "Release", exit: "Exit"
};
const STAGE_COLORS: Record<string, string> = {
  pre_arrival: "var(--ink-soft)", arrival: "var(--brand)", customs: "var(--gold)",
  inspection: "var(--warning)", release: "var(--gold-green)", exit: "var(--success)"
};
const PAYMENT_COLORS: Record<string, string> = {
  unpaid: "var(--danger)", partial: "var(--gold)", paid: "var(--success)"
};
const INCOTERMS = ["CIF", "CFR", "EXW", "FCA", "CPT", "CIP", "DAP", "DDP", "FAS", "FOB"];
// The mode block prints the paper's name inside a sentence, so the article has to follow the word:
// a sea movement travels on a bill of lading, an air movement on an air waybill.
const anOrA = (word: string) => (/^[aeiou]/i.test(word.trim()) ? "an" : "a");

interface ItemRow { description: string; }
interface FormState {
  shipmentType: string; modeCode: string; cpcCode: string;
  hsCode: string; declarationMode: string; cargoDescription: string;
  containerType: string; containerCount: string; containerNumbers: string;
  cbm: string; weightTonnes: string;
  consigneeName: string; consignorName: string; shippingLine: string; billNumber: string;
  orderDate: string; documentReceiptDate: string; eta: string; dischargeDate: string;
  carryInDate: string; termsDelivery: string;
  tansadNumber: string; rcnNumber: string; referenceNumber: string;
  officeDeclaration: string; borderPoint: string; nominatedIcd: string; cabinetPosition: string;
  processingCost: string; paymentAmount: string; paymentStatus: string; notes: string;
}
const EMPTY: FormState = {
  shipmentType: "import", modeCode: "", cpcCode: "",
  hsCode: "", declarationMode: "", cargoDescription: "",
  containerType: "20ft", containerCount: "1", containerNumbers: "",
  cbm: "", weightTonnes: "",
  consigneeName: "", consignorName: "", shippingLine: "", billNumber: "",
  orderDate: "", documentReceiptDate: "", eta: "", dischargeDate: "", carryInDate: "",
  termsDelivery: "CIF",
  tansadNumber: "", rcnNumber: "", referenceNumber: "",
  officeDeclaration: "", borderPoint: "", nominatedIcd: "", cabinetPosition: "",
  processingCost: "", paymentAmount: "", paymentStatus: "unpaid", notes: ""
};

/** What a scanned page carries, as the intake desk stored it. */
type ScanField = { value: string | number | string[]; raw: string; line: number; variants: number };
type ScanExtraction = {
  fields: Record<string, ScanField>;
  containers?: { number: string; line: number; valid: boolean }[];
  missing?: string[];
  notes?: string[];
  linesRead?: number;
};
type ScannedDraft = {
  id: string; position: number; file_name: string; label: string | null;
  printed_reference: string | null;
  shipment_type: string; extract_status: string; extract_notes: string | null;
  committed_shipment_id: string | null; committed_file_number: string | null;
  extraction: ScanExtraction | null;
};

// The form's own text fields, keyed exactly as the reader names them — which is why a scanned
// page can drop straight in. Money is absent on purpose: `processing_cost`, `payment_amount`
// and `payment_status` are this office's decision, never a fact printed on someone else's paper.
const SCAN_TEXT_KEYS: (keyof FormState)[] = [
  "hsCode", "declarationMode", "cargoDescription", "consigneeName", "consignorName",
  "shippingLine", "billNumber", "orderDate", "documentReceiptDate", "eta", "dischargeDate",
  "carryInDate", "termsDelivery", "tansadNumber", "rcnNumber", "referenceNumber",
  "officeDeclaration", "borderPoint", "nominatedIcd", "cabinetPosition"
];

/**
 * The movement a scanned page is filed under: the word printed on it when this office files that
 * movement, otherwise the number the clerk gave the page.
 *
 * `valid` is `/cargo/codes`'s list, so the desk holds no opinion of its own about what a movement
 * is. An empty list means the codes have not landed yet — and nothing on this side can then judge
 * the paper's word, so the shelf's answer, which the API validated on the way in, stands.
 */
function pickType(printed: unknown, hint: string, valid: string[]): string {
  if (!valid.length) return hint;
  if (typeof printed === "string" && valid.includes(printed)) return printed;
  return valid.includes(hint) ? hint : "import";
}

function applyScan(base: FormState, ex: ScanExtraction | null, shipmentTypeHint: string,
  validTypes: string[]): FormState {
  const f: FormState = { ...base };
  const value = (k: string) => ex?.fields?.[k]?.value;
  for (const k of SCAN_TEXT_KEYS) {
    const v = value(k);
    if (typeof v === "string" || typeof v === "number") f[k] = String(v);
  }
  f.shipmentType = pickType(value("shipmentType"), shipmentTypeHint, validTypes);
  const printedSize = value("containerType");
  if (typeof printedSize === "string" && printedSize in CONTAINER_LABELS) f.containerType = printedSize;
  if (!CONTAINER_LABELS[f.containerType]) f.containerType = "20ft";
  if (!INCOTERMS.includes(f.termsDelivery)) f.termsDelivery = "CIF";
  const containers = value("containerNumbers");
  if (Array.isArray(containers) && containers.length) {
    f.containerNumbers = containers.map(String).join("\n");
    f.containerCount = String(containers.length);
  }
  const weight = value("weightTonnes");
  if (typeof weight === "number" || typeof weight === "string") f.weightTonnes = String(weight);
  const cbm = value("cbm");
  if (typeof cbm === "number" || typeof cbm === "string") f.cbm = String(cbm);
  // Money stays empty on purpose: processing cost, amount paid and payment status are this
  // office's own decision, never a fact printed on someone else's paper.
  return f;
}

// Only the fields a file of this shape is expected to carry are named by the shelf, so this
// is the whole list a banner can be asked to translate.
const MISSING_LABELS: Record<string, string> = {
  shipmentType: "Shipment type", consigneeName: "Consignee", consignorName: "Consignor",
  billNumber: "Bill number", cargoDescription: "Cargo description", hsCode: "HS / BHTN code",
  containerNumbers: "Container numbers", weightTonnes: "Weight (tonnes)", eta: "ETA",
  termsDelivery: "Terms of delivery", tansadNumber: "TANSAD / declaration number"
};

function CargoContent() {
  const router = useRouter();
  const params = useSearchParams();
  const editId = params.get("edit");
  // A page off the intake shelf, opened by `?draft=`. The id is carried in the URL rather than
  // the extraction, so what fills the form is exactly what the shelf holds and the clerk saw.
  const draftId = params.get("draft");
  // Which of the two books the desk is open on, read from `?book=` rather than kept in state:
  // a link handed over from an alert or a colleague must land on the same register, and an
  // unknown or missing value is the inbound book, which is what a clearing office works on first.
  const bookParam = params.get("book");
  const book = bookParam === "transport" ? "transport" : "clearing";

  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [companyCode, setCompanyCode] = useState<string | null>(null);
  const [filterStage, setFilterStage] = useState("");
  const [filterType, setFilterType] = useState("");
  const [books, setBooks] = useState<BookMeta[]>([]);
  // The two code lists the desk declares from. Reference data, so one pull per page: a filter
  // change that asked again would be a second story told about the same four digits.
  const [codes, setCodes] = useState<CodeLists | null>(null);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<ScannedDraft | null>(null);
  // The "Open a scanned page" path is only shown to a seat that can read the shelf, and the
  // "Open as a cargo file" link only to one that can open files. An unknown seat gets neither.
  const [canExtract, setCanExtract] = useState(false);
  // Ticked for the batch archive. A tick the operator cannot see is a tick they cannot
  // check, so the set is pruned to the rows the desk is listing whenever the list loads.
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // The book as the server described it. `/cargo/books` owns which type stands where, so this
  // desk never holds its own copy of that vocabulary.
  const bookMeta = books.find(b => b.key === book);
  const bookTypes = (bookMeta?.types ?? []).map(t => t.value);
  // A type chosen on one book is not a filter on the other, so switching registers drops it
  // rather than printing a list of nothing.
  const typeFilter = bookMeta?.types.some(t => t.value === filterType) ? filterType : "";
  const bookCount = bookMeta?.count ?? 0;
  // Until the counts land, the desk words the book with its own key. The register is the same
  // book either way, so the only difference before the first reply is a lowercase name.
  const bookLabel = bookMeta?.label ?? book;

  // Every label and digit on this page is read out of the lists the API publishes. Nothing below
  // spells a prefix, a mode or a procedure out a second time.
  const types = codes?.types ?? [];
  const typeValues = types.map(t => t.value);
  const typeLabel = (t: string) => types.find(x => x.value === t)?.label ?? t;
  const typePrefix = (t: string) => types.find(x => x.value === t)?.prefix ?? "";
  /** "Import (4)" once the lists have landed, the bare word while they have not. */
  const typeOption = (t: string) => {
    const p = typePrefix(t);
    return p ? `${typeLabel(t)} (${p})` : typeLabel(t);
  };
  const modes = codes?.modes ?? [];
  const chosenMode = modes.find(m => String(m.code) === form.modeCode) ?? null;
  // A procedure belongs to the movement its first digit names, so the block offers only the
  // procedures this file can declare under — the same rule 130's trigger refuses on the write.
  const fileProcedures = (codes?.procedures ?? []).filter(p => p.shipment_type === form.shipmentType);
  const chosenCpc = fileProcedures.find(p => p.code === form.cpcCode) ?? null;

  const load = useCallback(async (editTarget?: string | null) => {
    const qs = new URLSearchParams();
    qs.set("book", book);
    if (filterStage) qs.set("stage", filterStage);
    if (typeFilter) qs.set("shipmentType", typeFilter);
    if (search.trim()) qs.set("search", search.trim());
    const res = await apiFetch(`/cargo${qs.toString() ? `?${qs}` : ""}`);
    if (res.ok) {
      const rows: Shipment[] = await res.json();
      setShipments(rows);
      const listed = new Set(rows.map(r => r.id));
      setPicked(p => new Set([...p].filter(id => listed.has(id))));
    }
    // The tab counts come from a grouped read, not from rows.length: this register caps at 200
    // files, and a tab that said "200" about an office with 400 would be a number nobody trusts.
    const b = await apiFetch("/cargo/books");
    if (b.ok) { const j = await b.json().catch(() => ({})); setBooks(j.books ?? []); }
    const p = await apiFetch("/profile");
    if (p.ok) { const j = await p.json(); setCompanyCode(j.company_code ?? null); }
    // Edit mode: pull the file into the form.
    if (editTarget) {
      const e = await apiFetch(`/cargo/${editTarget}`);
      const j = await e.json().catch(() => ({}));
      if (e.ok) {
        setForm({
          shipmentType: j.shipment_type,
          // The codes come back as the file holds them: a number for the mode, four digits for the
          // procedure, each empty when the desk never gave the file one.
          modeCode: j.mode_code === null || j.mode_code === undefined ? "" : String(j.mode_code),
          cpcCode: j.cpc_code ?? "",
          hsCode: j.hs_code ?? "", declarationMode: j.declaration_mode ?? "",
          cargoDescription: j.cargo_description ?? "",
          containerType: j.container_type, containerCount: j.container_count ? String(j.container_count) : "",
          containerNumbers: (j.container_numbers ?? []).join("\n"),
          cbm: j.cbm ?? "", weightTonnes: j.weight_tonnes ?? "",
          consigneeName: j.consignee_name ?? "", consignorName: j.consignor_name ?? "",
          shippingLine: j.shipping_line ?? "", billNumber: j.bill_number ?? "",
          orderDate: j.order_date ?? "", documentReceiptDate: j.document_receipt_date ?? "",
          eta: j.eta ?? "", dischargeDate: j.discharge_date ?? "", carryInDate: j.carry_in_date ?? "",
          termsDelivery: j.terms_delivery ?? "CIF",
          tansadNumber: j.tansad_number ?? "", rcnNumber: j.rcn_number ?? "",
          referenceNumber: j.reference_number ?? "",
          officeDeclaration: j.office_declaration ?? "", borderPoint: j.border_point ?? "",
          nominatedIcd: j.nominated_icd ?? "", cabinetPosition: j.cabinet_position ?? "",
          processingCost: j.processing_cost ?? "", paymentAmount: j.payment_amount ?? "",
          paymentStatus: j.payment_status ?? "unpaid", notes: j.notes ?? ""
        });
        setShowForm(true);
      } else {
        setError(errorText(j, "Could not load the cargo file for editing."));
      }
    }
    setLoaded(true);
  }, [book, filterStage, typeFilter, search]);

  useEffect(() => { load(editId); }, [load, editId]);

  useEffect(() => {
    seatPermissions().then(keys => setCanExtract(keys.has("shipments.extract")));
  }, []);

  // The modes and the procedures are the community's lists, not this office's, so they are pulled
  // once. A seat without `shipments.view` never reaches this page, and a reply that does not come
  // leaves the boxes offering nothing to pick — never a guess at a digit.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await apiFetch("/cargo/codes");
      const j = await res.json().catch(() => null);
      if (!cancelled && res.ok && j) setCodes(j as CodeLists);
    })();
    return () => { cancelled = true; };
  }, []);

  // One pull per page id. The form is built from EMPTY rather than from whatever was typed
  // before, because opening a page means "this paper is the basis of the file" — a half-typed
  // form left under a scan is a form nobody can say the provenance of.
  const scannedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!draftId) { scannedFor.current = null; setDraft(null); return; }
    if (scannedFor.current === draftId) return;
    scannedFor.current = draftId;
    (async () => {
      setError(null); setNotice(null);
      const res = await apiFetch(`/cargo/intake/${draftId}`);
      const j = await res.json().catch(() => ({}));
      // Checked by identity, not by a mount flag: this effect runs twice under StrictMode,
      // and a flag cleared by the first run's cleanup would drop the only reply that came.
      if (scannedFor.current !== draftId) return;
      if (!res.ok) {
        setDraft(null);
        setError(errorText(j, "Could not open that page from the intake shelf."));
        return;
      }
      const d: ScannedDraft = {
        id: j.id, position: Number(j.position) || 0, file_name: j.file_name ?? "page.pdf",
        label: j.label ?? null, printed_reference: j.printed_reference ?? null,
        shipment_type: j.shipment_type ?? "import", extract_status: j.extract_status ?? "pending",
        extract_notes: j.extract_notes ?? null,
        committed_shipment_id: j.committed_shipment_id ?? null,
        committed_file_number: j.committed_file_number ?? null,
        extraction: j.extraction ?? null
      };
      setDraft(d);
      if (d.committed_shipment_id) {
        setShowForm(false);
        setError(`Page ${d.position} already became cargo file ${d.committed_file_number ?? d.committed_shipment_id}. `
          + "Open it from the list below to edit it.");
        return;
      }
      setForm(applyScan(EMPTY, d.extraction, d.shipment_type, typeValues));
      setShowForm(true);
    })();
  }, [draftId]);

  const isLoose = form.containerType === "loose_cargo" || form.containerType === "car";
  const containerLines = form.containerNumbers.split("\n").map(s => s.trim()).filter(Boolean);
  const containerCount = Number(form.containerCount) || 0;
  const numbersMatch = isLoose || containerLines.length === containerCount;
  const prefix = typePrefix(form.shipmentType);
  const isEditing = editId !== null;
  // The form offers the open book's two types, plus whatever the file or the scanned page
  // already carries, so a clerk is never shown a type the desk cannot list.
  const formTypes = [...new Set([...bookTypes, form.shipmentType])];
  const filePreview = !companyCode
    ? "set your company code in Profile"
    : prefix
      ? `${prefix}${companyCode}-###-${new Date().getFullYear()}`
      : "waiting for the movement codes";

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm(f => ({ ...f, [k]: v }));
  }

  // A procedure carries its movement in its own first digit, so switching the movement cannot leave
  // the old code sitting on the file: the box would show a value it no longer offers, and 130's
  // trigger would refuse the write. The clerk watches the code go rather than reading a failure
  // after pressing Save.
  function chooseType(next: string) {
    setForm(f => ({
      ...f, shipmentType: next,
      cpcCode: (codes?.procedures ?? []).some(p => p.code === f.cpcCode && p.shipment_type === next)
        ? f.cpcCode : ""
    }));
  }

  // The book lives in the URL, so an alert or a handed-over link lands on the same register.
  function openBook(key: string) {
    const qs = new URLSearchParams(params.toString());
    qs.set("book", key);
    router.replace(`/app/cfa/cargo?${qs.toString()}`);
  }

  // The banner restates what the shelf holds for this page, so every number in it comes from
  // the same fetch that filled the form — never from a second read of the paper.
  const scanReadCount = Object.keys(draft?.extraction?.fields ?? {}).length;
  const scanMissing = (draft?.extraction?.missing ?? []).map(k => MISSING_LABELS[k] ?? k);
  const scanSuspects = (draft?.extraction?.containers ?? []).filter(c => !c.valid).map(c => c.number);

  async function save(mode: "close" | "new") {
    setError(null); setNotice(null); setBusy(true);
    try {
      const payload = {
        shipmentType: form.shipmentType,
        modeCode: form.modeCode ? Number(form.modeCode) : null,
        cpcCode: form.cpcCode || null,
        hsCode: form.hsCode || null,
        declarationMode: form.declarationMode || null,
        cargoDescription: form.cargoDescription || null,
        containerType: form.containerType,
        containerCount: isLoose ? null : containerCount,
        containerNumbers: isLoose ? null : containerLines,
        cbm: form.cbm ? Number(form.cbm) : null,
        weightTonnes: form.weightTonnes ? Number(form.weightTonnes) : null,
        consigneeName: form.consigneeName,
        consignorName: form.consignorName,
        shippingLine: form.shippingLine || null,
        billNumber: form.billNumber || null,
        orderDate: form.orderDate || null,
        documentReceiptDate: form.documentReceiptDate || null,
        eta: form.eta || null,
        dischargeDate: form.dischargeDate || null,
        carryInDate: form.carryInDate || null,
        termsDelivery: form.termsDelivery || null,
        tansadNumber: form.tansadNumber || null,
        rcnNumber: form.rcnNumber || null,
        referenceNumber: form.referenceNumber || null,
        officeDeclaration: form.officeDeclaration || null,
        borderPoint: form.borderPoint || null,
        nominatedIcd: form.nominatedIcd || null,
        cabinetPosition: form.cabinetPosition || null,
        processingCost: form.processingCost ? Number(form.processingCost) : null,
        paymentAmount: form.paymentAmount ? Number(form.paymentAmount) : null,
        paymentStatus: form.paymentStatus,
        notes: form.notes || null
      };
      const res = await apiFetch(isEditing ? `/cargo/${editId}` : "/cargo", {
        method: isEditing ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save the cargo file.")); return; }
      // A file opened from a scanned page gets the page attached to it, so the shelf stops
      // listing it as still to file. A failed attach is reported as what it is — the file is
      // open either way, the paper simply stays on the shelf — never as a failed save.
      let filedNote = "";
      if (!isEditing && draft) {
        const c = await apiFetch(`/cargo/intake/${draft.id}/commit`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shipmentId: j.id })
        });
        const cj = await c.json().catch(() => ({}));
        filedNote = c.ok
          ? ` Page ${draft.position} is attached to it.`
          : ` Page ${draft.position} could not be attached — ${errorText(cj, "the shelf still lists it as unfiled.")}`;
        setDraft(null);
        scannedFor.current = null;
        // Back to the book the clerk was working in, not to the default one.
        router.replace(`/app/cfa/cargo?book=${book}`);
      }
      if (mode === "new" && !isEditing) {
        setNotice("Cargo file opened — the form is ready for the next one." + filedNote);
        // The movement and how the goods travelled carry over — a desk working a lane files the same
        // shape of file after file. The procedure does not: a declaration is given to each consignment,
        // never assumed from the one before it.
        setForm(f => ({ ...EMPTY, shipmentType: f.shipmentType, modeCode: f.modeCode,
          containerType: f.containerType }));
      } else {
        setNotice((isEditing ? "Cargo file updated." : `Cargo file ${j.fileNumber ?? ""} opened.`.trim()) + filedNote);
        setForm(EMPTY); setShowForm(false);
      }
      load(null);
    } finally { setBusy(false); }
  }

  async function changeStage(id: string, stage: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/cargo/${id}/stage`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed."));
    load(null);
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const disabledStyle = { ...inputStyle, opacity: 0.45, cursor: "not-allowed" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const cardStyle = { borderColor: "var(--line)" };
  const sectionCls = "text-xs font-bold uppercase tracking-[0.14em] pb-8 mb-12 border-b";

  const sec = (title: string, children: React.ReactNode) => (
    <div>
      <p className={sectionCls} style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>{title}</p>
      <div className="grid grid-cols-2 gap-12">{children}</div>
    </div>
  );
  const field = (label: string, node: React.ReactNode, span = false) => (
    <label className={`block ${span ? "col-span-2" : ""}`}>
      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>{label}</span>
      {node}
    </label>
  );

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Cargo files</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            {`Two books, kept apart: ${BOOK_NOTES[book].toLowerCase()}.`}
            {companyCode
              ? (bookTypes.length && bookTypes.every(t => typePrefix(t))
                // The digit each movement is numbered from, printed beside the movement it belongs
                // to: this is the pair 130's tables and the file's own number both hold.
                ? ` This book numbers ${bookTypes.map(t => `${typePrefix(t)} for ${typeLabel(t).toLowerCase()}`).join(" and ")},`
                  + ` so a file here reads ${typePrefix(bookTypes[0])}${companyCode}-001-${new Date().getFullYear()}.`
                : "")
              : " Set your company code on the Profile page to open files."}
          </p>
        </div>
        <div className="flex flex-wrap gap-8">
          {canExtract && (
            <Link href="/app/cfa/cargo/intake"
              className="on-photo-btn px-16 py-8 text-xs font-semibold">Scan PDFs</Link>
          )}
          <Link href="/app/cfa/cargo/analytics"
            className="on-photo-btn px-16 py-8 text-xs font-semibold">Analytics</Link>
          <button type="button"
            onClick={() => {
              // A file opened from a book starts as that book's own type, so the number the
              // preview prints is a number this register can actually list.
              setForm({ ...EMPTY, shipmentType: bookMeta?.types[0]?.value ?? "import" });
              setShowForm(s => !s);
            }}
            className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
            {showForm ? "Close form" : `+ New ${bookLabel.toLowerCase()} file`}
          </button>
        </div>
      </div>

      {/* The two books, one tap apart, each counting from the server's grouped read rather than
          from the 200 rows this register is allowed to print. */}
      <div className="mt-20 flex flex-wrap gap-12" role="tablist" aria-label="Cargo books">
        {books.map(b => (
          <button key={b.key} type="button" role="tab" aria-selected={b.key === book}
            onClick={() => openBook(b.key)}
            className={`on-photo-btn px-16 py-8 text-xs font-semibold${b.key === book ? " is-on" : ""}`}>
            {`${b.label} (${b.count})`}
          </button>
        ))}
      </div>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {/* Filters */}
      <section className="mt-24 grid grid-cols-1 sm:grid-cols-3 gap-12">
        <label className="block">
          <span className={`${labelCls} pane-note`}>Stage</span>
          <select value={filterStage} onChange={e => setFilterStage(e.target.value)} className={inputCls} style={inputStyle}>
            <option value="">All stages</option>
            {Object.entries(STAGE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={`${labelCls} pane-note`}>Type</span>
          <select value={typeFilter} onChange={e => setFilterType(e.target.value)}
            className={inputCls} style={inputStyle}>
            <option value="">Every {bookLabel.toLowerCase()} type</option>
            {(bookMeta?.types ?? []).map(t => (
              <option key={t.value} value={t.value}>
                {`${typeOption(t.value)} — ${t.count} file${t.count === 1 ? "" : "s"}`}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={`${labelCls} pane-note`}>Search</span>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="File no, consignee, TANSAD, bill, CPC…" className={inputCls} style={inputStyle} />
        </label>
      </section>

      {draft && (
        <section aria-label="Scanned page this form was built from"
          className="mt-24 rounded-card border bg-surface p-20" style={{ borderColor: "var(--gold)" }}>
          <div className="flex flex-wrap items-start justify-between gap-12">
            <p className="text-xs font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
              {`Page ${draft.position} — ${draft.label || draft.file_name}`}
            </p>
            <Link href="/app/cfa/cargo/intake" className="text-xs font-semibold"
              style={{ color: "var(--brand)" }}>Intake shelf</Link>
          </div>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            {draft.extract_status === "extracted"
              ? `This form was built from the paper: ${scanReadCount} field(s) were taken from it, and each one can still be corrected below.`
              : draft.extract_status === "manual"
                ? "The page printed nothing this desk can read, so it was filed as one to type. The form below is as it was left — check every line against the paper."
                : "This page could not be opened, so nothing was taken from it. The form below is as it was left."}
          </p>
          {draft.extract_notes && (
            <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>{draft.extract_notes}</p>
          )}
          {scanMissing.length > 0 && (
            <p className="mt-12 text-xs" style={{ color: "var(--warning)" }}>
              {`Still to type from the paper: ${scanMissing.join(", ")}.`}
            </p>
          )}
          {scanSuspects.length > 0 && (
            <p className="mt-8 text-xs" style={{ color: "var(--danger)" }}>
              {`Container number(s) that fail their own check digit: ${scanSuspects.join(", ")}. Read them against the paper before saving.`}
            </p>
          )}
          <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
            Processing cost, payment amount and payment status stay blank on a scanned page: charges are this
            office&apos;s own decision, never a fact printed on someone else&apos;s paper. Saving opens the cargo file
            and attaches this page to it.
          </p>
        </section>
      )}

      {showForm && (
        <form onSubmit={e => { e.preventDefault(); save("close"); }}
          className="mt-24 space-y-24 rounded-card border bg-surface p-24" style={cardStyle}>
          {sec("1. Classification", <>
            {field(isEditing ? "Shipment type (fixed)" : "Shipment type *", <>
              <select required value={form.shipmentType} disabled={isEditing}
                onChange={e => chooseType(e.target.value)}
                className={inputCls} style={isEditing ? disabledStyle : inputStyle}>
                {formTypes.map(t => <option key={t} value={t}>{typeOption(t)}</option>)}
              </select>
              {isEditing ? (
                <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  A file stays in the book its number was cut from — to move it, open a new one.
                </p>
              ) : prefix ? (
                <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  {`Its number begins ${prefix}, and so does every customs procedure this file can declare under.`}
                </p>
              ) : null}
            </>)}
            {field("Mode of transport", <>
              <select value={form.modeCode} onChange={e => set("modeCode", e.target.value)}
                className={inputCls} style={inputStyle}>
                <option value="">{modes.length ? "Not stated" : "Loading the six modes…"}</option>
                {modes.map(m => (
                  <option key={m.code} value={String(m.code)}>{`${m.code} — ${m.label}`}</option>
                ))}
              </select>
              {modes.length > 0 && form.modeCode && !chosenMode && (
                <p className="mt-6 text-[11px]" style={{ color: "var(--warning)" }}>
                  This file carries a mode the list no longer offers — pick the one on the paper and
                  save, or the sheet prints the number without the words.
                </p>
              )}
            </>)}
            {/* The mode decides what the file's paper is, so the words it implies are printed with it
                rather than left for the clerk to remember at another section of the form. */}
            {chosenMode && (
              <div className="col-span-2 rounded-input border px-12 py-10"
                style={{ borderColor: "var(--gold)",
                  background: "color-mix(in srgb, var(--gold) 7%, transparent)" }}>
                <p className="text-[11px] font-bold uppercase tracking-[0.14em]"
                  style={{ color: "var(--ink)" }}>
                  {`Mode ${chosenMode.code} — ${chosenMode.label}`}
                </p>
                <p className="mt-6 text-xs" style={{ color: "var(--ink-soft)" }}>
                  {chosenMode.note}{" "}
                  {chosenMode.bill_label
                    ? `It travels on ${anOrA(chosenMode.bill_label)} ${chosenMode.bill_label.toLowerCase()}, so that is the transport document the master sheet must name for this file.`
                    : "Two legs or somebody else's paper carry it, so no single transport document belongs to this movement."}{" "}
                  {chosenMode.carrier_word
                    ? `The company that moves the goods is the ${chosenMode.carrier_word.toLowerCase()}, and section 3 labels its box that name.`
                    : "This mode names no carrier, so the parties keep their own words."}
                </p>
              </div>
            )}
            {field("File number (auto)",
              <input disabled value={filePreview} className={inputCls} style={disabledStyle} />)}
            {field("HS code", <input value={form.hsCode} onChange={e => set("hsCode", e.target.value)}
              placeholder="e.g. 8701.21.90" className={inputCls} style={inputStyle} />)}
            {field("Declaration mode", <input value={form.declarationMode}
              onChange={e => set("declarationMode", e.target.value)}
              placeholder="e.g. PVO, cash before delivery" className={inputCls} style={inputStyle} />)}
            {field("Cargo description", <input value={form.cargoDescription}
              onChange={e => set("cargoDescription", e.target.value)}
              placeholder="e.g. Portland cement, bagged" className={inputCls} style={inputStyle} />, true)}
          </>)}

          {sec("2. Container & cargo", <>
            {field("Container type *",
              <select required value={form.containerType}
                onChange={e => set("containerType", e.target.value)}
                className={inputCls} style={inputStyle}>
                {Object.entries(CONTAINER_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>)}
            {field("Container count", <input type="number" min={1} step={1}
              disabled={isLoose} value={isLoose ? "" : form.containerCount}
              onChange={e => set("containerCount", e.target.value)}
              className={inputCls} style={isLoose ? disabledStyle : inputStyle} />)}
            {field(isLoose ? "Container numbers — not applicable" : `Container numbers (one per line) ${containerCount > 0 ? `— ${containerLines.length} of ${containerCount}` : ""}`,
              <textarea rows={3} disabled={isLoose} value={isLoose ? "" : form.containerNumbers}
                onChange={e => set("containerNumbers", e.target.value)}
                placeholder={isLoose ? "" : "MSCU1234567\nMSCU7654321"}
                className={`${inputCls} ${!numbersMatch ? "border" : ""}`}
                style={isLoose ? disabledStyle : { ...inputStyle, borderColor: numbersMatch ? "var(--line)" : "var(--danger)" }} />, true)}
            {!isLoose && !numbersMatch && (
              <p className="col-span-2 text-xs" style={{ color: "var(--danger)" }}>
                Container numbers must match the count ({containerLines.length} of {containerCount}).
              </p>
            )}
            {field("CBM", <input type="number" min={0} step="0.001" value={form.cbm}
              onChange={e => set("cbm", e.target.value)} className={inputCls} style={inputStyle} />)}
            {field("Weight (tonnes)", <input type="number" min={0} step="0.001" value={form.weightTonnes}
              onChange={e => set("weightTonnes", e.target.value)} className={inputCls} style={inputStyle} />)}
          </>)}

          {sec("3. Parties", <>
            {field("Consignee *", <input required value={form.consigneeName}
              onChange={e => set("consigneeName", e.target.value)} className={inputCls} style={inputStyle} />)}
            {field("Consignor *", <input required value={form.consignorName}
              onChange={e => set("consignorName", e.target.value)} className={inputCls} style={inputStyle} />)}
            {/* The mode's own word for the company that moves the goods, so a rail file is not asked
                for a "shipping line" and an air file does not hide its airline behind one label. */}
            {field(chosenMode?.carrier_word ?? "Shipping line", <input value={form.shippingLine}
              onChange={e => set("shippingLine", e.target.value)}
              placeholder={chosenMode?.carrier_word
                ? `The ${chosenMode.carrier_word.toLowerCase()} named on the paper` : "e.g. MSC"}
              className={inputCls} style={inputStyle} />)}
            {field(chosenMode?.bill_label ? `${chosenMode.bill_label} number` : "Bill number (BL)",
              <input value={form.billNumber} onChange={e => set("billNumber", e.target.value)}
                className={inputCls} style={inputStyle} />)}
          </>)}

          {sec("4. Dates", <>
            {field("Order date", <input type="date" value={form.orderDate}
              onChange={e => set("orderDate", e.target.value)} className={inputCls} style={inputStyle} />)}
            {field("Document receipt date", <input type="date" value={form.documentReceiptDate}
              onChange={e => set("documentReceiptDate", e.target.value)} className={inputCls} style={inputStyle} />)}
            {field("ETA", <input type="date" value={form.eta}
              onChange={e => set("eta", e.target.value)} className={inputCls} style={inputStyle} />)}
            {field("Discharge date", <input type="date" value={form.dischargeDate}
              onChange={e => set("dischargeDate", e.target.value)} className={inputCls} style={inputStyle} />)}
            {field("Carry-in date", <input type="date" value={form.carryInDate}
              onChange={e => set("carryInDate", e.target.value)} className={inputCls} style={inputStyle} />)}
            {field("Terms of delivery (Incoterms)",
              <select value={form.termsDelivery} onChange={e => set("termsDelivery", e.target.value)}
                className={inputCls} style={inputStyle}>
                {INCOTERMS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>)}
          </>)}

          {sec("5. Customs", <>
            {/* The procedure this file declares under, headed on its own and offered by its code:
                the desk quotes "4000" to the customs officer, never a sentence it typed for itself.
                The four movements' codes are cut from the same digit as the file number, so the list
                is filtered to this file's movement — the rule 130's trigger holds on the write. */}
            <div className="col-span-2 rounded-input border px-12 py-10"
              style={{ borderColor: "var(--line)", background: "var(--milk)" }}>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em]"
                style={{ color: "var(--ink)" }}>
                CPC — the customs procedure code
              </p>
              <p className="mt-6 text-xs" style={{ color: "var(--ink-soft)" }}>
                {fileProcedures.length
                  ? `${typeLabel(form.shipmentType)} files declare under the ${fileProcedures.length} procedure${fileProcedures.length === 1 ? "" : "s"} whose code opens with ${prefix}.`
                  : "The procedures load with the file's own code lists."}
              </p>
              <select value={form.cpcCode} onChange={e => set("cpcCode", e.target.value)}
                className={`${inputCls} mt-10`} style={inputStyle}>
                <option value="">{fileProcedures.length ? "Not stated" : "Loading the procedures…"}</option>
                {fileProcedures.map(p => (
                  <option key={p.code} value={p.code}>{`${p.code} — ${p.label}`}</option>
                ))}
              </select>
              {chosenCpc?.note && (
                <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  {`${chosenCpc.code} — ${chosenCpc.note}`}
                </p>
              )}
              {modes.length > 0 && fileProcedures.length > 0 && form.cpcCode && !chosenCpc && (
                <p className="mt-6 text-[11px]" style={{ color: "var(--warning)" }}>
                  {`This file holds CPC ${form.cpcCode}, which the list does not offer for a ${typeLabel(form.shipmentType).toLowerCase()} movement. Pick the code on the declaration — another movement's code is refused on save.`}
                </p>
              )}
            </div>
            {field("TANSAD number", <input value={form.tansadNumber}
              onChange={e => set("tansadNumber", e.target.value)} className={inputCls} style={inputStyle} />)}
            {field("RCN number", <input value={form.rcnNumber}
              onChange={e => set("rcnNumber", e.target.value)} className={inputCls} style={inputStyle} />)}
            {field("Reference number", <input value={form.referenceNumber}
              onChange={e => set("referenceNumber", e.target.value)} className={inputCls} style={inputStyle} />)}
            {field("Office of declaration", <input value={form.officeDeclaration}
              onChange={e => set("officeDeclaration", e.target.value)} className={inputCls} style={inputStyle} />)}
            {field("Border point", <input value={form.borderPoint}
              onChange={e => set("borderPoint", e.target.value)} className={inputCls} style={inputStyle} />)}
            {field("Nominated ICD", <input value={form.nominatedIcd}
              onChange={e => set("nominatedIcd", e.target.value)} className={inputCls} style={inputStyle} />)}
            {field("Cabinet position", <input value={form.cabinetPosition}
              onChange={e => set("cabinetPosition", e.target.value)} className={inputCls} style={inputStyle} />)}
          </>)}

          {sec("6. Financial", <>
            {field("Processing cost (TZS)", <input type="number" min={0} step="0.01" value={form.processingCost}
              onChange={e => set("processingCost", e.target.value)} className={inputCls} style={inputStyle} />)}
            {field("Payment amount (TZS)", <input type="number" min={0} step="0.01" value={form.paymentAmount}
              onChange={e => set("paymentAmount", e.target.value)} className={inputCls} style={inputStyle} />)}
            {field("Payment status",
              <select value={form.paymentStatus} onChange={e => set("paymentStatus", e.target.value)}
                className={inputCls} style={inputStyle}>
                <option value="unpaid">Unpaid</option>
                <option value="partial">Partial</option>
                <option value="paid">Paid</option>
              </select>)}
          </>)}

          {sec("7. Notes", <>
            {field("Notes", <textarea rows={2} value={form.notes}
              onChange={e => set("notes", e.target.value)} className={inputCls} style={inputStyle} />, true)}
          </>)}

          <div className="flex flex-wrap gap-12">
            <button type="submit" disabled={busy || (!isLoose && !numbersMatch)}
              className="waisha-btn rounded-input px-24 py-8 text-xs font-semibold disabled:opacity-60">
              {busy ? "Saving…" : (editId ? "Update file" : "Save")}
            </button>
            {!editId && (
              <button type="button" disabled={busy || (!isLoose && !numbersMatch)}
                onClick={() => save("new")}
                className="rounded-input border px-24 py-8 text-xs font-semibold disabled:opacity-50"
                style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Save &amp; New</button>
            )}
            <button type="button" onClick={() => { setForm(EMPTY); setShowForm(false); }}
              className="rounded-input border px-24 py-8 text-xs font-semibold"
              style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Close</button>
          </div>
        </form>
      )}

      <div className="mt-24 flex flex-wrap items-center justify-between gap-12">
        <p className="text-xs font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
          {`${bookLabel} book — ${shipments.length} file${shipments.length === 1 ? "" : "s"} listed`}
          {filterStage || typeFilter || search ? " for these filters" : ""}
          {bookCount > shipments.length
            ? ` (${bookCount} in the book; a register lists 200)` : ""}
        </p>
        <div className="flex flex-wrap items-start gap-24">
          <ExportButtons report="cargo"
            title={`${bookLabel} files`}
            subtitle={filterStage || typeFilter || search
              ? `${bookLabel} files matching the filters on the desk`
              : `Every ${bookLabel} file on the desk`}
            meta={[
              { label: "Book", value: bookLabel },
              { label: "Stage", value: filterStage ? (STAGE_LABELS[filterStage] ?? filterStage) : "All" },
              { label: "Type", value: typeFilter ? typeOption(typeFilter) : "Both" },
              { label: "Search", value: search.trim() || "—" },
              // A register lists 200 files; a sheet that says 200 rows without saying the book
              // holds 400 reads like the office finished the book.
              { label: "Listed", value: `${shipments.length} of ${bookCount} in the book` }
            ]}
            columns={[
              { key: "file", label: "File no.", type: "text" },
              { key: "consignee", label: "Consignee", type: "text" },
              { key: "type", label: "Type", type: "text" },
              { key: "mode", label: "Mode of transport", type: "text" },
              { key: "cpc", label: "CPC", type: "text" },
              { key: "container", label: "Container", type: "text" },
              { key: "eta", label: "ETA", type: "date" },
              { key: "weight", label: "Weight (t)", type: "number" },
              { key: "stage", label: "Stage", type: "text" },
              { key: "payment", label: "Payment", type: "text" },
              { key: "tasks", label: "Open office jobs", type: "number" }
            ]}
            rows={shipments.map(s => ({
              file: s.file_number, consignee: s.consignee_name,
              type: typeOption(s.shipment_type),
              // The code and its words on one line, so a sheet read away from the desk still says
              // which procedure the file was declared under.
              mode: s.mode_code ? `${s.mode_code} · ${s.mode_label ?? "mode not in the list"}` : "—",
              cpc: s.cpc_code ? `${s.cpc_code} · ${s.cpc_label ?? "procedure not in the list"}` : "—",
              container: `${CONTAINER_LABELS[s.container_type] ?? s.container_type}`
                + (s.container_count ? ` x${s.container_count}` : ""),
              eta: s.eta, weight: s.weight_tonnes,
              stage: STAGE_LABELS[s.stage] ?? s.stage,
              payment: s.payment_status, tasks: s.open_tasks
            }))} />
          <CargoBatchButton ids={[...picked]} />
        </div>
      </div>

      <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">
                <label className="flex h-32 w-32 items-center justify-center"
                  title="Tick every file listed here">
                  <input type="checkbox" aria-label="Select every listed file"
                    className="h-20 w-20" style={{ accentColor: "var(--brand)" }}
                    checked={shipments.length > 0 && picked.size === shipments.length}
                    onChange={e => setPicked(e.target.checked ? new Set(shipments.map(s => s.id)) : new Set())} />
                </label>
              </th>
              <th className="p-12">File number</th><th className="p-12">Type</th>
              <th className="p-12">Consignee</th><th className="p-12">Container</th>
              <th className="p-12 text-right">ETA</th><th className="p-12">Stage</th>
              <th className="p-12">Payment</th><th></th>
            </tr>
          </thead>
          <tbody>
            {shipments.map((s, i) => (
              <tr key={s.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12">
                  <label className="flex h-32 w-32 items-center justify-center">
                    <input type="checkbox" aria-label={`Archive ${s.file_number}`}
                      className="h-20 w-20" style={{ accentColor: "var(--brand)" }}
                      checked={picked.has(s.id)}
                      onChange={e => setPicked(p => {
                        const next = new Set(p);
                        if (e.target.checked) next.add(s.id); else next.delete(s.id);
                        return next;
                      })} />
                  </label>
                </td>
                <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>
                  <Link href={`/app/cfa/cargo/${s.id}`} className="underline">{s.file_number}</Link>
                  {s.open_tasks > 0 && (
                    <span className="ml-8 text-[10px] font-bold" style={{ color: "var(--warning)" }}>
                      {s.open_tasks} task{s.open_tasks === 1 ? "" : "s"}
                    </span>
                  )}
                  {s.master_state && (
                    <span className="ml-8 inline-block px-6 py-2 text-[10px] font-bold uppercase"
                      style={{ borderLeft: `3px solid ${s.master_state === "signed" ? "var(--success)" : "var(--gold)"}`,
                        color: "var(--ink)" }}>
                      {s.master_state === "signed" ? "master signed" : "master draft"}
                    </span>
                  )}
                </td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>
                  {typeLabel(s.shipment_type)}
                  {/* The two codes the file was declared on, under the movement that owns them. */}
                  {(s.cpc_code || s.mode_code) && (
                    <p className="mt-4 text-[10px]">
                      {[s.cpc_code ? `CPC ${s.cpc_code}` : null,
                        s.mode_code ? `mode ${s.mode_code}` : null]
                        .filter(Boolean).join(" · ")}
                    </p>
                  )}
                </td>
                <td className="p-12" style={{ color: "var(--ink)" }}>{s.consignee_name}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>
                  {CONTAINER_LABELS[s.container_type] ?? s.container_type}
                  {s.container_count ? ` ×${s.container_count}` : ""}
                </td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {s.eta ? new Date(s.eta).toLocaleDateString() : "—"}
                </td>
                <td className="p-12">
                  <select defaultValue="" aria-label="Change stage"
                    className="rounded-input border px-8 py-4 text-xs"
                    style={{ borderColor: "var(--line)", background: "var(--milk)", color: STAGE_COLORS[s.stage] ?? "var(--ink)" }}
                    onChange={e => { if (e.target.value) changeStage(s.id, e.target.value); e.target.value = ""; }}>
                    <option value="">{STAGE_LABELS[s.stage] ?? s.stage}</option>
                    {Object.entries(STAGE_LABELS).filter(([k]) => k !== s.stage).map(([k, l]) => (
                      <option key={k} value={k}>{l}</option>
                    ))}
                  </select>
                </td>
                <td className="p-12">
                  <span className="px-8 py-4 text-[10px] font-bold uppercase"
                    style={{ borderLeft: `4px solid ${PAYMENT_COLORS[s.payment_status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                    {s.payment_status}
                  </span>
                </td>
                <td className="p-12 text-right">
                  <Link href={`/app/cfa/cargo/${s.id}`} className="text-xs underline" style={{ color: "var(--brand)" }}>Open</Link>
                </td>
              </tr>
            ))}
            {loaded && shipments.length === 0 && (
              <tr><td colSpan={9} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                No {bookLabel.toLowerCase()} files
                {filterStage || typeFilter || search ? " match the filters" : " yet — open your first one above"}.
              </td></tr>
            )}
            {!loaded && (
              <tr><td colSpan={9} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>Loading…</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function CargoPage() {
  return (
    <Suspense fallback={
      <div className="mx-auto max-w-[980px] px-16 py-32 text-sm" style={{ color: "var(--ink-soft)" }}>Loading…</div>
    }>
      <CargoContent />
    </Suspense>
  );
}
