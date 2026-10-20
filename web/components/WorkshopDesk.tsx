"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, CalendarClock, CircleDollarSign, Gauge, Paperclip,
  Plus, Wrench, X
} from "lucide-react";
import { apiFetch, seatPermissions } from "@/app/app/api-client";
import { ExportButtons } from "@/components/ExportButtons";

/**
 * The workshop desk — migration 109's register over HTTP.
 *
 * One component, two surfaces: the whole-company register at /app/fleet/workshop and the
 * single-plate panel inside a vessel's file. It is one file on purpose. The acts on a card
 * (raise, edit, move, return, call off, attach the bill) are small in number and easy to
 * re-implement wrongly, and the version on the plate's own file must refuse exactly what the
 * register refuses.
 *
 * Every button here answers to a field the server sent beside the row — `can_move`,
 * `can_return`, `close_block`, `cancel_block` — because the rule that says who may sign a
 * truck back onto the road also reads who wrote the card and whether the plate has already
 * moved, and a page cannot see any of that.
 */

export interface WorkOrder {
  id: string; ref: string; raised_on: string; title: string; detail: string | null;
  kind: string; place: string; garage_name: string | null; garage_reference: string | null;
  mechanic_employee_id: string | null; mechanic_name: string | null; mechanic_role: string | null;
  mechanic_status: string | null; mechanic_removed: boolean;
  vessel_id: string; vessel_name: string; plate_number: string; vessel_status: string;
  vessel_odometer_km: number | null;
  status: string; odometer_in_km: number | null; odometer_out_km: number | null;
  parts_cost: string; labour_cost: string; other_cost: string; total_cost: string;
  currency: string; invoice_ref: string | null;
  opened_at: string | null; opened_by_name: string | null;
  returned_at: string | null; returned_by_name: string | null;
  cancel_reason: string | null; cancelled_by_name: string | null;
  created_at: string; created_by_name: string | null;
  attachments: number;
  can_edit: boolean; can_move: boolean; can_return: boolean; can_cancel: boolean;
  close_block: string | null; cancel_block: string | null;
}

interface Summary {
  totals: { orders: number; open: number; cancelled: number; currencies: string[] | null };
  byCurrency: {
    currency: string; orders: number; parts: string; labour: string; other: string; total: string;
  }[];
  perVessel: {
    vessel_id: string; name: string; plate_number: string; vessel_status: string;
    open_orders: number; returned_orders: number; spent: string; last_raised: string | null;
  }[];
  perKind: { kind: string; orders: number; cost: string }[];
  perGarage: { garage: string; orders: number; cost: string; last_job: string | null }[];
  window_days: number;
}

interface Option { id: string; name: string; plate_number: string; status: string; odometer_km: number }
interface Mechanic {
  id: string; full_name: string; job_title: string | null; department: string | null;
  status: string; open_cards: number;
}
interface Doc {
  id: string; kind: string; file_name: string; mime_type: string;
  size_bytes: number; created_at: string;
}

const KINDS: Record<string, string> = {
  service: "Service", repair: "Repair", tyre: "Tyre", electrical: "Electrical",
  bodywork: "Bodywork", inspection: "Inspection", accident: "Accident", other: "Other"
};
const STATUSES: Record<string, string> = {
  raised: "Raised", in_workshop: "In the workshop", awaiting_parts: "Held for parts",
  returned: "Back on the road", cancelled: "Called off"
};
const STATUS_COLORS: Record<string, string> = {
  raised: "var(--brand)", in_workshop: "var(--warning)", awaiting_parts: "var(--gold)",
  returned: "var(--success)", cancelled: "var(--ink-soft)"
};
const OPEN = ["raised", "in_workshop", "awaiting_parts"];
const PLACES: Record<string, string> = { in_house: "In house", outside_garage: "Outside garage" };
/** The kinds a garage bill can be filed under. `other` stays available: a slip of paper from a
 *  small garage is neither of the two named ones and must not be forced into a wrong label. */
const BILL_KINDS: Record<string, string> = {
  invoice: "Garage invoice", receipt: "Paid receipt", other: "Slip / other paper"
};
const CURRENCIES = ["TZS", "USD", "KES"];

const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const tiny = { color: "var(--ink-soft)" };

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

const money = (v: unknown) => Number(v ?? 0).toLocaleString("en", { maximumFractionDigits: 2 });
const km = (v: unknown) => (v == null ? "—" : `${Number(v).toLocaleString()} km`);

/** The card's day, in the operator's own calendar. `toISOString` is UTC, so a card raised at
 *  06:00 in Dar would print yesterday's date — the same drift the API now answers with ::text. */
function todayPlain(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function stamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso)
    : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

const blankDraft = (vesselId = "") => ({
  vesselId, raisedOn: todayPlain(), title: "", detail: "", kind: "service",
  place: "outside_garage", garageName: "", garageReference: "", mechanicEmployeeId: "",
  odometerInKm: "", partsCost: "", labourCost: "", otherCost: "", currency: "TZS", invoiceRef: ""
});

type Act = "new" | "edit" | "move" | "return" | "cancel" | "files";
type Panel = { act: Act; order?: WorkOrder } | null;

