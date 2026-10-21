"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowDownToLine, ArrowUpFromLine, Boxes, CircleDollarSign, Paperclip, Package,
  ScrollText, Warehouse, X
} from "lucide-react";
import { apiFetch, seatPermissions } from "@/app/app/api-client";
import { ExportButtons } from "@/components/ExportButtons";
import { DOC_KIND_LABELS } from "@/app/app/doc-kinds";
import { fmtBytes } from "@/app/portal/labels";
import { DOCKET_KIND, HOLD_STATUS, heldFor, money, sum, units } from "@/app/app/warehouse-terms";

/**
 * The warehouse desk — migration 118's register over HTTP.
 *
 * One component, two surfaces: the whole-company store at /app/cfa/warehouse, and the holds of one
 * cargo file mounted on that file's own page. It is one file on purpose, for the same reason the
 * workshop desk is: a hold is opened, counted in, counted out, re-tariffed, its paper voided and
 * its whole called off, and the surface on a cargo file must refuse exactly what the register
 * refuses.
 *
 * Nothing here works out how much a stay costs. `days_held`, `charge_days`, `storage_charge`, the
 * two quantities and the status all arrive on the row, and the dockets arrive only when a panel
 * asks for them. The store's clock — the day the figures were priced against — is printed with the
 * money, because a hold in the store grows by a day every morning and a clerk comparing two
 * screenshots needs to know they were taken on different days.
 */

export interface Hold {
  id: string; ref: string; shipment_id: string; file_number: string; shipment_type: string;
  stage: string; file_status: string; consignee_name: string | null;
  place: string; goods: string; unit: string; container_number: string | null;
  daily_rate: number; currency: string; free_days: number; status: string;
  entered_on: string | null; exited_on: string | null;
  quantity_in: number; quantity_out: number; balance: number;
  days_held: number; charge_days: number; storage_charge: number; priced_on: string;
  notes: string | null; cancel_reason: string | null;
  opened_by_name: string | null; released_by_name: string | null; cancelled_by_name: string | null;
  created_at: string; created_by_name: string | null;
  docket_count: number; attachments: number;
  can_edit: boolean; can_enter: boolean; can_exit: boolean; can_cancel: boolean; can_void: boolean;
  edit_block: string | null;
}

interface Docket {
  id: string; kind: string; ref: string; slip_day: string; quantity: number;
  docket_ref: string | null; note: string | null; state: string;
  filed_by_name: string | null; filed_at: string;
  voided_by_name: string | null; voided_at: string | null; void_reason: string | null;
}

interface Summary {
  totals: {
    holds: number; in_store: number; released: number; cancelled: number;
    held_quantity: number; priced_on: string;
  };
  byCurrency: { currency: string; holds: number; charge: number }[];
  byPlace: {
    place: string; holds: number; in_store: number; held_quantity: number;
    oldest_entry: string | null;
  }[];
  byFile: {
    file_number: string; consignee_name: string | null; shipment_type: string;
    currency: string; holds: number; charge: number;
  }[];
}

interface FileOption {
  id: string; file_number: string; shipment_type: string; stage: string; status: string;
  consignee_name: string | null; container_count: number | null; holds_in_store: number;
}

interface Paper {
  id: string; kind: string; file_name: string; size_bytes: number; created_at: string;
}

const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const tiny = { color: "var(--ink-soft)" };

/** The store's own paper, as the desk names it. The three 117 kinds plus a gate pass. */
const PAPER_KINDS = ["warehouse_receipt", "warehouse_entry", "warehouse_exit", "delivery_note", "other"];
const CURRENCIES = ["TZS", "USD", "KES"];

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

