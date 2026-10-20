-- 097 — reading a cargo file out of the PDF it arrived in (task #226).
--
-- The clearing desk does not receive data, it receives papers. A liner's advisory, a
-- TIRA declaration, a shipping line's bill of lading — all of them arrive as PDFs, and
-- somebody then types the consignee, the B/L number, the TANSAD, the ETA and the
-- container stack into the form all over again. That re-typing is where a transposed
-- digit is born, and it is the part of the job a machine can already do: a digital PDF
-- carries a text layer, and the text layer carries the printed labels.
--
--   `cargo_intake_drafts`  one row per uploaded PDF, numbered inside its batch, holding
--                         what the reader found and the raw lines it found them on.
--
-- What this is NOT: a scanner. There is no OCR here and nothing is sent to a vision
-- service. A PDF with a text layer gets read; a photograph of a page has no text layer,
-- so it is filed as `manual` — "this one has to be typed" — and the clerk sees the
-- original beside the empty form instead of a page full of guesses. The distinction is
-- the whole reason the register keeps `extract_status` per row: an operator who cannot
-- tell a bad read from an unread page stops trusting the feature within a week.
--
-- The draft is deliberately *not* a cargo file. It holds candidates, not facts:
-- `cargo_shipments` stays the only place a file lives, `POST /cargo` stays the only
-- path that writes one, and the file number still comes from `nextFileNumber()` so a
-- scanned row cannot jump the sequence or take a number another clerk is holding. The
-- clerk reviews the candidates in the same form they already use, edits what the reader
-- got wrong, and saves. Only then does `committed_shipment_id` get stamped — and with it
-- the source PDF is re-pointed from the draft onto the file, so the original the number
-- was read from stays in the vault attached to the file it became.
--
-- Nothing money-related is ever proposed. `processing_cost`, `payment_amount` and
-- `payment_status` are this office's own decisions, not facts printed on somebody
-- else's document, so the reader leaves them empty and says so. The one exception is
-- `payment_amount` when the document *is* the office's own invoice for the job — see the
-- amount rules in the reader — and even then it arrives as a candidate to be confirmed.
--
-- `position` is the number the clerk gives the page ("this is file 3 of the six I got
-- from MSC this morning"). It is unique inside a batch and inside the tenant, which is
-- what makes a re-upload of number 3 an overwrite attempt rather than a silent second
-- row, and it is what the review list is ordered by — the stack in the order it was
-- numbered, not the order the bytes happened to land.
--
-- Append-only like 094's register: select, insert and update, no DELETE grant from any
-- role the application runs as. A draft that was wrong is corrected or soft-deleted;
-- drafts that were committed are kept forever, because "where did this number come from"
-- is a question the file will be asked again in two years.

begin;

-- ============================================================
-- 1. the intake register
-- ============================================================

create table if not exists cargo_intake_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- One upload session. A clerk who drags six PDFs in at once gets six rows in one
  -- batch; the batch is what the review list shows as a group.
  batch_id uuid not null,
  position int not null check (position between 1 and 60),
  label text check (label is null or char_length(label) <= 60),
  -- The page itself, in the tenant's own vault. Kind is whatever the clerk called it
  -- (a declaration, a B/L, an advisory), so the file keeps the label the paper carries.
  document_id uuid not null references documents(id),
  shipment_type text not null default 'import'
    check (shipment_type in ('export','import','transhipment','transit')),
  -- The number printed on the document (declaration no, B/L no, invoice no) — kept in
  -- its own column because searching for "which PDF was this" is the first thing the
  -- desk does, and it must not depend on a JSON path into `extraction`.
  printed_reference text,
  extract_status text not null default 'pending'
    check (extract_status in ('pending','extracted','manual','failed')),
  -- Candidates plus evidence: { fields: { <name>: { value, raw, line } },
  -- unparsed: [...], notes }. Never the file's own words rewritten into something the
  -- reader "meant".
  extraction jsonb,
  extract_notes text,
  -- Stamped only when the clerk saved the reviewed draft as a real cargo file. Both
  -- halves move together, so one of them being set and the other not is a register that
  -- lies about what it committed.
  committed_shipment_id uuid references cargo_shipments(id),
  committed_at timestamptz,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check ((committed_shipment_id is null) = (committed_at is null)),
  check (extraction is null or jsonb_typeof(extraction) = 'object'),
  -- A page that was not read cannot have been committed: the save path may attach a
  -- file to a `manual` row (the clerk typed it) but never to a row whose read failed
  -- while it was pending, because that row is an upload that never finished.
  check (extract_status <> 'pending' or committed_shipment_id is null)
);

-- The number the clerk gave the page is the identity of the slot: re-uploading into a
-- taken number is refused rather than quietly making a second row for the same paper.
create unique index cargo_intake_drafts_slot_uq
  on cargo_intake_drafts (tenant_id, batch_id, position)
  where deleted_at is null;
create index idx_cargo_intake_drafts_batch
  on cargo_intake_drafts (tenant_id, batch_id, position);
create index idx_cargo_intake_drafts_recent
  on cargo_intake_drafts (tenant_id, created_at desc);
-- The badge on the cargo desk counts these: pages the reader could not finish, in the
-- batches that have not been turned into files yet.
create index idx_cargo_intake_drafts_typing
  on cargo_intake_drafts (tenant_id)
  where deleted_at is null and committed_shipment_id is null
    and extract_status in ('manual','failed');

create trigger trg_cargo_intake_drafts_updated before update on cargo_intake_drafts
  for each row execute function public.set_updated_at();

alter table cargo_intake_drafts enable row level security;
create policy cargo_intake_drafts_tenant on cargo_intake_drafts for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on cargo_intake_drafts to app_runtime;

comment on table cargo_intake_drafts is
  'Numbered PDFs the clearing desk uploaded to be read into cargo files, with the candidates the reader found and the lines they came from.';
comment on column cargo_intake_drafts.extraction is
  'Candidate fields with their evidence, the lines that were not parsed, and the reader''s own notes. Candidates only — nothing here is a fact until the clerk saves the file.';
comment on column cargo_intake_drafts.committed_shipment_id is
  'The cargo file the clerk saved from this draft. Set once, by the commit call that also re-points the source document onto that file.';

-- ============================================================
-- 2. the vault learns the draft as an entity
-- ============================================================
--
-- While a page is only a draft its document sits under `cargo_intake`; committing
-- re-points the same row onto the `shipment`, so no copy is ever made and the bytes are
-- stored once under the tenant's own path.

alter table documents drop constraint documents_entity_type_check;
alter table documents add constraint documents_entity_type_check
  check (entity_type in ('tenant','user','vessel','driver','trip','shipment','message',
                         'licence','employee','office_cost','quotation','cargo_intake'));

-- ============================================================
-- 3. the duty
-- ============================================================
--
-- Reading a paper into a draft is its own duty, but it is only half a job: a draft that
-- cannot be saved is a second place to type the same data. It is therefore granted to
-- exactly the seats that already hold `shipments.create`, and to nobody else — a reader
-- with no way to open the file would leave the desk with a pile of drafts it cannot
-- finish. `auditor` deliberately does not get it: the drafts carry other people's
-- customers' names, and the audit seat reads files, not intake work in progress.

insert into permissions (key, description) values
  ('shipments.extract','Cargo PDF Intake - upload a numbered page, read its printed fields and open it as a draft')
on conflict do nothing;

-- Taken from the register rather than a list kept here, so the rule "a reader must be
-- able to open the file" holds on the day somebody edits the matrix. Only platform
-- roles are compared, and only platform roles are written.
insert into role_permissions (role_id, permission_key)
select r.id, 'shipments.extract'
  from roles r
 where r.tenant_id is null
   and r.key <> 'auditor'
   and exists (
     select 1 from roles c
       join role_permissions cp on cp.role_id = c.id
      where c.tenant_id is null and c.key = r.key
        and cp.permission_key = 'shipments.create'
   )
on conflict do nothing;

commit;