export function WorkshopDesk({ vesselId, plateLabel, onChanged }: {
  /** Lock the register to one plate — the dossier panel passes it, the desk page does not. */
  vesselId?: string;
  plateLabel?: string;
  /** Called after any write, so the plate's own file re-reads the status this register moved. */
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<WorkOrder[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [mechanics, setMechanics] = useState<Mechanic[]>([]);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [perms, setPerms] = useState<Record<string, boolean> | null>(null);

  const [status, setStatus] = useState<string>(vesselId ? "all" : "open");
  const [place, setPlace] = useState("");
  const [vesselFilter, setVesselFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  // Every keystroke refires the register read, and each read is a round trip through a remote
  // pooler — the desk waits for the typing to stop before it asks.
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);
  const [days, setDays] = useState(365);

  const [panel, setPanel] = useState<Panel>(null);
  const [draft, setDraft] = useState(blankDraft(vesselId ?? ""));
  const [move, setMove] = useState({ status: "in_workshop", note: "" });
  const [ret, setRet] = useState({
    odometerOutKm: "", roadworthy: true, partsCost: "", labourCost: "",
    otherCost: "", currency: "TZS", invoiceRef: "", note: ""
  });
  const [reason, setReason] = useState("");
  const [billKind, setBillKind] = useState("invoice");

  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const listReq = useRef(0);
  // Which card the open panel belongs to. A write through a remote pooler takes seconds, and in
  // that time the operator can open another card's panel; the reply must then leave that panel
  // alone rather than closing it or clearing the draft being typed into it.
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
    if (vesselId) qs.set("vesselId", vesselId);
    else if (vesselFilter) qs.set("vesselId", vesselFilter);
    const res = await apiFetch(`/work-orders?${qs.toString()}`);
    const rowsOut = res.ok ? await res.json() : null;
    const listErr = res.ok ? null : errorText(await res.json().catch(() => ({})), "The register would not open.");
    const s = await apiFetch(`/work-orders/summary?days=${days}`);
    const sumOut = s.ok ? await s.json() : null;
    // Two filter changes a second apart put two answers on the wire. Whichever lands last is not
    // necessarily the one that asked for what the operator now sees, so only the newest reply may
    // paint the register.
    if (mine !== listReq.current) return;
    if (rowsOut) setRows(rowsOut);
    else { setRows([]); setErr(listErr); }
    if (sumOut) setSummary(sumOut);
  }, [status, place, from, to, q, vesselId, vesselFilter, days]);

  useEffect(() => {
    let live = true;
    seatPermissions().then((keys) => {
      if (!live) return;
      setPerms({
        view: keys.has("work_orders.view"), create: keys.has("work_orders.create"),
        edit: keys.has("work_orders.edit"), close: keys.has("work_orders.close"),
        upload: keys.has("documents.create"), seeDocs: keys.has("documents.view")
      });
    });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!perms?.view) return;
    load();
  }, [load, perms]);

  // The pickers are read once: the fleet only changes when a vessel is registered, and the
  // mechanic list only changes when a desk edits staff — neither happens while this panel is open.
  useEffect(() => {
    if (!perms?.view) return;
    apiFetch("/vessels").then(async (r) => {
      if (!r.ok) return;
      const j = await r.json();
      setOptions((j.vessels ?? []).map((v: any) => ({
        id: v.id, name: v.name, plate_number: v.plate_number,
        status: v.status, odometer_km: Number(v.odometer_km ?? 0)
      })));
    }).catch(() => { });
    apiFetch("/work-orders/mechanics").then(async (r) => {
      if (!r.ok) return;
      setMechanics(await r.json());
    }).catch(() => { });
  }, [perms]);

  /** Post the act, then read the register again. The body comes back because the captions below
   *  restate what the plate's own state now is, and only the route that moved it knows that. */
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
    openAct.current = next ? { act: next.act, id: next.order?.id ?? null } : null;
    setPanel(next);
    if (!next) return;
    // Two surfaces, one scroll: on a phone the table can be long and the panel would open off-screen.
    requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function openPanel(next: Exclude<Act, "new">, order: WorkOrder) {
    setErr(null); setNote(null);
    if (next === "edit") {
      setDraft({
        vesselId: order.vessel_id, raisedOn: order.raised_on, title: order.title,
        detail: order.detail ?? "", kind: order.kind, place: order.place,
        garageName: order.garage_name ?? "", garageReference: order.garage_reference ?? "",
        mechanicEmployeeId: order.mechanic_employee_id ?? "",
        odometerInKm: order.odometer_in_km == null ? "" : String(order.odometer_in_km),
        partsCost: Number(order.parts_cost ?? 0) ? String(order.parts_cost) : "",
        labourCost: Number(order.labour_cost ?? 0) ? String(order.labour_cost) : "",
        otherCost: Number(order.other_cost ?? 0) ? String(order.other_cost) : "",
        currency: order.currency ?? "TZS", invoiceRef: order.invoice_ref ?? ""
      });
    } else if (next === "move") {
      setMove({ status: "in_workshop", note: "" });
    } else if (next === "return") {
      const ahead = Math.max(Number(order.odometer_in_km ?? 0), Number(order.vessel_odometer_km ?? 0));
      setRet({
        odometerOutKm: ahead ? String(ahead) : "", roadworthy: true,
        partsCost: Number(order.parts_cost ?? 0) ? String(order.parts_cost) : "",
        labourCost: Number(order.labour_cost ?? 0) ? String(order.labour_cost) : "",
        otherCost: Number(order.other_cost ?? 0) ? String(order.other_cost) : "",
        currency: order.currency ?? "TZS", invoiceRef: order.invoice_ref ?? "", note: ""
      });
    } else if (next === "cancel") {
      setReason("");
    } else if (next === "files") {
      setDocs(null); setBillKind("invoice");
      apiFetch(`/documents?entityType=work_order&entityId=${order.id}`)
        .then(async (r) => {
          const list = r.ok ? await r.json() : [];
          if (stillOwns("files", order.id)) setDocs(list);
        })
        .catch(() => setDocs([]));
    }
    showPanel({ act: next, order });
  }

  function openNew(prefill: string) {
    setDraft(blankDraft(prefill)); setErr(null); setNote(null);
    showPanel({ act: "new" });
  }

  function closePanel() { showPanel(null); setErr(null); setNote(null); }

  /** After a write: fold the panel away but leave the receipt on the register. The sentence that
   *  says which card was numbered, or what the plate's state now is, is the only place an operator
   *  sees the reference the server just minted — wiping it with the form throws that answer away. */
  function finishPanel() { showPanel(null); setErr(null); }

  function draftProblems(): string | null {
    if (draft.title.trim().length < 3) return "The job needs a title of at least three letters.";
    if (!draft.raisedOn) return "The card needs the day the work was asked for.";
    if (draft.raisedOn > todayPlain()) return "A work order cannot be dated after today.";
    if (!draft.vesselId) return "Pick the vehicle this card is about.";
    if (draft.place === "outside_garage" && !draft.garageName.trim())
      return "A job sent outside names the garage that has the vehicle.";
    if (draft.place === "in_house" && !draft.mechanicEmployeeId)
      return "An in-house job names the mechanic who will do it.";
    return null;
  }

  async function submitDraft() {
    const bad = draftProblems();
    if (bad) { setErr(bad); return; }
    const payload = {
      raisedOn: draft.raisedOn, title: draft.title.trim(), detail: draft.detail.trim() || null,
      kind: draft.kind, place: draft.place,
      garageName: draft.place === "outside_garage" ? draft.garageName.trim() : null,
      garageReference: draft.garageReference.trim() || null,
      mechanicEmployeeId: draft.mechanicEmployeeId || null,
      odometerInKm: draft.odometerInKm === "" ? null : Number(draft.odometerInKm),
      partsCost: draft.partsCost === "" ? 0 : Number(draft.partsCost),
      labourCost: draft.labourCost === "" ? 0 : Number(draft.labourCost),
      otherCost: draft.otherCost === "" ? 0 : Number(draft.otherCost),
      currency: draft.currency, invoiceRef: draft.invoiceRef.trim() || null
    };
    if (Number.isNaN(payload.odometerInKm ?? NaN) || Number.isNaN(payload.partsCost)
      || Number.isNaN(payload.labourCost) || Number.isNaN(payload.otherCost)) {
      setErr("Odometer and costs are numbers — check the boxes you just typed in.");
      return;
    }
    setErr(null);
    const editing = panel?.act === "edit" ? panel.order : undefined;
    const out = editing
      ? await send(`/work-orders/${editing.id}`, "PUT", payload)
      : await send("/work-orders", "POST", { vesselId: draft.vesselId, ...payload });
    if (out.err) { setErr(out.err); return; }
    setNote(editing
      ? `${editing.ref} corrected. The register keeps what it said before.`
      : `Work order ${out.data?.ref ?? ""} raised — the card is numbered and filed.`);
    if (editing ? stillOwns("edit", editing.id) : stillOwns("new", null)) {
      if (!editing) setDraft(blankDraft(vesselId ?? ""));
      finishPanel();
    }
  }

  async function submitMove() {
    const o = panel!.order!;
    const out = await send(`/work-orders/${o.id}/workshop`, "POST", {
      status: move.status, note: move.note.trim() || null
    });
    if (out.err) { setErr(out.err); return; }
    setNote(`${o.ref} ${move.status === "awaiting_parts" ? "is on the parts shelf"
      : "is open in the workshop"}. `
      + (out.data?.vesselMoved
        ? `${vesselId ? "This plate" : "The vehicle"} now reads In garage.`
        : "The vehicle's own state already read In garage, so it was left as it stands."));
    if (stillOwns("move", o.id)) finishPanel();
  }

  async function submitReturn() {
    const o = panel!.order!;
    const reading = Number(ret.odometerOutKm);
    if (ret.odometerOutKm === "" || !Number.isInteger(reading) || reading < 0) {
      setErr("The odometer reading when the vehicle came back is required, in whole kilometres.");
      return;
    }
    if (o.odometer_in_km != null && reading < Number(o.odometer_in_km)) {
      setErr(`The card opened at ${Number(o.odometer_in_km).toLocaleString()} km, so it cannot come back at ${reading.toLocaleString()} km.`);
      return;
    }
    const payload = {
      odometerOutKm: reading, roadworthy: ret.roadworthy,
      partsCost: ret.partsCost === "" ? undefined : Number(ret.partsCost),
      labourCost: ret.labourCost === "" ? undefined : Number(ret.labourCost),
      otherCost: ret.otherCost === "" ? undefined : Number(ret.otherCost),
      currency: ret.currency, invoiceRef: ret.invoiceRef.trim() || null,
      note: ret.note.trim() || null
    };
    const out = await send(`/work-orders/${o.id}/return`, "POST", payload);
    if (out.err) { setErr(out.err); return; }
    const d = out.data ?? {};
    setNote(`${o.ref} closed. `
      + (d.vessel_status_changed
        ? `${vesselId ? "This plate" : "The vehicle"} reads `
        + `${d.vessel_status === "standby" ? "Standby — back on the road" : "Out of service until somebody signs it off"}`
        : "the vehicle's own state was left as it stands, because this card did not park it")
      + (d.vessel_odometer_updated
        ? `; its register reading moved to ${reading.toLocaleString()} km.`
        : `; the register already held a newer reading for the plate, so its odometer stayed put.`));
    if (stillOwns("return", o.id)) finishPanel();
  }

  async function submitCancel() {
    const o = panel!.order!;
    if (reason.trim().length < 3) { setErr("Say why the job was called off — the card keeps the words."); return; }
    const out = await send(`/work-orders/${o.id}/cancel`, "POST", { reason: reason.trim() });
    if (out.err) { setErr(out.err); return; }
    setNote(`${o.ref} called off. Its costs were zeroed so the register cannot bill a job that never `
      + `happened${out.data?.vessel_released ? ", and the plate is marked Standby again." : "."}`);
    if (stillOwns("cancel", o.id)) finishPanel();
  }

  async function attachBill(ev: React.ChangeEvent<HTMLInputElement>) {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    const o = panel?.order;
    if (!f || !o) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      // Metadata before the file part: the API reads fields as they arrive, and a field that
      // comes after the bytes is a field it never sees.
      fd.append("entityType", "work_order");
      fd.append("entityId", o.id);
      fd.append("kind", billKind);
      fd.append("file", f);
      const res = await apiFetch("/documents", { method: "POST", body: fd });
      if (!res.ok) { setErr(errorText(await res.json().catch(() => ({})), "The file would not attach.")); return; }
      setNote(`“${f.name}” filed against ${o.ref}.`);
      const r = await apiFetch(`/documents?entityType=work_order&entityId=${o.id}`);
      const list = r.ok ? await r.json() : [];
      // Another card's paper list must not be painted with this card's answer.
      if (stillOwns("files", o.id)) setDocs(list);
      await load();
    } finally { setBusy(false); }
  }

  async function openDoc(id: string) {
    const res = await apiFetch(`/documents/${id}/url`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.url) { setErr(errorText(j, "Could not open the file.")); return; }
    window.open(j.url, "_blank", "noopener,noreferrer");
  }

  const exportRows = useMemo(() => (rows ?? []).map((r) => ({
    ref: r.ref,
    raised: r.raised_on,
    vehicle: r.vessel_name,
    plate: r.plate_number,
    kind: KINDS[r.kind] ?? r.kind,
    where: r.place === "outside_garage" ? (r.garage_name ?? "outside garage") : "in house",
    mechanic: r.place === "outside_garage" ? "—" : (r.mechanic_name ?? "—"),
    status: STATUSES[r.status] ?? r.status,
    in_km: r.odometer_in_km ?? null,
    out_km: r.odometer_out_km ?? null,
    parts: Number(r.parts_cost ?? 0),
    labour: Number(r.labour_cost ?? 0),
    other: Number(r.other_cost ?? 0),
    total: Number(r.total_cost ?? 0),
    currency: r.currency,
    invoice: r.invoice_ref ?? "",
    raised_by: r.created_by_name ?? "",
    closed_by: r.returned_by_name ?? r.cancelled_by_name ?? ""
  })), [rows]);

  const filterWords = [
    status === "open" ? "open cards" : status === "all" ? "every card" : STATUSES[status],
    place ? PLACES[place] : null,
    (vesselId ? plateLabel : vesselFilter
      ? options.find(o => o.id === vesselFilter)?.plate_number : null),
    from ? `from ${from}` : null, to ? `to ${to}` : null,
    q ? `“${q}”` : null
  ].filter(Boolean).join(" · ");

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-12">
      <div className="min-w-0">
        <p className="pv-title mb-4"><Wrench aria-hidden />{vesselId ? "Workshop cards for this plate" : "Work order register"}</p>
        <p className="text-xs" style={tiny}>
          {rows === null ? "Opening the register…"
            : `${rows.length} card${rows.length === 1 ? "" : "s"} — ${filterWords}`}
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-12">
        {!vesselId && perms?.create && (
          <button type="button" onClick={() => openNew("")}
            className="waisha-btn flex items-center gap-8 rounded-input px-16 py-8 text-xs font-semibold">
            <Plus size={15} aria-hidden />Raise a work order
          </button>
        )}
        {vesselId && perms?.create && (
          <button type="button" onClick={() => openNew(vesselId)}
            className="waisha-btn flex items-center gap-8 rounded-input px-16 py-8 text-xs font-semibold">
            <Plus size={15} aria-hidden />Raise a card for this plate
          </button>
        )}
        {rows && rows.length > 0 && (
          <ExportButtons report="work-orders"
            title={vesselId ? `Workshop cards — ${plateLabel ?? "one plate"}` : "Work order register"}
            subtitle={`Cards matching the desk: ${filterWords}`}
            meta={[
              { label: "Filter", value: filterWords || "All" },
              { label: "Window", value: `${days} days` }
            ]}
            columns={[
              { key: "ref", label: "Work order", type: "text", width: 130 },
              { key: "raised", label: "Raised", type: "date" },
              { key: "vehicle", label: "Vehicle", type: "text" },
              { key: "plate", label: "Plate", type: "text" },
              { key: "kind", label: "Kind", type: "text" },
              { key: "where", label: "Where", type: "text" },
              { key: "mechanic", label: "Mechanic", type: "text" },
              { key: "status", label: "State", type: "text" },
              { key: "in_km", label: "In (km)", type: "number" },
              { key: "out_km", label: "Out (km)", type: "number" },
              { key: "parts", label: "Parts", type: "money" },
              { key: "labour", label: "Labour", type: "money" },
              { key: "other", label: "Other", type: "money" },
              { key: "total", label: "Total", type: "money" },
              { key: "currency", label: "Curr.", type: "text" },
              { key: "invoice", label: "Garage invoice", type: "text" },
              { key: "raised_by", label: "Raised by", type: "text" },
              { key: "closed_by", label: "Closed by", type: "text" }
            ]}
            rows={exportRows} />
        )}
      </div>
    </div>
  );

  if (perms && !perms.view) {
    return (
      <section className="rounded-card border bg-surface p-20" style={{ borderColor: "var(--line)" }}>
        <p className="pv-title mb-6"><Wrench aria-hidden />Workshop</p>
        <p className="pane-note text-sm">
          This seat holds no workshop duty, so the work order register is not part of the surface
          it can open. A fleet manager, a workshop manager or a director holds it.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-20">
      <section className="rounded-card border bg-surface p-20" style={{ borderColor: "var(--line)" }}>
        {header}

        {!vesselId && (
          <div className="mt-16 flex flex-wrap items-end gap-10">
            <div role="group" aria-label="State filter" className="flex flex-wrap">
              {["open", "all", ...Object.keys(STATUSES)].map((k) => (
                <button key={k} type="button" onClick={() => setStatus(k)}
                  className="chip"
                  style={{
                    borderColor: status === k ? "var(--gold)" : "var(--line)",
                    background: status === k ? "color-mix(in srgb, var(--gold) 18%, transparent)" : undefined,
                    fontWeight: status === k ? 800 : 600
                  }}>
                  {k === "open" ? "Open cards" : k === "all" ? "Every card" : STATUSES[k]}
                </button>
              ))}
            </div>
            <label className="block min-w-[150px]">
              <span className={labelCls} style={tiny}>Where</span>
              <select value={place} onChange={e => setPlace(e.target.value)}
                className={inputCls} style={inputStyle}>
                <option value="">Garage and in house</option>
                {Object.entries(PLACES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="block min-w-[160px]">
              <span className={labelCls} style={tiny}>Vehicle</span>
              <select value={vesselFilter} onChange={e => setVesselFilter(e.target.value)}
                className={inputCls} style={inputStyle}>
                <option value="">Every plate</option>
                {options.map(o => <option key={o.id} value={o.id}>{o.plate_number} — {o.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={tiny}>From</span>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={tiny}>To</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block min-w-[190px] grow">
              <span className={labelCls} style={tiny}>Search reference, job or garage</span>
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="e.g. WO-2027-00012 or Kigamboni" className={inputCls} style={inputStyle} />
            </label>
            {(status !== "open" || place || vesselFilter || from || to || search) && (
              <button type="button" onClick={() => {
                setStatus("open"); setPlace(""); setVesselFilter(""); setFrom(""); setTo(""); setSearch("");
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

        <div ref={panelRef} className="mt-16">
          {panel?.act === "new" && (
            <Card title="Raise a work order" onClose={closePanel}>
              {vesselId && (
                <p className="pane-note mb-14 text-xs">
                  Against <strong>{plateLabel ?? "this plate"}</strong>.
                </p>
              )}
              <DraftFields draft={draft} setDraft={setDraft} options={options} mechanics={mechanics}
                hideVessel={!!vesselId} />
              <div className="mt-14 flex flex-wrap items-center gap-12">
                <button type="button" disabled={busy} onClick={submitDraft}
                  className="waisha-btn rounded-input px-18 py-9 text-sm font-semibold disabled:opacity-60">
                  {busy ? "Filing…" : "Raise the card"}
                </button>
                <p className="pane-note max-w-[420px] grow text-xs">
                  The card is numbered by the register itself, and the plate is only moved when the
                  workshop opens it — raising a card does not park a truck by itself.
                </p>
              </div>
            </Card>
          )}

          {panel?.act === "edit" && panel.order && (
            <Card title={`Correct ${panel.order.ref}`} onClose={closePanel}>
              <p className="pane-note mb-14 text-xs">
                {panel.order.plate_number} — {panel.order.vessel_name}, raised by{" "}
                {panel.order.created_by_name ?? "a seat no longer on the register"} on{" "}
                {stamp(panel.order.created_at)}. A closed card cannot be rewritten — this one is
                still {STATUSES[panel.order.status] ?? panel.order.status} — and a job does not move
                between plates: raise a new card for that.
              </p>
              <DraftFields draft={draft} setDraft={setDraft} options={options} mechanics={mechanics}
                hideVessel />
              <div className="mt-14 flex flex-wrap items-center gap-12">
                <button type="button" disabled={busy} onClick={submitDraft}
                  className="waisha-btn rounded-input px-18 py-9 text-sm font-semibold disabled:opacity-60">
                  {busy ? "Saving…" : "Save the correction"}
                </button>
                <button type="button" onClick={closePanel}
                  className="underline text-xs" style={tiny}>Leave it</button>
              </div>
            </Card>
          )}

          {panel?.act === "move" && panel.order && (
            <Card title={`Move ${panel.order.ref}`} onClose={closePanel}>
              <div className="grid gap-10 sm:grid-cols-2">
                <label className="block">
                  <span className={labelCls} style={tiny}>Where is it now</span>
                  <select value={move.status} onChange={e => setMove(x => ({ ...x, status: e.target.value }))}
                    className={inputCls} style={inputStyle}>
                    <option value="in_workshop">On the floor / at the garage</option>
                    <option value="awaiting_parts">Standing still for parts</option>
                  </select>
                </label>
                <label className="block">
                  <span className={labelCls} style={tiny}>A word for the plate's journal</span>
                  <input value={move.note} onChange={e => setMove(x => ({ ...x, note: e.target.value }))}
                    maxLength={300} placeholder="e.g. dropped at Kigamboni panel beats, waiting on a rim"
                    className={inputCls} style={inputStyle} />
                </label>
                <button type="button" disabled={busy} onClick={submitMove}
                  className="waisha-btn rounded-input px-18 py-9 text-sm font-semibold disabled:opacity-60 sm:col-span-2">
                  {busy ? "Moving…" : "Move the card"}
                </button>
              </div>
              <p className="pane-note mt-12 text-xs">
                Moving a card onto the floor parks the plate as In garage and says why. If a driver
                still holds an open handover for it, the register refuses the move — end the
                handover first, or the two registers disagree about where the truck is.
                {move.note.trim() ? " Your word is written into the plate's logbook." : ""}
              </p>
            </Card>
          )}

          {panel?.act === "return" && panel.order && (
            <Card title={`Sign ${panel.order.ref} back onto the road`} onClose={closePanel}>
              <div className="grid gap-10 sm:grid-cols-3">
                <label className="block">
                  <span className={labelCls} style={tiny}>Odometer on return *</span>
                  <input type="number" min={0} step={1} value={ret.odometerOutKm}
                    onChange={e => setRet(x => ({ ...x, odometerOutKm: e.target.value }))}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={tiny}>Parts</span>
                  <input type="number" min={0} step="0.01" value={ret.partsCost}
                    onChange={e => setRet(x => ({ ...x, partsCost: e.target.value }))}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={tiny}>Labour</span>
                  <input type="number" min={0} step="0.01" value={ret.labourCost}
                    onChange={e => setRet(x => ({ ...x, labourCost: e.target.value }))}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={tiny}>Other (towing, taxi)</span>
                  <input type="number" min={0} step="0.01" value={ret.otherCost}
                    onChange={e => setRet(x => ({ ...x, otherCost: e.target.value }))}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={tiny}>Currency</span>
                  <select value={ret.currency} onChange={e => setRet(x => ({ ...x, currency: e.target.value }))}
                    className={inputCls} style={inputStyle}>
                    {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className={labelCls} style={tiny}>Garage invoice number</span>
                  <input value={ret.invoiceRef} maxLength={80}
                    onChange={e => setRet(x => ({ ...x, invoiceRef: e.target.value }))}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block sm:col-span-3">
                  <span className={labelCls} style={tiny}>What was found / done</span>
                  <textarea rows={2} value={ret.note} maxLength={500}
                    onChange={e => setRet(x => ({ ...x, note: e.target.value }))}
                    className={inputCls} style={inputStyle} />
                </label>
                <div className="sm:col-span-3">
                  <label className="flex flex-wrap items-center gap-10 text-sm" style={{ color: "var(--ink)" }}>
                    <input type="checkbox" checked={ret.roadworthy}
                      onChange={e => setRet(x => ({ ...x, roadworthy: e.target.checked }))} />
                    The vehicle is roadworthy
                  </label>
                  <p className="pane-note mt-6 text-xs">
                    Unchecked, the plate goes back on the register as Out of service with this card
                    and your note against it. Checked, it returns to Standby. Either way the card is
                    closed — a workshop does not hold a truck on an open card forever.
                  </p>
                </div>
                <button type="button" disabled={busy} onClick={submitReturn}
                  className="waisha-btn rounded-input px-18 py-9 text-sm font-semibold disabled:opacity-60 sm:col-span-3">
                  {busy ? "Closing…" : ret.roadworthy ? "Close the card, back on the road" : "Close the card as unroadworthy"}
                </button>
              </div>
              <p className="pane-note mt-12 text-xs">
                Costs left blank keep what the card already holds. A reading above the one on the
                plate moves the plate's odometer; a lower one is refused. Money stays on this card —
                the plate's journal says the visit happened and points here for the figures.
              </p>
            </Card>
          )}

          {panel?.act === "cancel" && panel.order && (
            <Card title={`Call ${panel.order.ref} off`} onClose={closePanel}>
              <label className="block">
                <span className={labelCls} style={tiny}>Why the job is off *</span>
                <input value={reason} maxLength={300} autoFocus
                  onChange={e => setReason(e.target.value)}
                  placeholder="e.g. raised twice for the same visit; the other card was used"
                  className={inputCls} style={inputStyle} />
              </label>
              <div className="mt-12 flex flex-wrap items-center gap-12">
                <button type="button" disabled={busy} onClick={submitCancel}
                  className="rounded-input border px-18 py-9 text-sm font-semibold disabled:opacity-60"
                  style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
                  {busy ? "Calling off…" : "Call the card off"}
                </button>
                <button type="button" onClick={closePanel}
                  className="underline text-xs" style={tiny}>Keep it open</button>
              </div>
              <p className="pane-note mt-10 text-xs">
                Cancelling zeros the card's parts, labour and other figures so a job that never ran
                cannot be billed, keeps your words on the card, and writes a line in the plate's
                journal. If this card was the reason the plate is standing still, the plate goes
                back to Standby.
              </p>
            </Card>
          )}

          {panel?.act === "files" && panel.order && (
            <Card title={`Papers on ${panel.order.ref}`} onClose={closePanel}>
              {perms?.upload && (
                <div className="grid gap-10 sm:grid-cols-3">
                  <label className="block">
                    <span className={labelCls} style={tiny}>What the paper is</span>
                    <select value={billKind} onChange={e => setBillKind(e.target.value)}
                      className={inputCls} style={inputStyle}>
                      {Object.entries(BILL_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </label>
                  <div className="sm:col-span-2">
                    <span className={labelCls} style={tiny}>Photograph or PDF (8 MB max)</span>
                    <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf"
                      onChange={attachBill} className="hidden" aria-hidden />
                    <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
                      className="on-photo-btn flex items-center gap-8 rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">
                      <Paperclip size={14} aria-hidden />{busy ? "Filing…" : "Attach the bill"}
                    </button>
                  </div>
                </div>
              )}
              <div className="mt-14">
                {docs === null && <p className="pane-note text-sm">Reading the file list…</p>}
                {docs?.length === 0 && (
                  <p className="pane-note text-sm">No paper is filed against this card yet.</p>
                )}
                {docs?.map(d => (
                  <div key={d.id} className="flex flex-wrap items-baseline gap-8 border-b py-8 text-xs last:border-0"
                    style={{ borderColor: "var(--line)" }}>
                    <span className="min-w-0 break-words font-semibold" style={{ color: "var(--ink)" }}>{d.file_name}</span>
                    <span style={tiny}>{BILL_KINDS[d.kind] ?? d.kind}</span>
                    <span style={tiny}>{d.size_bytes < 1024 ? `${d.size_bytes} B`
                      : `${Math.round(d.size_bytes / 1024)} kB`} · {stamp(d.created_at)}</span>
                    <button type="button" className="underline" style={{ color: "var(--brand)" }}
                      onClick={() => openDoc(d.id)}>Open</button>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        {rows === null ? (
          <p className="pane-note mt-16 p-12 text-sm">Opening every card on the register…</p>
        ) : rows.length === 0 ? (
          <p className="pane-note mt-16 p-12 text-sm">
            {status === "open"
              ? "Nothing is standing in a workshop right now. Raise a card and the plate appears here."
              : "No card matches these filters. Widen the state or clear the search."}
          </p>
        ) : (
          <div className="mt-16 overflow-x-auto rounded-card border" style={{ borderColor: "var(--line)" }}>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", ...tiny }}>
                  <th className="p-10">Card</th>
                  {!vesselId && <th className="p-10">Plate</th>}
                  <th className="p-10">Job</th>
                  <th className="p-10">Where / who</th>
                  <th className="p-10">State</th>
                  <th className="p-10">Odometer</th>
                  <th className="p-10 text-right">Cost</th>
                  <th className="p-10 text-right">Acts</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const blocked = o.close_block === "no_key"
                    ? "a seat that closes work orders signs it back on"
                    : o.cancel_block === "moved"
                      ? "work has started, so only a closing seat can call it off"
                      : o.cancel_block === "no_key"
                        ? "only the seat that raised it, or one that closes cards, can call it off"
                        : null;
                  return (
                    <tr key={o.id} className="border-b align-top last:border-0" style={{ borderColor: "var(--line)" }}>
                      <td className="p-10">
                        <span className="block font-bold tabular-nums" style={{ color: "var(--ink)" }}>{o.ref}</span>
                        <span className="block" style={tiny}>{o.raised_on}</span>
                        {o.attachments > 0 && (
                          <span className="mt-4 flex items-center gap-4 text-[10px]" style={tiny}>
                            <Paperclip size={11} aria-hidden />{o.attachments} paper{o.attachments === 1 ? "" : "s"}
                          </span>
                        )}
                      </td>
                      {!vesselId && (
                        <td className="p-10">
                          <span className="block break-words font-semibold" style={{ color: "var(--ink)" }}>{o.vessel_name}</span>
                          <span className="block tabular-nums" style={tiny}>{o.plate_number}</span>
                        </td>
                      )}
                      <td className="p-10">
                        <span className="block break-words font-semibold" style={{ color: "var(--ink)" }}>{o.title}</span>
                        <span className="block">{KINDS[o.kind] ?? o.kind}</span>
                        {o.invoice_ref && <span className="block" style={tiny}>invoice {o.invoice_ref}</span>}
                      </td>
                      <td className="p-10">
                        <span className="block break-words">{PLACES[o.place] ?? o.place}</span>
                        <span className="block break-words" style={tiny}>
                          {o.place === "outside_garage" ? (o.garage_name ?? "—") : (o.mechanic_name ?? "—")}
                        </span>
                        {o.mechanic_removed && (
                          <span className="mt-4 block text-[10px] font-bold uppercase" style={{ color: "var(--warning)" }}>
                            staff record retired
                          </span>
                        )}
                      </td>
                      <td className="p-10">
                        <span className="block px-8 py-4 text-[10px] font-bold uppercase"
                          style={{
                            borderLeft: `4px solid ${STATUS_COLORS[o.status] ?? "var(--ink-soft)"}`,
                            color: "var(--ink)"
                          }}>
                          {STATUSES[o.status] ?? o.status}
                        </span>
                        {o.status === "cancelled" && o.cancel_reason && (
                          <span className="mt-4 block break-words text-[10px]" style={tiny}>{o.cancel_reason}</span>
                        )}
                        {o.returned_by_name && (
                          <span className="mt-4 block text-[10px]" style={tiny}>by {o.returned_by_name}</span>
                        )}
                      </td>
                      <td className="p-10 tabular-nums" style={tiny}>
                        <span className="flex items-center gap-4">
                          <Gauge size={12} aria-hidden />{o.odometer_in_km == null ? "—" : Number(o.odometer_in_km).toLocaleString()}
                        </span>
                        <span className="block">
                          {o.odometer_out_km != null ? `→ ${Number(o.odometer_out_km).toLocaleString()} km` : "not back yet"}
                        </span>
                        {o.odometer_in_km != null && o.odometer_out_km != null && (
                          <span className="block">
                            {(Number(o.odometer_out_km) - Number(o.odometer_in_km)).toLocaleString()} km covered
                          </span>
                        )}
                      </td>
                      <td className="p-10 text-right tabular-nums">
                        <span className="block font-bold" style={{ color: "var(--ink)" }}>
                          {money(o.total_cost)} {o.currency}
                        </span>
                        <span className="block text-[10px]" style={tiny}>
                          {money(o.parts_cost)} / {money(o.labour_cost)} / {money(o.other_cost)}
                        </span>
                      </td>
                      <td className="p-10 text-right whitespace-nowrap">
                        <div className="flex flex-wrap justify-end gap-6">
                          {o.can_move && (
                            <ActButton label="Move" onClick={() => openPanel("move", o)} />
                          )}
                          {o.can_return && (
                            <ActButton label="Sign off" primary onClick={() => openPanel("return", o)} />
                          )}
                          {o.can_edit && (
                            <ActButton label="Correct" onClick={() => openPanel("edit", o)} />
                          )}
                          {o.can_cancel && (
                            <ActButton label="Call off" danger onClick={() => openPanel("cancel", o)} />
                          )}
                          <ActButton label="Papers" onClick={() => openPanel("files", o)} />
                        </div>
                        {blocked && OPEN.includes(o.status) && (
                          <span className="mt-6 block max-w-[220px] break-words text-right text-[10px] font-normal"
                            style={tiny}>{blocked}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {summary && !vesselId && (
        <section className="rounded-card border bg-surface p-20" style={{ borderColor: "var(--line)" }}>
          <div className="flex flex-wrap items-center justify-between gap-12">
            <p className="pv-title mb-0"><CircleDollarSign aria-hidden />What the workshop costs</p>
            <label className="flex items-center gap-8 text-xs" style={tiny}>
              <span className={labelCls} style={tiny}>Window</span>
              <select value={days} onChange={e => setDays(Number(e.target.value))}
                className="rounded-input border px-10 py-6 text-xs" style={inputStyle}>
                <option value={90}>90 days</option>
                <option value={180}>180 days</option>
                <option value={365}>1 year</option>
                <option value={730}>2 years</option>
              </select>
            </label>
          </div>
          <p className="mt-8 text-xs" style={tiny}>
            Every figure here counts the cards raised in the last {summary.window_days} days,
            whether or not the register above is filtered.
          </p>

          <div className="mt-16 grid grid-cols-2 gap-10 sm:grid-cols-4">
            <Tile label="Cards raised in this window" value={String(summary.totals.orders)}
              note={summary.totals.cancelled
                ? `${summary.totals.open} still open · ${summary.totals.cancelled} called off`
                : `${summary.totals.open} still open`} />
            <Tile label="Currencies on file"
              value={summary.totals.currencies?.length ? summary.totals.currencies.join(" · ") : "—"}
              note="each card names its own" />
          </div>

          {summary.byCurrency.length > 0 && (
            <div className="mt-16 overflow-x-auto rounded-card border" style={{ borderColor: "var(--line)" }}>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-right" style={{ borderColor: "var(--line)", ...tiny }}>
                    <th className="p-10 text-left">Currency</th>
                    <th className="p-10">Cards</th><th className="p-10">Parts</th>
                    <th className="p-10">Labour</th><th className="p-10">Other</th>
                    <th className="p-10">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byCurrency.map((t) => (
                    <tr key={t.currency} className="border-b text-right tabular-nums last:border-0"
                      style={{ borderColor: "var(--line)" }}>
                      <td className="p-10 text-left font-bold" style={{ color: "var(--ink)" }}>{t.currency}</td>
                      <td className="p-10" style={tiny}>{t.orders}</td>
                      <td className="p-10">{money(t.parts)}</td>
                      <td className="p-10">{money(t.labour)}</td>
                      <td className="p-10">{money(t.other)}</td>
                      <td className="p-10 font-bold" style={{ color: "var(--ink)" }}>{money(t.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(summary.totals.currencies?.length ?? 0) > 1 && (
            <p className="pane-note mt-10 text-xs" style={{ color: "var(--warning)" }}>
              Cards here are filed in {summary.totals.currencies!.join(" and ")}. The list below adds
              those currencies together, so read a figure there as activity rather than a bill — the
              table above is the only place the money is exact.
            </p>
          )}

          <div className="mt-20 grid gap-20 lg:grid-cols-2">
            <div>
              <p className="pv-title"><AlertTriangle aria-hidden />By vehicle</p>
              {summary.perVessel.length === 0 && <p className="pane-note text-sm">No card has been raised on any plate.</p>}
              {summary.perVessel.slice(0, 10).map((v) => (
                <div key={v.vessel_id} className="flex flex-wrap items-baseline gap-8 border-b py-8 text-xs last:border-0"
                  style={{ borderColor: "var(--line)" }}>
                  <span className="min-w-0 break-words font-semibold" style={{ color: "var(--ink)" }}>
                    {v.plate_number} · {v.name}
                  </span>
                  <span style={tiny}>{v.open_orders} open · {v.returned_orders} closed</span>
                  <span className="ml-auto tabular-nums font-bold" style={{ color: "var(--ink)" }}>
                    {money(v.spent)}
                  </span>
                  {v.last_raised && (
                    <span className="basis-full text-[10px]" style={tiny}>
                      open card dated {v.last_raised}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div>
              <p className="pv-title"><Wrench aria-hidden />By kind of job</p>
              {summary.perKind.length === 0 && <p className="pane-note text-sm">Nothing to total yet.</p>}
              {summary.perKind.map((k) => (
                <div key={k.kind} className="flex flex-wrap items-baseline gap-8 border-b py-8 text-xs last:border-0"
                  style={{ borderColor: "var(--line)" }}>
                  <span className="font-semibold" style={{ color: "var(--ink)" }}>{KINDS[k.kind] ?? k.kind}</span>
                  <span style={tiny}>{k.orders} card{k.orders === 1 ? "" : "s"}</span>
                  <span className="ml-auto tabular-nums font-bold" style={{ color: "var(--ink)" }}>{money(k.cost)}</span>
                </div>
              ))}
              <p className="pane-note mt-10 text-xs">
                A called-off card counts as a card but carries no bill — the register will not let
                a job that never ran keep a cost. The spend beside a vehicle counts only cards that
                came back.
              </p>
            </div>
            <div className="lg:col-span-2">
              <p className="pv-title"><CalendarClock aria-hidden />By garage</p>
              {summary.perGarage.length === 0 && (
                <p className="pane-note text-sm">No closed visit has named a garage or an in-house shop.</p>
              )}
              <div className="grid gap-8 sm:grid-cols-2">
                {summary.perGarage.map((g) => (
                  <div key={g.garage} className="rounded-card border p-12" style={{ borderColor: "var(--line)" }}>
                    <p className="break-words text-sm font-bold" style={{ color: "var(--ink)" }}>{g.garage}</p>
                    <p className="mt-4 text-xs tabular-nums" style={tiny}>
                      {g.orders} closed card{g.orders === 1 ? "" : "s"} · {money(g.cost)}
                      {g.last_job ? ` · last on ${g.last_job}` : ""}
                    </p>
                  </div>
                ))}
              </div>
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
    <div className="rounded-card border bg-surface p-18" style={{ borderColor: "var(--gold)" }}>
      <div className="flex flex-wrap items-start justify-between gap-10">
        <p className="pv-title mb-0">{title}</p>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close this panel"
            className="flex items-center gap-6 text-xs" style={tiny}>
            <X size={14} aria-hidden />Close
          </button>
        )}
      </div>
      <div className="mt-14">{children}</div>
    </div>
  );
}

function ActButton({ label, onClick, primary, danger }: {
  label: string; onClick: () => void; primary?: boolean; danger?: boolean;
}) {
  return (
    <button type="button" onClick={onClick}
      className={primary ? "waisha-btn rounded-input px-10 py-6 text-[11px] font-semibold"
        : "rounded-input border px-10 py-6 text-[11px] font-semibold"}
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
    <div className="rounded-card border p-14" style={{ borderColor: "var(--line)" }}>
      <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={tiny}>{label}</p>
      <p className="mt-6 break-words text-lg font-extrabold tabular-nums" style={{ color: "var(--ink)" }}>{value}</p>
      {note && <p className="mt-4 text-[11px]" style={tiny}>{note}</p>}
    </div>
  );
}

function DraftFields({ draft, setDraft, options, mechanics, hideVessel }: {
  draft: ReturnType<typeof blankDraft>;
  setDraft: (fn: (x: ReturnType<typeof blankDraft>) => ReturnType<typeof blankDraft>) => void;
  options: Option[]; mechanics: Mechanic[];
  /** On the plate's own file and on a correction the vehicle is already decided — both cards
   *  name it in their caption, so the picker would only offer a choice the route refuses anyway. */
  hideVessel?: boolean;
}) {
  const set = (k: keyof ReturnType<typeof blankDraft>, v: unknown) => setDraft(x => ({ ...x, [k]: v }));
  const chosen = options.find(o => o.id === draft.vesselId);
  return (
    <div className="grid gap-10 sm:grid-cols-3">
      {!hideVessel && (
        <label className="block">
          <span className={labelCls} style={tiny}>Vehicle *</span>
          <select value={draft.vesselId}
            onChange={e => {
              const v = options.find(o => o.id === e.target.value);
              setDraft(x => ({ ...x, vesselId: e.target.value, odometerInKm: v ? String(v.odometer_km) : x.odometerInKm }));
            }}
            className={inputCls} style={inputStyle}>
            <option value="">Select a plate</option>
            {options.map(o => (
              <option key={o.id} value={o.id}>
                {o.plate_number} — {o.name}
                {o.status === "in_garage" ? " (already in garage)" : ""}
              </option>
            ))}
          </select>
          {chosen && (
            <span className="mt-4 block text-[10px]" style={tiny}>
              On the register at {chosen.odometer_km.toLocaleString()} km
            </span>
          )}
        </label>
      )}
      <label className="block">
        <span className={labelCls} style={tiny}>Day the job was asked for *</span>
        <input type="date" max={todayPlain()} value={draft.raisedOn}
          onChange={e => set("raisedOn", e.target.value)} className={inputCls} style={inputStyle} />
      </label>
      <label className="block">
        <span className={labelCls} style={tiny}>Kind of job</span>
        <select value={draft.kind} onChange={e => set("kind", e.target.value)}
          className={inputCls} style={inputStyle}>
          {Object.entries(KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <label className="block sm:col-span-2">
        <span className={labelCls} style={tiny}>What is wrong / what was asked *</span>
        <input value={draft.title} maxLength={140}
          onChange={e => set("title", e.target.value)}
          placeholder="e.g. Front brake shoes worn, replace both sides" className={inputCls} style={inputStyle} />
      </label>
      <label className="block">
        <span className={labelCls} style={tiny}>Odometer when it rolled in</span>
        <input type="number" min={0} step={1} value={draft.odometerInKm}
          onChange={e => set("odometerInKm", e.target.value)}
          placeholder={chosen ? String(chosen.odometer_km) : "blank = no reading claimed"}
          className={inputCls} style={inputStyle} />
      </label>
      <div className="sm:col-span-3">
        <span className={labelCls} style={tiny}>Who does the work</span>
        <div className="flex flex-wrap gap-8" role="group" aria-label="Where the work is done">
          {Object.entries(PLACES).map(([k, l]) => (
            <button key={k} type="button" onClick={() => set("place", k)}
              className="chip"
              style={{
                borderColor: draft.place === k ? "var(--brand)" : "var(--line)",
                background: draft.place === k ? "color-mix(in srgb, var(--brand) 14%, transparent)" : undefined,
                fontWeight: draft.place === k ? 800 : 600
              }}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {draft.place === "outside_garage" && (
        <>
          <label className="block">
            <span className={labelCls} style={tiny}>Garage name *</span>
            <input value={draft.garageName} maxLength={140}
              onChange={e => set("garageName", e.target.value)}
              placeholder="e.g. Kigamboni Auto Works" className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={tiny}>Their own job number</span>
            <input value={draft.garageReference} maxLength={80}
              onChange={e => set("garageReference", e.target.value)}
              placeholder="e.g. GW-118" className={inputCls} style={inputStyle} />
          </label>
        </>
      )}
      {draft.place === "in_house" && (
        <label className="block sm:col-span-2">
          <span className={labelCls} style={tiny}>Mechanic (this company's staff) *</span>
          <select value={draft.mechanicEmployeeId} onChange={e => set("mechanicEmployeeId", e.target.value)}
            className={inputCls} style={inputStyle}>
            <option value="">Select the person who will do it</option>
            {mechanics.map(m => (
              <option key={m.id} value={m.id} disabled={m.status === "resigned"}>
                {m.full_name}{m.job_title ? ` — ${m.job_title}` : ""}
                {m.open_cards ? ` (${m.open_cards} open)` : ""}
                {m.status === "resigned" ? " (resigned)" : ""}
              </option>
            ))}
          </select>
          {mechanics.length === 0 && (
            <span className="mt-4 block text-[10px]" style={tiny}>
              This desk can read the workshop register but finds no staff record to name — the
              mechanic is chosen on the office staff desk.
            </span>
          )}
        </label>
      )}
      {/* An in-house job can still carry the name of the yard its welder stood in. */}
      {draft.place === "in_house" && (
        <label className="block">
          <span className={labelCls} style={tiny}>Yard / workshop name (optional)</span>
          <input value={draft.garageName} maxLength={140}
            onChange={e => set("garageName", e.target.value)}
            placeholder="e.g. Busoro depot bay 2" className={inputCls} style={inputStyle} />
        </label>
      )}
      <label className="block sm:col-span-3">
        <span className={labelCls} style={tiny}>Detail — what was found, what was quoted</span>
        <textarea rows={2} maxLength={2000} value={draft.detail}
          onChange={e => set("detail", e.target.value)} className={inputCls} style={inputStyle} />
      </label>
      <label className="block">
        <span className={labelCls} style={tiny}>Parts so far</span>
        <input type="number" min={0} step="0.01" value={draft.partsCost}
          onChange={e => set("partsCost", e.target.value)} className={inputCls} style={inputStyle} />
      </label>
      <label className="block">
        <span className={labelCls} style={tiny}>Labour so far</span>
        <input type="number" min={0} step="0.01" value={draft.labourCost}
          onChange={e => set("labourCost", e.target.value)} className={inputCls} style={inputStyle} />
      </label>
      <label className="block">
        <span className={labelCls} style={tiny}>Other (towing, taxi, cleaning)</span>
        <input type="number" min={0} step="0.01" value={draft.otherCost}
          onChange={e => set("otherCost", e.target.value)} className={inputCls} style={inputStyle} />
      </label>
      <label className="block">
        <span className={labelCls} style={tiny}>Currency</span>
        <select value={draft.currency} onChange={e => set("currency", e.target.value)}
          className={inputCls} style={inputStyle}>
          {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className="block sm:col-span-2">
        <span className={labelCls} style={tiny}>Garage invoice number</span>
        <input value={draft.invoiceRef} maxLength={80}
          onChange={e => set("invoiceRef", e.target.value)} className={inputCls} style={inputStyle} />
      </label>
    </div>
  );
}