/** Today in the operator's own calendar — `toISOString` is UTC and would print yesterday's date. */
function todayPlain(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const blankHold = (fileId = "") => ({
  fileId, place: "", goods: "", unit: "pcs", containerNumber: "",
  dailyRate: "", currency: "TZS", freeDays: "0", notes: "",
  entryDay: todayPlain(), quantity: "", docketRef: ""
});

type Act = "new" | "entry" | "exit" | "edit" | "cancel" | "log" | "files";
/** Only opening a fresh hold has no hold to work on; every other act is named from a row,
 *  so the panel carries the hold its buttons write against. */
type Panel = { act: "new"; hold?: Hold }
  | { act: Exclude<Act, "new">; hold: Hold } | null;

export function WarehouseDesk({ shipmentId, fileLabel, onChanged }: {
  /** Lock the register to one cargo file — the file's own page passes it, the desk page does not. */
  shipmentId?: string;
  fileLabel?: string;
  /** Called after any write, so the file's page can re-read anything that restates these holds. */
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<Hold[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [files, setFiles] = useState<FileOption[]>([]);
  const [dockets, setDockets] = useState<Docket[] | null>(null);
  const [papers, setPapers] = useState<Paper[] | null>(null);
  const [perms, setPerms] = useState<Record<string, boolean> | null>(null);

  const [status, setStatus] = useState(shipmentId ? "all" : "stored");
  const [place, setPlace] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);

  const [panel, setPanel] = useState<Panel>(null);
  const [draft, setDraft] = useState(blankHold(shipmentId ?? ""));
  const [slip, setSlip] = useState({ day: todayPlain(), quantity: "", docketRef: "", note: "" });
  const [reason, setReason] = useState("");
  const [voiding, setVoiding] = useState<Docket | null>(null);
  const [paperKind, setPaperKind] = useState("warehouse_receipt");

  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const listReq = useRef(0);
  // A docket written through a remote pooler takes seconds, and in that time the clerk can open
  // another hold's panel. The reply must leave the newly opened panel alone.
  const openAct = useRef<{ act: Act; id: string | null } | null>(null);
  const stillOwns = (act: Act, id: string | null) =>
    openAct.current?.act === act && openAct.current?.id === id;

  const load = useCallback(async () => {
    const mine = ++listReq.current;
    const qs = new URLSearchParams();
    if (status !== "all") qs.set("status", status);
    if (place) qs.set("place", place);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    if (q) qs.set("q", q);
    if (shipmentId) qs.set("shipmentId", shipmentId);
    const res = await apiFetch(`/warehouse/stays?${qs.toString()}`);
    const list = res.ok ? await res.json() : null;
    const listErr = res.ok ? null
      : errorText(await res.json().catch(() => ({})), "The store's book would not open.");
    // The whole-company footings are only read by the register's own summary section; a file's
    // page asks for the holds and nothing else.
    const sums = shipmentId ? null : await apiFetch("/warehouse/summary").then(r => (r.ok ? r.json() : null));
    // Two filter clicks a second apart put two answers on the wire; only the newest may paint.
    if (mine !== listReq.current) return;
    if (list) setRows(list);
    else { setRows([]); setErr(listErr); }
    if (sums) setSummary(sums);
  }, [status, place, from, to, q, shipmentId]);

  useEffect(() => {
    let live = true;
    seatPermissions().then((keys) => {
      if (!live) return;
      setPerms({
        view: keys.has("warehouse.view"), entry: keys.has("warehouse.entry"),
        exit: keys.has("warehouse.exit"), edit: keys.has("warehouse.edit"),
        void: keys.has("warehouse.void"), cancel: keys.has("warehouse.cancel"),
        upload: keys.has("documents.create"), seeDocs: keys.has("documents.view")
      });
    });
    return () => { live = false; };
  }, []);

  useEffect(() => { if (perms?.view) load(); }, [load, perms]);

  // The picker and the place list are read once: files and places only change when another desk
  // moves, and neither happens while a hold is being written.
  useEffect(() => {
    if (!perms?.view || shipmentId) return;
    apiFetch("/warehouse/files").then(async (r) => {
      if (r.ok) setFiles(await r.json());
    }).catch(() => { });
  }, [perms, shipmentId]);

  async function send(path: string, method: string, body: unknown): Promise<{ err: string | null; data: any }> {
    setBusy(true);
    try {
      const res = await apiFetch(path, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return { err: errorText(j, "The desk could not save that."), data: null };
      await load();
      onChanged?.();
      return { err: null, data: j };
    } finally { setBusy(false); }
  }

  function showPanel(next: Panel) {
    openAct.current = next ? { act: next.act, id: next.hold?.id ?? null } : null;
    setPanel(next);
    if (!next) return;
    requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function closePanel() { showPanel(null); setErr(null); setNote(null); setVoiding(null); }
  function finishPanel() { showPanel(null); setErr(null); setVoiding(null); }

  function openPanel(next: Exclude<Act, "new">, hold: Hold) {
    setErr(null); setNote(null); setVoiding(null);
    if (next === "entry" || next === "exit") {
      setSlip({ day: todayPlain(), quantity: "", docketRef: "", note: "" });
    } else if (next === "edit") {
      setDraft({
        ...blankHold(hold.shipment_id),
        place: hold.place, goods: hold.goods, unit: hold.unit,
        containerNumber: hold.container_number ?? "", dailyRate: String(hold.daily_rate),
        currency: hold.currency, freeDays: String(hold.free_days), notes: hold.notes ?? ""
      });
    } else if (next === "cancel") {
      setReason("");
    } else if (next === "log") {
      setDockets(null);
      apiFetch(`/warehouse/stays/${hold.id}`).then(async (r) => {
        if (!r.ok) {
          if (stillOwns("log", hold.id))
            setErr(errorText(await r.json().catch(() => ({})), "The docket list would not read."));
          setDockets([]);
          return;
        }
        const j = await r.json();
        if (stillOwns("log", hold.id)) setDockets(j.dockets ?? []);
      }).catch(() => { if (stillOwns("log", hold.id)) setDockets([]); });
    } else if (next === "files") {
      setPapers(null); setPaperKind("warehouse_receipt");
      apiFetch(`/documents?entityType=warehouse_stay&entityId=${hold.id}`).then(async (r) => {
        const list = r.ok ? await r.json() : [];
        if (stillOwns("files", hold.id)) setPapers(list);
      }).catch(() => { if (stillOwns("files", hold.id)) setPapers([]); });
    }
    showPanel({ act: next, hold });
  }

  function openNew(prefillFileId = "") {
    setDraft(blankHold(prefillFileId || (shipmentId ?? "")));
    setErr(null); setNote(null);
    showPanel({ act: "new" });
  }

  /** The tariff boxes are shared by opening a hold and correcting one that is still in the store. */
  function tariffPayload() {
    return {
      place: draft.place.trim(), goods: draft.goods.trim(), unit: draft.unit.trim() || "pcs",
      containerNumber: draft.containerNumber.trim() || null,
      dailyRate: draft.dailyRate === "" ? 0 : Number(draft.dailyRate),
      currency: draft.currency,
      freeDays: draft.freeDays === "" ? 0 : Number(draft.freeDays),
      notes: draft.notes.trim() || null
    };
  }

  function draftProblems(needEntry: boolean): string | null {
    if (!shipmentId && !draft.fileId) return "Name the cargo file the goods belong to.";
    if (draft.place.trim().length < 3) return "The store's place needs at least three letters — a yard, a bond, a shelf.";
    if (draft.goods.trim().length < 3) return "Say what the goods are, as the paper names them.";
    if (draft.dailyRate !== "" && (Number.isNaN(Number(draft.dailyRate)) || Number(draft.dailyRate) < 0))
      return "The daily rate is a number, and a store does not pay you to hold goods.";
    if (Number.isNaN(Number(draft.freeDays)) || Number(draft.freeDays) < 0 || Number(draft.freeDays) > 365)
      return "Free days is a whole number between 0 and 365.";
    if (!needEntry) return null;
    if (draft.quantity !== "" && !(Number(draft.quantity) > 0))
      return "A docket counts goods in, so its quantity must be above zero.";
    if (draft.quantity !== "" && !draft.entryDay)
      return "The first docket is dated the day the crate arrived.";
    return null;
  }

  async function submitDraft() {
    const editing = panel?.act === "edit" ? panel.hold : undefined;
    const bad = draftProblems(!editing);
    if (bad) { setErr(bad); return; }
    const payload = tariffPayload();
    setErr(null);
    if (editing) {
      const out = await send(`/warehouse/stays/${editing.id}`, "PUT", payload);
      if (out.err) { setErr(out.err); return; }
      setNote(`${editing.ref} re-tariffed at ${payload.currency} ${money(payload.dailyRate)} a day, `
        + `free for ${payload.freeDays} day${payload.freeDays === 1 ? "" : "s"}. The register keeps what it said before.`);
      if (stillOwns("edit", editing.id)) finishPanel();
      return;
    }
    const counting = draft.quantity !== "";
    const out = await send("/warehouse/stays", "POST", {
      shipmentId: shipmentId ?? draft.fileId, ...payload,
      ...(counting ? {
        entryDay: draft.entryDay, quantity: Number(draft.quantity),
        docketRef: draft.docketRef.trim() || null
      } : {})
    });
    if (out.err) { setErr(out.err); return; }
    setNote(`Hold ${out.data?.ref ?? ""} opened at ${payload.place} — `
      + (counting
        ? `${units(Number(draft.quantity))} ${payload.unit} counted in against the first docket.`
        : "nothing has been counted in yet, so it costs the file nothing."));
    if (stillOwns("new", null)) { setDraft(blankHold(shipmentId ?? "")); finishPanel(); }
  }

  async function submitSlip(kind: "entry" | "exit") {
    const h = panel!.hold!;
    const quantity = Number(slip.quantity);
    if (!(quantity > 0)) {
      setErr(kind === "entry"
        ? "Say how many arrived — a docket that counts nothing in is a blank page."
        : "Say how many left the store.");
      return;
    }
    if (!slip.day) { setErr("The docket needs the day the goods moved."); return; }
    if (kind === "exit" && quantity > h.balance) {
      setErr(`Hold ${h.ref} is holding ${units(h.balance)} ${h.unit}. It cannot let out `
        + `${units(quantity)} — the store would hand over goods it does not have.`);
      return;
    }
    setErr(null);
    const out = await send(`/warehouse/stays/${h.id}/${kind === "entry" ? "entries" : "exits"}`, "POST", {
      slipDay: slip.day, quantity,
      docketRef: slip.docketRef.trim() || null, note: slip.note.trim() || null
    });
    if (out.err) { setErr(out.err); return; }
    const d = out.data ?? {};
    setNote(kind === "entry"
      ? `${d.ref} filed — ${units(quantity)} ${h.unit} in on ${slip.day} against ${h.ref}.`
      : `${d.ref} filed — ${units(quantity)} ${h.unit} out on ${slip.day} against ${h.ref}. `
      + (d.hold?.status === "released"
        ? `That was the last of it: the hold is released${d.hold?.released_by_name ? `, signed by ${d.hold.released_by_name}` : ""}, `
        + "the tariff and the dates are frozen."
        : `${h.ref} still holds ${units(h.balance - quantity)} ${h.unit}.`));
    if (stillOwns(kind, h.id)) finishPanel();
  }

  async function submitCancel() {
    const h = panel!.hold!;
    if (reason.trim().length < 3) { setErr("Say why the hold is called off — the register keeps the words."); return; }
    const out = await send(`/warehouse/stays/${h.id}/cancel`, "POST", { reason: reason.trim() });
    if (out.err) { setErr(out.err); return; }
    setNote(`${h.ref} called off. It counts as nothing held and bills the file nothing — a hold that `
      + "received goods is cleared by an exit docket, not by calling it off.");
    if (stillOwns("cancel", h.id)) finishPanel();
  }

  async function submitVoid() {
    const d = voiding!;
    const h = panel!.hold!;
    if (reason.trim().length < 3) { setErr("Say what was wrong with the docket — the paper keeps the words."); return; }
    const out = await send(`/warehouse/slips/${d.id}/void`, "POST", { reason: reason.trim() });
    if (out.err) { setErr(out.err); return; }
    const after = out.data?.hold ?? {};
    setNote(`${d.ref} voided. ${h.ref} now reads ${units(Number(after.quantity_in ?? 0))} in / `
      + `${units(Number(after.quantity_out ?? 0))} out and is `
      + `${HOLD_STATUS[after.status]?.label ?? after.status}. The docket stays on the list with your reason.`);
    setReason("");
    setVoiding(null);
    const r = await apiFetch(`/warehouse/stays/${h.id}`);
    if (r.ok) {
      const j = await r.json();
      if (stillOwns("log", h.id)) setDockets(j.dockets ?? []);
    }
  }

  async function attachPaper(ev: React.ChangeEvent<HTMLInputElement>) {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    const h = panel?.hold;
    if (!f || !h) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      // Metadata before the file part: the API reads fields as they arrive, and a field that
      // comes after the bytes is a field it never sees.
      fd.append("entityType", "warehouse_stay");
      fd.append("entityId", h.id);
      fd.append("kind", paperKind);
      fd.append("file", f);
      const res = await apiFetch("/documents", { method: "POST", body: fd });
      if (!res.ok) { setErr(errorText(await res.json().catch(() => ({})), "The file would not attach.")); return; }
      setNote(`“${f.name}” filed against ${h.ref}.`);
      const r = await apiFetch(`/documents?entityType=warehouse_stay&entityId=${h.id}`);
      const list = r.ok ? await r.json() : [];
      if (stillOwns("files", h.id)) setPapers(list);
      await load();
    } finally { setBusy(false); }
  }

  async function openPaper(id: string) {
    const res = await apiFetch(`/documents/${id}/url`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.url) { setErr(errorText(j, "Could not open the file.")); return; }
    window.open(j.url, "_blank", "noopener,noreferrer");
  }

  const chosenFile = files.find(f => f.id === draft.fileId);

  const exportRows = useMemo(() => (rows ?? []).map((r) => ({
    ref: r.ref,
    file: r.file_number,
    consignee: r.consignee_name ?? "",
    place: r.place,
    goods: r.goods,
    container: r.container_number ?? "",
    unit: r.unit,
    in_qty: r.quantity_in,
    out_qty: r.quantity_out,
    balance: r.balance,
    entered: r.entered_on ?? "",
    exited: r.exited_on ?? "",
    days_held: r.days_held,
    charge_days: r.charge_days,
    daily_rate: r.daily_rate,
    free_days: r.free_days,
    storage_charge: r.storage_charge,
    currency: r.currency,
    status: HOLD_STATUS[r.status]?.label ?? r.status,
    opened_by: r.opened_by_name ?? "",
    released_by: r.released_by_name ?? "",
    dockets: r.docket_count
  })), [rows]);

  const filterWords = [
    status === "stored" ? "in the store" : status === "all" ? "every hold"
      : HOLD_STATUS[status]?.label ?? status,
    place || null,
    shipmentId ? (fileLabel ?? "one file") : null,
    from ? `from ${from}` : null, to ? `to ${to}` : null,
    q ? `“${q}”` : null
  ].filter(Boolean).join(" · ");

  if (perms && !perms.view) {
    return (
      <section className="rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
        <p className="pv-title mb-6"><Warehouse aria-hidden />Warehouse</p>
        <p className="pane-note text-sm">
          This seat holds no warehouse duty, so the store's book is not part of the surface it can
          open. A director, a general manager or an operations manager holds it; billing and audit
          seats read it.
        </p>
      </section>
    );
  }

  const openCount = (rows ?? []).filter(r => r.status === "stored").length;

  return (
    <div className="space-y-24">
      <section className="rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
        <div className="flex flex-wrap items-start justify-between gap-12">
          <div className="min-w-0">
            <p className="pv-title mb-4">
              <Warehouse aria-hidden />{shipmentId ? "Holds on this file" : "The store's book"}
            </p>
            <p className="text-xs" style={tiny}>
              {rows === null ? "Opening the register…"
                : `${rows.length} hold${rows.length === 1 ? "" : "s"} — ${filterWords}`}
              {/* The default filter is the in-store book, so under it the second clause repeats the
                  first word for word. It earns its place only when the register is widened. */}
              {rows?.length && status !== "stored" ? ` · ${openCount} still in store` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-12">
            {perms?.entry && (
              <button type="button" onClick={() => openNew()}
                className="waisha-btn flex items-center gap-8 rounded-input px-16 py-8 text-xs font-semibold">
                <Package size={15} aria-hidden />
                {shipmentId ? "Open a hold for this file" : "Open a hold"}
              </button>
            )}
            {rows && rows.length > 0 && (
              <ExportButtons report="warehouse"
                title={shipmentId ? `Warehouse holds — ${fileLabel ?? "one file"}` : "Warehouse register"}
                subtitle={`Holds matching the desk: ${filterWords}`}
                meta={[
                  { label: "Filter", value: filterWords || "All" },
                  { label: "Priced against", value: rows[0]?.priced_on ?? "—" }
                ]}
                columns={[
                  { key: "ref", label: "Hold", type: "text", width: 130 },
                  { key: "file", label: "Cargo file", type: "text" },
                  { key: "consignee", label: "Consignee", type: "text" },
                  { key: "place", label: "Stored at", type: "text" },
                  { key: "goods", label: "Goods", type: "text" },
                  { key: "container", label: "Container", type: "text" },
                  { key: "unit", label: "Unit", type: "text", width: 70 },
                  { key: "in_qty", label: "In", type: "number" },
                  { key: "out_qty", label: "Out", type: "number" },
                  { key: "balance", label: "Balance", type: "number" },
                  { key: "entered", label: "Arrived", type: "date" },
                  { key: "exited", label: "Released", type: "date" },
                  { key: "days_held", label: "Days", type: "number" },
                  { key: "charge_days", label: "Chargeable", type: "number" },
                  { key: "daily_rate", label: "Rate/day", type: "money" },
                  { key: "free_days", label: "Free", type: "number" },
                  { key: "storage_charge", label: "Storage charge", type: "money" },
                  { key: "currency", label: "Curr.", type: "text", width: 60 },
                  { key: "status", label: "State", type: "text" },
                  { key: "opened_by", label: "Opened by", type: "text" },
                  { key: "released_by", label: "Released by", type: "text" },
                  { key: "dockets", label: "Dockets", type: "number" }
                ]}
                rows={exportRows} />
            )}
          </div>
        </div>

        {!shipmentId && (
          <div className="mt-16 flex flex-wrap items-end gap-10">
            <div role="group" aria-label="State filter" className="flex flex-wrap">
              {["stored", "all", ...Object.keys(HOLD_STATUS).filter(k => k !== "stored")].map((k) => (
                <button key={k} type="button" onClick={() => setStatus(k)} className="chip"
                  style={{
                    borderColor: status === k ? "var(--gold)" : "var(--line)",
                    background: status === k ? "color-mix(in srgb, var(--gold) 18%, transparent)" : undefined,
                    fontWeight: status === k ? 800 : 600
                  }}>
                  {k === "all" ? "Every hold" : HOLD_STATUS[k].label}
                </button>
              ))}
            </div>
            {summary && summary.byPlace.length > 0 && (
              <label className="block min-w-[170px]">
                <span className={labelCls} style={tiny}>Where</span>
                <select value={place} onChange={e => setPlace(e.target.value)}
                  className={inputCls} style={inputStyle}>
                  <option value="">Every place</option>
                  {summary.byPlace.map(p => (
                    <option key={p.place} value={p.place}>
                      {p.place} ({p.in_store} in store)
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block">
              <span className={labelCls} style={tiny}>Arrived from</span>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={tiny}>Arrived to</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block min-w-[190px] grow">
              <span className={labelCls} style={tiny}>Search hold, goods, place or file</span>
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="e.g. WH-2026-00012 or cartons of cement" className={inputCls} style={inputStyle} />
            </label>
            {(status !== "stored" || place || from || to || search) && (
              <button type="button" onClick={() => {
                setStatus("stored"); setPlace(""); setFrom(""); setTo(""); setSearch("");
              }}
                className="on-photo-btn flex items-center gap-6 rounded-input px-12 py-8 text-xs font-semibold">
                <X size={14} aria-hidden />Clear filters
              </button>
            )}
          </div>
        )}

        {err && (
          <div role="alert" className="mt-16 break-words px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{err}</div>
        )}
        {note && (
          <div role="status" className="mt-16 break-words px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{note}</div>
        )}

        <div ref={panelRef} className="mt-16 space-y-12">
          {panel?.act === "new" && (
            <Card title="Open a hold" onClose={closePanel}>
              {shipmentId && (
                <p className="pane-note mb-14 text-xs">
                  Against <strong>{fileLabel ?? "this cargo file"}</strong>.
                </p>
              )}
              <HoldFields draft={draft} setDraft={setDraft} files={files}
                hideFile={!!shipmentId} chosenLabel={fileLabel} />
              <p className="pane-note mt-14 text-xs">
                Counting the first goods in here opens the hold and files its first entry docket in
                one act. Leave the quantity blank and the hold waits — an empty hold costs the file
                nothing, because the days are counted from the day goods were actually received.
              </p>
              <div className="mt-12 flex flex-wrap items-center gap-12">
                <button type="button" disabled={busy} onClick={submitDraft}
                  className="waisha-btn rounded-input px-24 py-12 text-sm font-semibold disabled:opacity-60">
                  {busy ? "Filing…" : "Open the hold"}
                </button>
                <button type="button" onClick={closePanel}
                  className="underline text-xs" style={tiny}>Leave it</button>
              </div>
            </Card>
          )}

          {panel?.act === "edit" && panel.hold && (
            <Card title={`Re-tariff ${panel.hold.ref}`} onClose={closePanel}>
              <p className="pane-note mb-14 text-xs">
                {panel.hold.goods} at {panel.hold.place}, opened by{" "}
                {panel.hold.opened_by_name ?? "a seat no longer on the register"}. Only a hold still
                in the store can be re-tariffed — the day it was released, and every quantity, are
                the dockets' conclusions and live on the docket list.
              </p>
              <HoldFields draft={draft} setDraft={setDraft} files={[]} hideFile chosenLabel={panel.hold.file_number}
                lockGoods />
              <div className="mt-12 flex flex-wrap items-center gap-12">
                <button type="button" disabled={busy} onClick={submitDraft}
                  className="waisha-btn rounded-input px-24 py-12 text-sm font-semibold disabled:opacity-60">
                  {busy ? "Saving…" : "Save the tariff"}
                </button>
                <button type="button" onClick={closePanel}
                  className="underline text-xs" style={tiny}>Leave it as it was</button>
              </div>
            </Card>
          )}

          {(panel?.act === "entry" || panel?.act === "exit") && panel.hold && (
            <Card
              title={`${panel.act === "entry" ? "Count goods in" : "Let goods out"} — ${panel.hold.ref}`}
              onClose={closePanel}>
              <p className="pane-note mb-14 text-xs">
                {panel.hold.goods} at {panel.hold.place}. The store holds{" "}
                <strong>{units(panel.hold.balance)} {panel.hold.unit}</strong> of the{" "}
                {units(panel.hold.quantity_in)} that were received
                {panel.hold.entered_on ? `, counted in from ${panel.hold.entered_on}` : ""}.
                {panel.act === "exit" && panel.hold.balance > 0
                  ? " Taking the last of it releases the hold and freezes its tariff."
                  : ""}
              </p>
              <div className="grid gap-10 sm:grid-cols-2">
                <label className="block">
                  <span className={labelCls} style={tiny}>Day the goods moved *</span>
                  <input type="date" max={todayPlain()}
                    min={panel.act === "exit" ? panel.hold.entered_on ?? undefined : undefined}
                    value={slip.day} onChange={e => setSlip(x => ({ ...x, day: e.target.value }))}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={tiny}>
                    {panel.act === "entry" ? "How many came in" : "How many left"} * ({panel.hold.unit})
                  </span>
                  <input type="number" min={0.001} step="0.001" value={slip.quantity} autoFocus
                    onChange={e => setSlip(x => ({ ...x, quantity: e.target.value }))}
                    placeholder={panel.act === "exit" ? String(panel.hold.balance) : "e.g. 48"}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={tiny}>The paper it was counted against</span>
                  <input value={slip.docketRef} maxLength={60}
                    onChange={e => setSlip(x => ({ ...x, docketRef: e.target.value }))}
                    placeholder={panel.act === "entry" ? "e.g. delivery note 118" : "e.g. gate pass 4471"}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={tiny}>A word for the book</span>
                  <input value={slip.note} maxLength={300}
                    onChange={e => setSlip(x => ({ ...x, note: e.target.value }))}
                    placeholder="e.g. 6 cartons short, claimed on the carrier"
                    className={inputCls} style={inputStyle} />
                </label>
                <button type="button" disabled={busy}
                  onClick={() => submitSlip(panel.act as "entry" | "exit")}
                  className="waisha-btn flex items-center justify-center gap-8 rounded-input px-24 py-12 text-sm font-semibold disabled:opacity-60 sm:col-span-2">
                  {panel.act === "entry"
                    ? <ArrowDownToLine size={15} aria-hidden /> : <ArrowUpFromLine size={15} aria-hidden />}
                  {busy ? "Filing…" : panel.act === "entry" ? "File the entry docket" : "File the exit docket"}
                </button>
              </div>
              <p className="pane-note mt-12 text-xs">
                The docket is numbered by the register itself, from its own prefix and year. A
                future day is refused — the store's clock is the working day it was written on — and
                a hold cannot let out more than it holds.
              </p>
            </Card>
          )}

          {panel?.act === "cancel" && panel.hold && (
            <Card title={`Call ${panel.hold.ref} off`} onClose={closePanel}>
              <label className="block">
                <span className={labelCls} style={tiny}>Why the hold is off *</span>
                <input value={reason} maxLength={300} autoFocus
                  onChange={e => setReason(e.target.value)}
                  placeholder="e.g. opened for the wrong file; the goods went to another bond"
                  className={inputCls} style={inputStyle} />
              </label>
              <div className="mt-12 flex flex-wrap items-center gap-12">
                <button type="button" disabled={busy} onClick={submitCancel}
                  className="rounded-input border px-24 py-12 text-sm font-semibold disabled:opacity-60"
                  style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
                  {busy ? "Calling off…" : "Call the hold off"}
                </button>
                <button type="button" onClick={closePanel}
                  className="underline text-xs" style={tiny}>Keep it open</button>
              </div>
              <p className="pane-note mt-10 text-xs">
                Only a hold that never received a single unit can be called off. Goods that were
                counted in are got rid of by an exit docket, because a docket keeps the paper and
                the correction — a called-off hold counts as nothing held and bills the file
                nothing.
              </p>
            </Card>
          )}

          {panel?.act === "log" && panel.hold && (
            <Card title={`Dockets on ${panel.hold.ref}`} onClose={closePanel}>
              <p className="pane-note mb-14 text-xs">
                The book of the hold: every unit that came in and went out, in the order the store
                wrote it. {panel.hold.ref} reads {units(panel.hold.quantity_in)} in and{" "}
                {units(panel.hold.quantity_out)} out across {panel.hold.docket_count} filed
                docket{panel.hold.docket_count === 1 ? "" : "s"} — the figures are the sum of the
                lines still standing, not a number typed beside it. A struck-out line was filed
                wrong and counts for nothing, but the book keeps it with who voided it and why.
              </p>
              {dockets === null && <p className="pane-note text-sm">Reading the docket list…</p>}
              {dockets?.length === 0 && (
                <p className="pane-note text-sm">Nothing has been counted against this hold yet.</p>
              )}
              {dockets?.map(d => (
                <div key={d.id} className="flex flex-wrap items-baseline gap-8 border-b py-8 text-xs last:border-0"
                  style={{ borderColor: "var(--line)" }}>
                  <span className="font-bold tabular-nums"
                    style={{
                      color: d.state === "voided" ? "var(--ink-soft)" : (d.kind === "entry" ? "var(--success)" : "var(--gold)"),
                      textDecoration: d.state === "voided" ? "line-through" : undefined
                    }}>
                    {DOCKET_KIND[d.kind]?.sign ?? ""}{units(d.quantity)} {panel.hold.unit}
                  </span>
                  <span className="break-words font-semibold"
                    style={{ color: "var(--ink)", textDecoration: d.state === "voided" ? "line-through" : undefined }}>
                    {d.ref}
                  </span>
                  <span style={tiny}>{DOCKET_KIND[d.kind]?.label ?? d.kind} · {d.slip_day}</span>
                  {d.docket_ref && <span style={tiny}>paper {d.docket_ref}</span>}
                  {d.note && <span className="basis-full break-words" style={tiny}>“{d.note}”</span>}
                  <span className="basis-full text-[10px]" style={tiny}>
                    filed by {d.filed_by_name ?? "—"}
                    {d.state === "voided"
                      ? ` · voided by ${d.voided_by_name ?? "—"}${d.void_reason ? `: ${d.void_reason}` : ""}`
                      : ""}
                  </span>
                  {d.state === "filed" && panel.hold.can_void && perms?.void && (
                    <button type="button" className="ml-auto underline" style={{ color: "var(--danger)" }}
                      onClick={() => { setVoiding(d); setReason(""); setErr(null); }}>
                      Void this docket
                    </button>
                  )}
                </div>
              ))}

              {voiding && (
                <div className="mt-14 rounded-card border p-14" style={{ borderColor: "var(--danger)" }}>
                  <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>
                    Void {voiding.ref} — {units(voiding.quantity)} {panel.hold.unit} {voiding.kind === "entry" ? "in" : "out"} on {voiding.slip_day}
                  </p>
                  <label className="mt-10 block">
                    <span className={labelCls} style={tiny}>What was wrong with it *</span>
                    <input value={reason} maxLength={300} autoFocus
                      onChange={e => setReason(e.target.value)}
                      placeholder="e.g. counted 48, the store took 40" className={inputCls} style={inputStyle} />
                  </label>
                  <div className="mt-12 flex flex-wrap items-center gap-12">
                    <button type="button" disabled={busy} onClick={submitVoid}
                      className="rounded-input border px-24 py-12 text-sm font-semibold disabled:opacity-60"
                      style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
                      {busy ? "Voiding…" : "Void the docket"}
                    </button>
                    <button type="button" onClick={() => setVoiding(null)}
                      className="underline text-xs" style={tiny}>Leave it filed</button>
                  </div>
                  <p className="pane-note mt-10 text-xs">
                    The docket is not deleted — its state moves, with your name and your words on it,
                    and its quantity comes back out of the hold. An exit that is still standing
                    cannot be pulled out from under, so void later dockets first, or file the
                    delivery back in.
                  </p>
                </div>
              )}

              {panel.hold.can_enter && perms?.entry && (
                <button type="button" onClick={() => openPanel("entry", panel.hold)}
                  className="on-photo-btn mt-14 flex items-center gap-6 rounded-input px-16 py-8 text-xs font-semibold">
                  <ArrowDownToLine size={14} aria-hidden />Count more goods in
                </button>
              )}
              {/* The door refuses this paper, so the card says so rather than leaving the clerk to
                  wonder where the button went — and says the money reason, not just the rule. */}
              {panel.hold.status === "released" && (
                <p className="pane-note mt-12 text-xs">
                  This hold gave out everything it received, so its paper is closed. A new delivery
                  opens its own hold: counted into this one it would be charged from the day the
                  first crate arrived, not the day the new goods came in.
                </p>
              )}
            </Card>
          )}

          {panel?.act === "files" && panel.hold && (
            <Card title={`Papers on ${panel.hold.ref}`} onClose={closePanel}>
              {perms?.upload && (
                <div className="grid gap-10 sm:grid-cols-3">
                  <label className="block">
                    <span className={labelCls} style={tiny}>What the paper is</span>
                    <select value={paperKind} onChange={e => setPaperKind(e.target.value)}
                      className={inputCls} style={inputStyle}>
                      {PAPER_KINDS.map(k => <option key={k} value={k}>{DOC_KIND_LABELS[k] ?? k}</option>)}
                    </select>
                  </label>
                  <div className="sm:col-span-2">
                    <span className={labelCls} style={tiny}>Photograph or PDF (8 MB max)</span>
                    <input ref={fileRef} type="file"
                      accept="image/jpeg,image/png,image/webp,application/pdf"
                      onChange={attachPaper} className="hidden" aria-hidden />
                    <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
                      className="on-photo-btn flex items-center gap-8 rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">
                      <Paperclip size={14} aria-hidden />{busy ? "Filing…" : "Attach the paper"}
                    </button>
                  </div>
                </div>
              )}
              <div className="mt-14">
                {papers === null && <p className="pane-note text-sm">Reading the file list…</p>}
                {papers?.length === 0 && (
                  <p className="pane-note text-sm">No paper is filed against this hold yet.</p>
                )}
                {papers?.map(d => (
                  <div key={d.id} className="flex flex-wrap items-baseline gap-8 border-b py-8 text-xs last:border-0"
                    style={{ borderColor: "var(--line)" }}>
                    <span className="min-w-0 break-words font-semibold" style={{ color: "var(--ink)" }}>{d.file_name}</span>
                    <span style={tiny}>{DOC_KIND_LABELS[d.kind] ?? d.kind}</span>
                    <span style={tiny}>{fmtBytes(d.size_bytes)}</span>
                    <button type="button" className="underline" style={{ color: "var(--brand)" }}
                      onClick={() => openPaper(d.id)}>Open</button>
                  </div>
                ))}
              </div>
              <p className="pane-note mt-12 text-xs">
                The bytes live in the company's vault against this hold, and the vault page lists
                them too — <Link href="/app/documents" className="underline">Documents</Link>.
              </p>
            </Card>
          )}
        </div>

        {rows === null ? (
          <p className="pane-note mt-16 p-12 text-sm">Opening the store's book…</p>
        ) : rows.length === 0 ? (
          <p className="pane-note mt-16 p-12 text-sm">
            {status === "stored"
              ? shipmentId
                ? `Nothing of ${fileLabel ?? "this file"} is standing in a store right now.`
                : "Nothing is standing in a store right now. Open a hold and the goods appear here."
              : "No hold matches these filters. Widen the state or clear the search."}
          </p>
        ) : (
          <div className="mt-16 overflow-x-auto rounded-card border" style={{ borderColor: "var(--line)" }}>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", ...tiny }}>
                  <th className="p-12">Hold</th>
                  {!shipmentId && <th className="p-12">File</th>}
                  <th className="p-12">Goods / where</th>
                  <th className="p-12 text-right whitespace-nowrap">In · Out · Left</th>
                  <th className="p-12">Days</th>
                  <th className="p-12 text-right">Storage</th>
                  <th className="p-12">State</th>
                  <th className="p-12 text-right">Acts</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => {
                  const st = HOLD_STATUS[h.status] ?? {
                    label: h.status, color: "var(--ink-soft)", note: ""
                  };
                  return (
                    <tr key={h.id} className="border-b align-top last:border-0" style={{ borderColor: "var(--line)" }}>
                      <td className="p-12">
                        <span className="block whitespace-nowrap font-bold tabular-nums" style={{ color: "var(--ink)" }}>{h.ref}</span>
                        <span className="block" style={tiny}>{h.container_number ?? h.place}</span>
                        <span className="mt-4 flex flex-wrap items-center gap-6" style={tiny}>
                          <ScrollText size={11} aria-hidden />{h.docket_count} docket{h.docket_count === 1 ? "" : "s"}
                          {h.attachments > 0 && (
                            <><Paperclip size={11} aria-hidden />{h.attachments} paper{h.attachments === 1 ? "" : "s"}</>
                          )}
                        </span>
                      </td>
                      {!shipmentId && (
                        <td className="p-12">
                          <Link href={`/app/cfa/cargo/${h.shipment_id}`} className="break-words font-semibold underline"
                            style={{ color: "var(--brand)" }}>{h.file_number}</Link>
                          <span className="block break-words" style={tiny}>{h.consignee_name ?? "—"}</span>
                        </td>
                      )}
                      <td className="p-12">
                        <span className="block break-words font-semibold" style={{ color: "var(--ink)" }}>{h.goods}</span>
                        <span className="block break-words" style={tiny}>{h.place}</span>
                        <span className="block" style={tiny}>
                          {money(h.daily_rate)} {h.currency}/day · {h.free_days} free
                        </span>
                      </td>
                      <td className="p-12 text-right tabular-nums">
                        <span className="block" style={tiny}>+{units(h.quantity_in)}</span>
                        <span className="block" style={tiny}>−{units(h.quantity_out)}</span>
                        <span className="block font-bold" style={{ color: "var(--ink)" }}>
                          {units(h.balance)} {h.unit}
                        </span>
                      </td>
                      <td className="p-12">
                        <span className="block tabular-nums font-semibold" style={{ color: "var(--ink)" }}>
                          {h.days_held} day{h.days_held === 1 ? "" : "s"}
                        </span>
                        <span className="block" style={tiny}>
                          {h.entered_on ? `since ${h.entered_on}` : "not received"}
                          {h.exited_on ? ` → ${h.exited_on}` : ""}
                        </span>
                        <span className="block text-[10px]" style={tiny}>{heldFor(h.days_held, h.charge_days, h.free_days)}</span>
                      </td>
                      <td className="p-12 text-right tabular-nums">
                        <span className="block font-bold"
                          style={{ color: h.storage_charge > 0 ? "var(--danger)" : "var(--success)" }}>
                          {sum(h.storage_charge, [h.currency])}
                        </span>
                        <span className="block text-[10px]" style={tiny}>
                          {h.charge_days} × {money(h.daily_rate)}
                        </span>
                      </td>
                      <td className="p-12">
                        <span className="block px-8 py-4 text-[10px] font-bold uppercase"
                          style={{ borderLeft: `4px solid ${st.color}`, color: "var(--ink)" }}>
                          {st.label}
                        </span>
                        {h.cancel_reason && (
                          <span className="mt-4 block break-words text-[10px]" style={tiny}>{h.cancel_reason}</span>
                        )}
                        {h.status === "released" && h.released_by_name && (
                          <span className="mt-4 block text-[10px]" style={tiny}>by {h.released_by_name}</span>
                        )}
                      </td>
                      <td className="p-12 whitespace-nowrap text-right">
                        <div className="flex flex-wrap justify-end gap-6">
                          {h.can_enter && (
                            <ActButton label="Goods in" primary onClick={() => openPanel("entry", h)} />
                          )}
                          {h.can_exit && (
                            <ActButton label="Goods out" onClick={() => openPanel("exit", h)} />
                          )}
                          <ActButton label="Dockets" onClick={() => openPanel("log", h)} />
                          {h.can_edit && <ActButton label="Tariff" onClick={() => openPanel("edit", h)} />}
                          {h.can_cancel && <ActButton label="Call off" danger onClick={() => openPanel("cancel", h)} />}
                          <ActButton label="Papers" onClick={() => openPanel("files", h)} />
                        </div>
                        {!h.can_edit && h.edit_block === "no_key" && h.status === "stored" && (
                          <span className="mt-6 block max-w-[220px] text-right text-[10px]" style={tiny}>
                            a seat that holds the warehouse edit duty sets a tariff
                          </span>
                        )}
                        {h.status === "released" && (
                          <span className="mt-6 block max-w-[220px] text-right text-[10px]" style={tiny}>
                            emptied — a new delivery opens its own hold
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="pane-note mt-16 text-xs">
          Every figure in the Days and Storage columns is priced against the store's clock —{" "}
          {rows?.[0]?.priced_on ?? "the working day"}. A hold still in the store grows by a day each
          morning, so a hold you looked at yesterday can cost more today without anybody touching
          it. The charge is never stored: it is worked out from the arrival day, the tariff and the
          free period, and the same number lands on the cargo file's cost side.
        </p>
      </section>

      {summary && !shipmentId && (
        <section className="rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
          <p className="pv-title mb-4"><CircleDollarSign aria-hidden />What the store is holding and costing</p>
          <p className="text-xs" style={tiny}>
            Footed from every hold of this company, priced on {summary.totals.priced_on} — the
            figures below do not follow the filter above.
          </p>

          <div className="mt-16 grid grid-cols-2 gap-10 sm:grid-cols-4">
            <Tile label="Holds in the store" value={String(summary.totals.in_store)}
              note={`${summary.totals.holds} opened · ${summary.totals.released} released · ${summary.totals.cancelled} called off`} />
            <Tile label="Units still held" value={units(summary.totals.held_quantity)}
              note="counts every unit word together — read a row for one hold's own" />
            <Tile label="Storage to date"
              value={summary.byCurrency.length === 1
                ? `${summary.byCurrency[0].currency} ${money(summary.byCurrency[0].charge)}`
                : summary.byCurrency.length === 0 ? "—" : `${summary.byCurrency.length} currencies`}
              note={summary.byCurrency.length > 1
                ? "not added together — see the table"
                : "billed into each file's cost side"} />
            <Tile label="Places in use" value={String(summary.byPlace.length)}
              note={summary.byPlace[0] ? `${summary.byPlace[0].in_store} at ${summary.byPlace[0].place}` : "no place named yet"} />
          </div>

          {summary.byCurrency.length > 0 && (
            <div className="mt-16 overflow-x-auto rounded-card border" style={{ borderColor: "var(--line)" }}>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-right" style={{ borderColor: "var(--line)", ...tiny }}>
                    <th className="p-12 text-left">Currency</th>
                    <th className="p-12">Holds</th>
                    <th className="p-12">Storage charge</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byCurrency.map((c) => (
                    <tr key={c.currency} className="border-b text-right tabular-nums last:border-0"
                      style={{ borderColor: "var(--line)" }}>
                      <td className="p-12 text-left font-bold" style={{ color: "var(--ink)" }}>{c.currency}</td>
                      <td className="p-12" style={tiny}>{c.holds}</td>
                      <td className="p-12 font-bold" style={{ color: "var(--ink)" }}>{money(c.charge)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {summary.byCurrency.length > 1 && (
            <p className="pane-note mt-10 text-xs" style={{ color: "var(--warning)" }}>
              Holds here are billed in {summary.byCurrency.map(c => c.currency).join(" and ")}. The
              tile above cannot add those together, so it says how many currencies there are — the
              table is the only place the money is exact.
            </p>
          )}

          <div className="mt-24 grid gap-24 lg:grid-cols-2">
            <div>
              <p className="pv-title"><Boxes aria-hidden />By place</p>
              {summary.byPlace.length === 0 && <p className="pane-note text-sm">No hold has named a place.</p>}
              {summary.byPlace.map((p) => (
                <div key={p.place} className="flex flex-wrap items-baseline gap-8 border-b py-8 text-xs last:border-0"
                  style={{ borderColor: "var(--line)" }}>
                  <button type="button" className="min-w-0 break-words text-left font-semibold underline"
                    style={{ color: "var(--ink)" }} onClick={() => { setPlace(p.place); setStatus("all"); }}>
                    {p.place}
                  </button>
                  <span style={tiny}>{p.in_store} in store · {p.holds} opened</span>
                  <span className="ml-auto tabular-nums" style={tiny}>
                    {units(p.held_quantity)} held{p.oldest_entry ? ` · oldest ${p.oldest_entry}` : ""}
                  </span>
                </div>
              ))}
            </div>
            <div>
              <p className="pv-title"><Warehouse aria-hidden />Files costing the most to sit on</p>
              {summary.byFile.length === 0 && (
                <p className="pane-note text-sm">Nothing is standing in a store, so nothing is costing a file.</p>
              )}
              {summary.byFile.map((f) => (
                <div key={`${f.file_number}-${f.currency}`}
                  className="flex flex-wrap items-baseline gap-8 border-b py-8 text-xs last:border-0"
                  style={{ borderColor: "var(--line)" }}>
                  <span className="min-w-0 break-words font-semibold" style={{ color: "var(--ink)" }}>
                    {f.file_number}
                  </span>
                  <span className="break-words" style={tiny}>
                    {f.consignee_name ?? "—"} · {f.holds} hold{f.holds === 1 ? "" : "s"}
                  </span>
                  <span className="ml-auto tabular-nums font-bold" style={{ color: "var(--danger)" }}>
                    {f.currency} {money(f.charge)}
                  </span>
                </div>
              ))}
              <p className="pane-note mt-10 text-xs">
                These are holds still in the store. Each figure is the storage charge that will be
                billed into that file's cost side, and the file's own margin read already subtracts
                it.
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function Card({ title, onClose, children }: {
  title: string; onClose?: () => void; children: React.ReactNode;
}) {
  return (
    <div className="rounded-card border bg-surface p-24" style={{ borderColor: "var(--gold)" }}>
      <div className="flex flex-wrap items-start justify-between gap-10">
        <p className="pv-title mb-0">{title}</p>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close this panel"
            className="flex items-center gap-6 text-xs" style={tiny}>
            <X size={14} aria-hidden />Close
          </button>
        )}
      </div>
      <div className="mt-16">{children}</div>
    </div>
  );
}

function ActButton({ label, onClick, primary, danger }: {
  label: string; onClick: () => void; primary?: boolean; danger?: boolean;
}) {
  return (
    <button type="button" onClick={onClick}
      className={primary ? "waisha-btn rounded-input px-12 py-8 text-[11px] font-semibold"
        : "rounded-input border px-12 py-8 text-[11px] font-semibold"}
      style={primary ? undefined : {
        borderColor: danger ? "var(--danger)" : "var(--line)",
        color: danger ? "var(--danger)" : "var(--ink)"
      }}>
      {label}
    </button>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-card border p-16" style={{ borderColor: "var(--line)" }}>
      <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={tiny}>{label}</p>
      <p className="mt-6 break-words text-lg font-extrabold tabular-nums" style={{ color: "var(--ink)" }}>{value}</p>
      {note && <p className="mt-4 text-[11px]" style={tiny}>{note}</p>}
    </div>
  );
}

/**
 * The hold's own sheet — the file it belongs to, where the goods stand and what they cost a day.
 *
 * Quantities are deliberately absent from the edit path: `quantity_in`, `quantity_out`,
 * `entered_on`, `exited_on` and `status` are what migration 118's triggers conclude from the
 * dockets, and a form that could type them would be a form that could disagree with its own book.
 */
function HoldFields({ draft, setDraft, files, hideFile, chosenLabel, lockGoods }: {
  draft: ReturnType<typeof blankHold>;
  setDraft: (fn: (x: ReturnType<typeof blankHold>) => ReturnType<typeof blankHold>) => void;
  files: FileOption[];
  hideFile?: boolean;
  chosenLabel?: string;
  /** A tariff correction names the goods in the caption above it; rewriting them is not the act. */
  lockGoods?: boolean;
}) {
  const set = (k: keyof ReturnType<typeof blankHold>, v: unknown) => setDraft(x => ({ ...x, [k]: v }));
  const chosen = files.find(f => f.id === draft.fileId);
  return (
    <div className="grid gap-10 sm:grid-cols-3">
      {!hideFile && (
        <label className="block sm:col-span-2">
          <span className={labelCls} style={tiny}>Cargo file the goods belong to *</span>
          <select value={draft.fileId} onChange={e => set("fileId", e.target.value)}
            className={inputCls} style={inputStyle}>
            <option value="">Select a file</option>
            {files.map(f => (
              <option key={f.id} value={f.id}>
                {f.file_number} — {f.consignee_name ?? "no consignee"}
                {f.holds_in_store ? ` (${f.holds_in_store} in store)` : ""}
              </option>
            ))}
          </select>
          {chosen && (
            <span className="mt-4 block text-[10px]" style={tiny}>
              {chosen.shipment_type.replace(/_/g, " ")} · {chosen.status} · stage {chosen.stage}
              {chosen.container_count ? ` · ${chosen.container_count} container(s)` : ""}
            </span>
          )}
          {files.length === 0 && !chosen && (
            <span className="mt-4 block text-[10px]" style={tiny}>
              No cargo file is on the picker — a hold is opened against a file, so register the
              file first.
            </span>
          )}
        </label>
      )}
      {hideFile && chosenLabel && (
        <p className="pane-note sm:col-span-3 text-xs">
          Against <strong>{chosenLabel}</strong>. A hold always belongs to a cargo file — it is the
          file that is billed for the days.
        </p>
      )}
      <label className="block">
        <span className={labelCls} style={tiny}>Stored at *</span>
        <input value={draft.place} maxLength={120}
          onChange={e => set("place", e.target.value)}
          placeholder="e.g. TBL bond, Dar es Salaam" className={inputCls} style={inputStyle} />
      </label>
      <label className="block sm:col-span-2">
        <span className={labelCls} style={tiny}>What the goods are *</span>
        <input value={draft.goods} maxLength={200} disabled={lockGoods}
          onChange={e => set("goods", e.target.value)}
          placeholder="e.g. 48 cartons of machine spare parts" className={inputCls} style={inputStyle} />
      </label>
      <label className="block">
        <span className={labelCls} style={tiny}>Counted in</span>
        <input value={draft.unit} maxLength={24} disabled={lockGoods}
          onChange={e => set("unit", e.target.value)}
          placeholder="pcs, cartons, pallets, drums…" className={inputCls} style={inputStyle} />
      </label>
      <label className="block sm:col-span-2">
        <span className={labelCls} style={tiny}>Container or seal number</span>
        <input value={draft.containerNumber} maxLength={30}
          onChange={e => set("containerNumber", e.target.value)}
          placeholder="e.g. MSKU7788120" className={inputCls} style={inputStyle} />
      </label>
      <label className="block">
        <span className={labelCls} style={tiny}>Rate a day *</span>
        <input type="number" min={0} step="0.01" value={draft.dailyRate}
          onChange={e => set("dailyRate", e.target.value)} placeholder="0.00"
          className={inputCls} style={inputStyle} />
      </label>
      <label className="block">
        <span className={labelCls} style={tiny}>Currency</span>
        <select value={draft.currency} onChange={e => set("currency", e.target.value)}
          className={inputCls} style={inputStyle}>
          {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className="block">
        <span className={labelCls} style={tiny}>Free days</span>
        <input type="number" min={0} max={365} step={1} value={draft.freeDays}
          onChange={e => set("freeDays", e.target.value)} className={inputCls} style={inputStyle} />
      </label>
      <label className="block sm:col-span-3">
        <span className={labelCls} style={tiny}>A word for the book</span>
        <textarea rows={2} maxLength={1000} value={draft.notes}
          onChange={e => set("notes", e.target.value)} className={inputCls} style={inputStyle} />
      </label>

      {/* Counting in belongs to opening a hold only — later movements are dockets on the row. */}
      {!lockGoods && (
        <>
          <label className="block">
            <span className={labelCls} style={tiny}>Goods received on</span>
            <input type="date" max={todayPlain()} value={draft.entryDay}
              onChange={e => set("entryDay", e.target.value)} className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={tiny}>How many came in</span>
            <input type="number" min={0.001} step="0.001" value={draft.quantity}
              onChange={e => set("quantity", e.target.value)} placeholder="blank = nothing received yet"
              className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={tiny}>The paper it was counted against</span>
            <input value={draft.docketRef} maxLength={60}
              onChange={e => set("docketRef", e.target.value)} placeholder="e.g. delivery note 118"
              className={inputCls} style={inputStyle} />
          </label>
        </>
      )}
    </div>
  );
}
