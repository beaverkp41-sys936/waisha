-- 140: the price that carries its own dates
--
-- 069 put an advisory on this panel and keyed it `no_price_history`: "Nothing remembers what a price
-- used to be … If pricing starts moving, write a price-history row in the same transaction as the
-- update." This is that register. It exists because three facts were already true and no fourth was:
--
--   * `routes.rate_per_km / rate_per_tonne / rate_per_trip / fuel_surcharge_pct` (019) are stored and
--     editable and have never computed a figure — 094 said so out loud: "a quote sheet, not a payslip".
--   * `charge_catalog.default_rate` (052) is read by the PDF reconciler to *suggest* a line and is never
--     applied server-side; a quotation's `unit_price` comes straight out of the request body.
--   * the only dated price list in the schema is `duty_rates` (032), and it is `grant select` — TRA tax,
--     rewritten by version migrations, reachable by no desk.
--
-- So the price the office actually charges has no owner, no dates, and no memory. This gives it all
-- three, in the shape the rest of the panel already uses.
--
-- What a version means here. 032's trick is the window: `effective_from`/`effective_to` plus a resolver
-- that answers "what was in force on that day". 140 keeps the window and drops 032's authorship, because
-- the whole point is that a desk — not a migration — changes a price. A change is therefore never an
-- edit: a card is cloned to a new `version`, the new one is signed, and on the day it starts the old one
-- is closed and marked superseded. A price that has been published keeps its figures by trigger, because
-- the alternative is a customer being told a number the register no longer contains.
--
-- Why a publish needs two seats and a withdrawal does not. 121 reserved the action name `pricing.publish`
-- for exactly this stage and `approvals.ts:57` states the consequence — a kind with no apply path is "a
-- signature that can never be spent" — so the paper is raised here, against the card's own bytes, and
-- spent here. A *withdrawal* is deliberately one-seat, for the reason 121 itself gave for unblocking a
-- company: stopping a wrong price is the act that protects the person on the other end of it, and a desk
-- that cannot stop a wrong price until a second person appears keeps the wrong price live for a day. What
-- a one-seat withdrawal may not do is rewrite history: it sets an end date no earlier than today, so it
-- can only stop the price going forward, never un-quote a day that already passed.
--
-- The figures are hashed as the column prints them (`::text`), not through 134's `money_figure`, which
-- rounds to two decimals. A rate column is `numeric(14,4)`: signing '4100.00' where the register holds
-- '4100.0040' would be 138's defect in the other direction — a translation dressed as a fact.
--
-- Deliberately NOT here: surcharges, promo codes, commission per tenant/plan (they are the next card on
-- this module, and they change the arithmetic, not the register), and any posting to 133's book — a price
-- is what the office *charges*, and the money that arrives against it is still booked by 009/134's doors.
begin;

-- ============================================================
-- 1. the words a price is allowed to be keyed on
-- ============================================================

-- A rate line is scoped by route, vehicle class, container kind and basis. Three of those four are
-- vocabularies that already exist somewhere else as a TypeScript constant or a CHECK on another table,
-- and a price list that quietly disagrees with them produces lines no job can ever match. So the words
-- become data with one author, the same way 130 made modes of transport data and 132 made the customs
-- regimes data. `needs` is not the arithmetic — that is written in the resolver below — it is the noun
-- the refusal sentence needs when a job does not carry the quantity a basis multiplies by.
create table if not exists pricing_dimensions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('vehicle_class','container','basis')),
  -- `20ft` and `40ft` start with a digit because 034 spelled them that way, and a container that a cargo
  -- file cannot be filed as is a line that can never fire.
  key text not null check (key ~ '^[a-z0-9][a-z0-9_]{1,39}$'),
  label text not null check (char_length(trim(label)) between 2 and 60),
  needs text not null default 'none'
    check (needs in ('none','distance_km','tonnes','teu','cbm','days','one')),
  sort int not null default 0,
  constraint pricing_dimensions_one_word_per_kind unique (kind, key)
);

alter table pricing_dimensions enable row level security;
create policy pricing_dimensions_readable on pricing_dimensions for select to app_runtime
  using (true);
grant select on pricing_dimensions to app_runtime;
revoke all on pricing_dimensions from public, anon, authenticated, service_role;

-- The ten classes are `VEHICLE_TYPES` in api/src/util/transport.ts — the list the transport board already
-- asks a company to choose from. The four container kinds are 034's `cargo_shipments.container_type`
-- check. Both are named in the comment where they are read so the next stage finds its author.
insert into pricing_dimensions (kind, key, label, needs, sort) values
  ('vehicle_class','truck_head','Truck head','none',1),
  ('vehicle_class','trailer','Trailer','none',2),
  ('vehicle_class','tanker','Tanker','none',3),
  ('vehicle_class','flatbed','Flatbed','none',4),
  ('vehicle_class','tipper','Tipper','none',5),
  ('vehicle_class','reefer','Reefer (cooled)','none',6),
  ('vehicle_class','box_truck','Box truck','none',7),
  ('vehicle_class','van','Van','none',8),
  ('vehicle_class','pickup','Pickup','none',9),
  ('vehicle_class','lowbed','Lowbed','none',10),
  ('container','20ft','20 ft container','teu',1),
  ('container','40ft','40 ft container','teu',2),
  ('container','loose_cargo','Loose cargo','none',3),
  ('container','car','Vehicle / car','none',4),
  ('basis','per_km','Per kilometre','distance_km',1),
  ('basis','per_tonne','Per tonne','tonnes',2),
  ('basis','per_teu','Per container (TEU)','teu',3),
  ('basis','per_cbm','Per cubic metre','cbm',4),
  ('basis','per_day','Per day','days',5),
  ('basis','per_trip','Per trip','one',6),
  ('basis','flat','Flat charge','none',7)
on conflict (kind, key) do nothing;

-- ============================================================
-- 2. the card: whose price list, which version, valid for which days
-- ============================================================

create sequence if not exists pricing_card_number_seq;
-- Deliberately granted to nobody, not even the app role. The number is taken by `open_pricing_card` and
-- `clone_pricing_card` in section 8, and those doors run as their own owner, so no caller ever needs
-- `nextval`. 134 and 135 say the same about the refs they mint: a role that can take a number without
-- writing a row leaves the office a hole in its own numbering to explain. The revoke at the end of
-- section 13 takes back what Supabase grants to every client role by default.

create table if not exists pricing_rate_cards (
  id uuid primary key default gen_random_uuid(),
  -- Whose list it is, named the way 133 names a book: the platform's own cards live on the platform
  -- tenant, and a company's cards live on the company. `routes` is a tenant table (019), so a line that
  -- names a route belongs to the book that route belongs to — the guard in section 5 makes that a fact
  -- rather than a habit, which is 137's lesson applied before the break instead of after it.
  tenant_id uuid not null references tenants(id),
  ref text not null unique check (ref ~ '^PRC-[0-9]{4}-[0-9]{5,}$'),
  -- FREIGHT-STD. A card is a *list*, and the list keeps its name across versions, so "the standard
  -- corridor price" is a thing a desk can say and a resolver can be asked about.
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$'),
  label text not null check (char_length(trim(label)) between 3 and 80),
  -- One money per card, exactly as 135 insisted one money per count. A TZS figure summed under USD is
  -- the defect 138 exists to have prevented, and a card that holds both is the same trap one level up.
  currency text not null default 'TZS' check (currency in ('TZS','USD')),
  status text not null default 'draft'
    check (status in ('draft','pending_signature','published','superseded','withdrawn')),
  version int not null default 1 check (version >= 1),
  -- The window. A published card whose `effective_from` is in the future is a *scheduled* price, and a
  -- superseded one keeps its end date — so no fourth status is needed to answer "what was it on Tuesday".
  effective_from date,
  effective_to date,
  supersedes_id uuid references pricing_rate_cards(id),
  approval_id uuid references platform_approvals(id),
  refusals int not null default 0 check (refusals >= 0),
  note text check (note is null or char_length(trim(note)) between 8 and 600),
  published_by uuid references users(id),
  published_at timestamptz,
  -- The sentence the second seat signed, copied onto the row so the register reads without the approval
  -- being open. 135's rule: an operator-typed reason that is rendered nowhere is a dead end.
  published_note text check (published_note is null
                              or char_length(trim(published_note)) between 8 and 600),
  withdrawn_by uuid references users(id),
  withdrawn_at timestamptz,
  withdrawn_reason text check (withdrawn_reason is null
                                or char_length(trim(withdrawn_reason)) between 8 and 600),
  created_by uuid references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pricing_cards_one_version_per_code unique (tenant_id, code, version),
  constraint pricing_window_is_a_window check (
    effective_from is null or effective_to is null or effective_to >= effective_from),
  -- A published price has to be valid *from* a day, or the resolver has nothing to compare a date to.
  constraint pricing_published_has_a_start check (
    status <> 'published' or (effective_from is not null and published_at is not null)),
  constraint pricing_publish_leaves_a_mark check (
    published_at is null or status in ('published','superseded','withdrawn')),
  constraint pricing_withdrawal_is_explained check (
    (status = 'withdrawn') = (withdrawn_at is not null and withdrawn_reason is not null)),
  constraint pricing_unsigned_paper_is_pending check (
    status <> 'pending_signature' or approval_id is not null),
  constraint pricing_does_not_supersede_itself check (
    supersedes_id is null or supersedes_id <> id)
);

-- The board's heading is one book filtered by status, and the resolver walks a book by code.
create index if not exists pricing_cards_book_idx on pricing_rate_cards (tenant_id, status, code);
create index if not exists pricing_cards_code_idx on pricing_rate_cards (code, version desc);

alter table pricing_rate_cards enable row level security;
create policy pricing_cards_tenant on pricing_rate_cards for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on pricing_rate_cards to app_runtime;
revoke all on pricing_rate_cards from public, anon, authenticated, service_role;

create trigger trg_pricing_cards_updated before update on pricing_rate_cards
  for each row execute function public.set_updated_at();

-- ============================================================
-- 3. the lines: what one scope costs
-- ============================================================

create table if not exists pricing_rate_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  card_id uuid not null references pricing_rate_cards(id),
  -- Null means "any": a wildcard line prices every route in the book, and the resolver prefers the
  -- specific line when there is one. Null is a value in the scope, so it is folded into `scope_key`
  -- rather than left to a unique index, which treats two nulls as unrelated rows and would happily hold
  -- two different wildcard prices for one card.
  route_id uuid references routes(id),
  vehicle_class text,
  container_type text,
  basis text not null,
  -- The figures are `numeric(14,4)` for a rate because a per-kilometre price is a fourth-decimal number,
  -- and `::text` of the column is the canonical form the signature is cut on.
  rate numeric(14,4) not null check (rate >= 0 and rate < 10000000000),
  min_charge numeric(14,2) check (min_charge is null or (min_charge >= 0 and min_charge < 100000000000)),
  scope_key text not null,
  sort int not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pricing_lines_one_price_per_scope unique (card_id, scope_key)
);

create index if not exists pricing_lines_card_idx on pricing_rate_lines (card_id, scope_key);
create index if not exists pricing_lines_book_idx on pricing_rate_lines (tenant_id, basis);

alter table pricing_rate_lines enable row level security;
create policy pricing_lines_tenant on pricing_rate_lines for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on pricing_rate_lines to app_runtime;
revoke all on pricing_rate_lines from public, anon, authenticated, service_role;

create trigger trg_pricing_lines_updated before update on pricing_rate_lines
  for each row execute function public.set_updated_at();

-- ============================================================
-- 4. the memory: what the price used to be
-- ============================================================

-- One row per thing that moved, and the pair stored as text because a price change, a window change and
-- a state change are all answers to "what was it before" and none of them is arithmetic. Written by the
-- doors in the same statement as the change they describe — which is what 069 asked for and what makes
-- "did the December change cost us anyone" answerable at all.
create table if not exists pricing_price_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  card_id uuid not null references pricing_rate_cards(id),
  line_id uuid references pricing_rate_lines(id),
  what text not null check (what in ('rate','min_charge','window','state')),
  -- Printed for a person: "Dar es Salaam → Kigoma / trailer / per_km". A history row that cannot say
  -- which price it meant is a number with no story.
  scope text not null check (char_length(scope) between 1 and 200),
  old_value text,
  new_value text not null,
  currency text,
  reason text not null check (char_length(trim(reason)) between 8 and 600),
  actor_user_id uuid references users(id),
  actor_role text,
  approval_id uuid references platform_approvals(id),
  at timestamptz not null default now()
);

create index if not exists pricing_history_card_idx on pricing_price_history (card_id, at desc);
create index if not exists pricing_history_book_idx on pricing_price_history (tenant_id, at desc);

alter table pricing_price_history enable row level security;
create policy pricing_history_tenant on pricing_price_history for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on pricing_price_history to app_runtime;
revoke all on pricing_price_history from public, anon, authenticated, service_role;

-- ============================================================
-- 5. the guards
-- ============================================================

-- The register's memory is not editable. 133 refuses a leg that is rewritten and 135 refuses a signed
-- count; this refuses a price-history row that is, because the only thing a changed memory proves is
-- that the memory was never a record.
create or replace function platform_auth.pricing_history_is_kept() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  raise exception '140: a price-history row is a record of what the office signed, and it cannot be %',
    tg_op;
end $$;

create trigger pricing_history_is_append_only
  before update or delete on pricing_price_history
  for each row execute function platform_auth.pricing_history_is_kept();

-- A card that was signed for, or that a signature ever stood on, is not deleted — not even after it is
-- superseded. A draft a desk opened by mistake is discardable through `discard_pricing_card`, which
-- deletes the row and leaves the audit line, exactly as 135 lets an open count be thrown away and 133
-- never lets a posting be.
create or replace function platform_auth.pricing_card_is_kept() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if OLD.published_at is not null or OLD.approval_id is not null or OLD.status <> 'draft' then
    raise exception '140: % is a % card that % a signature, so it is kept: %',
      OLD.ref, OLD.status,
      case when OLD.approval_id is not null then 'carries' else 'never had' end,
      case when OLD.published_at is not null or OLD.status <> 'draft'
        then 'a price a customer may have been quoted is ended by withdrawing it or by a new version, '
          || 'never by a delete'
        else 'a paper that anyone was asked to sign names this card, and the card is kept so the paper '
          || 'goes on naming something'
      end;
  end if;
  return OLD;
end $$;

create trigger pricing_cards_are_kept
  before delete on pricing_rate_cards
  for each row execute function platform_auth.pricing_card_is_kept();

-- The header's identity never moves, a published price's start date never moves, and a published price
-- never goes back to being a draft. `effective_to` is the one date a door may bring forward, because
-- closing a window is how a version ends.
create or replace function platform_auth.pricing_card_header_is_immutable() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.id         is distinct from OLD.id
    or NEW.tenant_id is distinct from OLD.tenant_id
    or NEW.ref       is distinct from OLD.ref
    or NEW.code      is distinct from OLD.code
    or NEW.version   is distinct from OLD.version
    or NEW.created_at is distinct from OLD.created_at
    or NEW.created_by is distinct from OLD.created_by then
    raise exception '140: % belongs to the book % as % version %, and that is not editable',
      OLD.ref, OLD.tenant_id, OLD.code, OLD.version;
  end if;
  if NEW.currency is distinct from OLD.currency and exists (
       select 1 from pricing_rate_lines l where l.card_id = OLD.id) then
    raise exception '140: % prices in % and already carries figures. A money changed under a rate is a '
      'price cut that no signature describes.', OLD.ref, OLD.currency;
  end if;
  if OLD.published_at is not null and NEW.effective_from is distinct from OLD.effective_from then
    raise exception '140: % was published as effective from %, and the day a customer was quoted for is '
      'not moved afterwards.',
      OLD.ref, coalesce(OLD.effective_from::text, 'nothing');
  end if;
  -- Published, superseded and withdrawn are all "this was a price". Only a paper that was never signed
  -- can go back to being a draft — that is the refusal, and nothing else.
  if OLD.published_at is not null and NEW.status = 'draft' then
    raise exception '140: % has been a live price. A version that was signed is superseded or withdrawn, '
      'never edited back into a draft.', OLD.ref;
  end if;
  if OLD.status = 'withdrawn' and NEW.status is distinct from OLD.status then
    raise exception '140: % was stopped on %, and a stopped price stays stopped.',
      OLD.ref, to_char(OLD.withdrawn_at, 'YYYY-MM-DD');
  end if;
  if OLD.status = 'superseded' and NEW.status is distinct from OLD.status then
    raise exception '140: % was closed by the version that replaced it; there is nothing left to change.',
      OLD.ref;
  end if;
  return NEW;
end $$;

create trigger pricing_cards_keep_their_dates
  before update on pricing_rate_cards
  for each row execute function platform_auth.pricing_card_header_is_immutable();

-- Two published cards of one list covering one day would make the resolver's answer depend on which row
-- it happened to read first. The overlap is refused here, in the register, so it holds against the next
-- door somebody writes in a hurry. NULL is read as "open", never skipped — a guard that compares windows
-- with bare operators is NULL-transparent and lets the overlap through.
create or replace function platform_auth.pricing_one_price_per_day() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_other pricing_rate_cards;
begin
  if NEW.status <> 'published' then
    return NEW;
  end if;
  select * into v_other from pricing_rate_cards c
   where c.tenant_id = NEW.tenant_id
     and c.code = NEW.code
     and c.status = 'published'
     and c.id <> NEW.id
     and NEW.effective_from is not null
     and coalesce(c.effective_to, date 'infinity') >= NEW.effective_from
     and coalesce(NEW.effective_to, date 'infinity') >= c.effective_from
   order by c.effective_from desc limit 1;
  if found then
    raise exception '140: % is already published for this list over the days %–%. Two prices for one day '
      'is not a choice the resolver can make.',
      v_other.ref,
      to_char(least(v_other.effective_from, NEW.effective_from), 'YYYY-MM-DD'),
      to_char(greatest(coalesce(v_other.effective_to, NEW.effective_to),
                       coalesce(NEW.effective_to, v_other.effective_to)), 'YYYY-MM-DD');
  end if;
  return NEW;
end $$;

create trigger pricing_cards_do_not_overlap
  before insert or update on pricing_rate_cards
  for each row execute function platform_auth.pricing_one_price_per_day();

-- The figures on a card stop being editable the moment it is not a draft, in all three directions: no
-- INSERT beside a signed card, no UPDATE of a rate and no DELETE of a line. A price a customer was quoted
-- survives its version, and a line typed in by hand beside a published card would move the paper's bytes
-- under the signature that describes them.
create or replace function platform_auth.pricing_signed_price_is_not_edited() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_card pricing_rate_cards;
  v_card_id uuid;
begin
  v_card_id := case when tg_op = 'DELETE' then OLD.card_id else NEW.card_id end;
  select * into v_card from pricing_rate_cards where id = v_card_id;
  if not found then
    raise exception '140: a rate line cannot be % without the card it belongs to', lower(tg_op);
  end if;
  if v_card.status <> 'draft' then
    raise exception '140: % is %, so its prices are kept. Change a price by cloning the card to a new '
      'version and signing that.', v_card.ref, v_card.status;
  end if;
  return case when tg_op = 'DELETE' then OLD else NEW end;
end $$;

create trigger pricing_lines_are_frozen_after_publish
  before insert or update or delete on pricing_rate_lines
  for each row execute function platform_auth.pricing_signed_price_is_not_edited();

-- What a line may name: the words that exist, the route in the same book, and a scope key that is the
-- canonical form of the scope rather than whatever the caller typed.
create or replace function platform_auth.pricing_line_names_its_own_book() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_card pricing_rate_cards;
  v_canon text;
begin
  select * into v_card from pricing_rate_cards where id = NEW.card_id;
  if not found then
    raise exception '140: a rate line cannot name a card that is not in the book';
  end if;
  if NEW.tenant_id <> v_card.tenant_id then
    raise exception '140: that line names a different book from the card it sits on';
  end if;
  if v_card.currency <> 'TZS' and v_card.currency <> 'USD' then
    raise exception '140: % carries a money this register cannot price', v_card.ref;
  end if;
  if NEW.route_id is not null then
    if not exists (select 1 from routes r
                    where r.id = NEW.route_id and r.tenant_id = v_card.tenant_id
                      and r.deleted_at is null) then
      raise exception '140: route % is not a route of the book that owns % — a card cannot price a '
        'corridor it does not have', NEW.route_id, v_card.ref;
    end if;
  end if;
  if NEW.vehicle_class is not null and not exists (
       select 1 from pricing_dimensions d
        where d.kind = 'vehicle_class' and d.key = NEW.vehicle_class) then
    raise exception '140: % is not a vehicle class this register knows', NEW.vehicle_class;
  end if;
  if NEW.container_type is not null and not exists (
       select 1 from pricing_dimensions d
        where d.kind = 'container' and d.key = NEW.container_type) then
    raise exception '140: % is not a container kind cargo can be filed as', NEW.container_type;
  end if;
  if not exists (select 1 from pricing_dimensions d
                  where d.kind = 'basis' and d.key = NEW.basis) then
    raise exception '140: % is not a basis the resolver knows how to multiply', NEW.basis;
  end if;
  v_canon := coalesce(NEW.route_id::text, '*') || '|'
          || coalesce(NEW.vehicle_class, '*') || '|'
          || coalesce(NEW.container_type, '*') || '|'
          || NEW.basis;
  if NEW.scope_key is distinct from v_canon then
    NEW.scope_key := v_canon;
  end if;
  return NEW;
end $$;

create trigger pricing_lines_belong_to_their_card
  before insert or update on pricing_rate_lines
  for each row execute function platform_auth.pricing_line_names_its_own_book();

-- ============================================================
-- 6. the paper a second seat signs
-- ============================================================

-- The canonical bytes of a card: the header, then the lines in scope order, with the figures printed as
-- the columns store them. `pricing_paper` is the payload the proposal is cut on and `apply_pricing_publish`
-- rebuilds it from the row before it flips anything, so a line edited under a signature is caught rather
-- than published. jsonb normalises key order, which is why a payload survives being re-sent by a
-- different client; the line order is normalised here because jsonb does not sort arrays.
create or replace function platform_auth.pricing_paper(p_card uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'card_id', c.id::text,
    'ref', c.ref,
    'code', c.code,
    'label', c.label,
    'currency', c.currency,
    'version', c.version,
    'effective_from', c.effective_from::text,
    'effective_to', c.effective_to::text,
    'line_count', (select count(*)::int from pricing_rate_lines l where l.card_id = c.id),
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'scope', l.scope_key,
               'route', coalesce(r.name, 'any route'),
               'vehicle_class', coalesce(l.vehicle_class, 'any'),
               'container_type', coalesce(l.container_type, 'any'),
               'basis', l.basis,
               'rate', l.rate::text,
               'min_charge', l.min_charge::text)
               order by l.scope_key), '[]'::jsonb)
        from pricing_rate_lines l
        left join routes r on r.id = l.route_id
       where l.card_id = c.id))
  from pricing_rate_cards c
  where c.id = p_card
$$;

create or replace function platform_auth.pricing_sha256(p_card uuid)
returns text language sql stable security definer set search_path = public as $$
  select encode(extensions.digest(platform_auth.pricing_paper(p_card)::text, 'sha256'), 'hex')
$$;

-- ============================================================
-- 7. the reads
-- ============================================================

-- Every line the desk shows is counted from this heading, the way 135 counts the delivery piles from the
-- door's own words — a desk that counts its own rows in the client is a desk whose chips disagree with
-- its table after the first page.
create or replace function platform_auth.pricing_board(
  p_tenant uuid, p_status text, p_search text, p_code text, p_limit int, p_offset int
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_limit int;
  v_offset int;
  v_status text;
  v_rows jsonb;
  v_counts jsonb;
  v_total int;
begin
  v_limit := least(greatest(coalesce(p_limit, 30), 1), 200);
  v_offset := greatest(coalesce(p_offset, 0), 0);
  v_status := nullif(lower(trim(coalesce(p_status, ''))), '');
  if v_status is not null and v_status not in
     ('draft','pending_signature','published','superseded','withdrawn') then
    return jsonb_build_object('ok', false, 'error', 'bad_status', 'asked', v_status,
      'message', 'A card is a draft, a paper waiting for a signature, a live price, a superseded one, '
        || 'or a withdrawn one.');
  end if;
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'There is no price list in a book that is not here.');
  end if;

  -- The page is cut in the subquery and counted over the whole filter, so `total` is the number of cards
  -- the heading describes rather than the number of rows this page carried.
  --
  -- A search reaches the corridors a card prices, not only the name the office gave the list: the question
  -- at the desk is "is there a price for Kigoma", and a card that prices the Kigoma corridor under a
  -- general label has to answer it.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'ref', x.ref, 'code', x.code, 'label', x.label, 'currency', x.currency,
           'status', x.status, 'version', x.version,
           'effective_from', x.effective_from::text, 'effective_to', x.effective_to::text,
           'line_count', (select count(*)::int from pricing_rate_lines l where l.card_id = x.id),
           'cheapest', (select min(l.rate)::text from pricing_rate_lines l where l.card_id = x.id),
           'refusals', x.refusals,
           'approval_id', x.approval_id,
           'approval_status', (select a.status from platform_approvals a where a.id = x.approval_id),
           'published_by', (select u.full_name from users u where u.id = x.published_by),
           'published_at', to_char(x.published_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'published_note', x.published_note,
           'withdrawn_reason', x.withdrawn_reason,
           'supersedes', (select s.ref from pricing_rate_cards s where s.id = x.supersedes_id),
           'updated_at', to_char(x.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
           order by x.code, x.version desc, x.created_at desc), '[]'::jsonb),
         coalesce(max(x.whole), 0)::int
    into v_rows, v_total
  from (
    select c.id, c.ref, c.code, c.label, c.currency, c.status, c.version, c.effective_from,
           c.effective_to, c.refusals, c.approval_id, c.published_by, c.published_at,
           c.published_note, c.withdrawn_reason, c.supersedes_id, c.updated_at, c.created_at,
           -- The window sees every row the filter matched before the page is cut, so one predicate
           -- answers both the rows and the count — the heading cannot disagree with what it printed.
           count(*) over () as whole
      from pricing_rate_cards c
     where c.tenant_id = p_tenant
       and (v_status is null or c.status = v_status)
       and (nullif(trim(coalesce(p_code, '')), '') is null or c.code = upper(trim(p_code)))
       and (nullif(trim(coalesce(p_search, '')), '') is null
            or c.label ilike '%' || trim(p_search) || '%'
            or c.code ilike '%' || upper(trim(p_search)) || '%'
            or c.ref ilike '%' || upper(trim(p_search)) || '%'
            or exists (select 1 from pricing_rate_lines l
                        join routes r on r.id = l.route_id
                       where l.card_id = c.id
                         and (r.name ilike '%' || trim(p_search) || '%'
                              or r.origin_text ilike '%' || trim(p_search) || '%'
                              or r.dest_text ilike '%' || trim(p_search) || '%')))
     order by c.code, c.version desc, c.created_at desc
     limit v_limit offset v_offset
  ) x;

  select coalesce(jsonb_object_agg(st.n, cnt.n) filter (where cnt.n > 0), '{}'::jsonb)
    into v_counts
  from (values ('draft'::text), ('pending_signature'), ('published'), ('superseded'), ('withdrawn')) st(n)
  cross join lateral (
    select count(*)::int as n from pricing_rate_cards c
     where c.tenant_id = p_tenant and c.status = st.n
  ) cnt;

  return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total,
    'counts', v_counts, 'limit', v_limit, 'offset', v_offset);
end $$;

-- One card, its lines with the route label beside each scope, the version line the code has travelled
-- through, the signature behind it and the last twenty rows of its memory.
create or replace function platform_auth.pricing_card_detail(p_tenant uuid, p_card uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_card pricing_rate_cards;
  v_lines jsonb;
  v_versions jsonb;
  v_approval jsonb;
  v_memory jsonb;
begin
  select * into v_card from pricing_rate_cards where id = p_card and tenant_id = p_tenant;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no price list with that number in this book.');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'scope_key', l.scope_key, 'route_id', l.route_id,
           'route', coalesce(r.name, 'any route'), 'route_label',
             trim(both ' ' from concat_ws(' → ', r.origin_text, r.dest_text)),
           'distance_km', r.distance_km,
           'vehicle_class', l.vehicle_class, 'container_type', l.container_type,
           'basis', l.basis, 'basis_label', (select d.label from pricing_dimensions d
                                              where d.kind = 'basis' and d.key = l.basis),
           'rate', l.rate::text, 'min_charge', l.min_charge::text, 'sort', l.sort)
           order by l.sort, l.scope_key), '[]'::jsonb)
    into v_lines
  from pricing_rate_lines l left join routes r on r.id = l.route_id
  where l.card_id = v_card.id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'ref', v.ref, 'version', v.version, 'status', v.status,
           'effective_from', v.effective_from::text, 'effective_to', v.effective_to::text,
           'published_at', to_char(v.published_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'published_by', (select u.full_name from users u where u.id = v.published_by))
           order by v.version desc), '[]'::jsonb)
    into v_versions
  from pricing_rate_cards v
  where v.tenant_id = v_card.tenant_id and v.code = v_card.code;

  select jsonb_build_object(
           'id', a.id, 'status', a.status, 'reason', a.reason,
           'proposed_by', (select u.full_name from users u where u.id = a.proposed_by),
           'proposed_at', to_char(a.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'decided_by', (select u.full_name from users u where u.id = a.decided_by),
           'expires_at', to_char(a.expires_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'payload_sha256', a.payload_sha256)
    into v_approval
  from platform_approvals a where a.id = v_card.approval_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'at', to_char(h.at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'what', h.what,
           'scope', h.scope, 'old_value', h.old_value, 'new_value', h.new_value,
           'currency', h.currency, 'reason', h.reason,
           'actor', (select u.full_name from users u where u.id = h.actor_user_id))
           order by h.at desc), '[]'::jsonb)
    into v_memory
  from (select * from pricing_price_history p
         where p.card_id = v_card.id order by p.at desc limit 20) h;

  return jsonb_build_object('ok', true,
    'card', jsonb_build_object(
      'id', v_card.id, 'ref', v_card.ref, 'code', v_card.code, 'label', v_card.label,
      'currency', v_card.currency, 'status', v_card.status, 'version', v_card.version,
      'effective_from', v_card.effective_from::text, 'effective_to', v_card.effective_to::text,
      'note', v_card.note, 'refusals', v_card.refusals,
      'approval_id', v_card.approval_id,
      'supersedes', (select s.ref from pricing_rate_cards s where s.id = v_card.supersedes_id),
      'published_by', (select u.full_name from users u where u.id = v_card.published_by),
      'published_at', to_char(v_card.published_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'published_note', v_card.published_note,
      'withdrawn_reason', v_card.withdrawn_reason,
      'withdrawn_at', to_char(v_card.withdrawn_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'created_at', to_char(v_card.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    'lines', v_lines, 'versions', v_versions, 'approval', v_approval, 'memory', v_memory,
    'paper_sha256', platform_auth.pricing_sha256(v_card.id));
end $$;

create or replace function platform_auth.pricing_history(
  p_tenant uuid, p_card uuid, p_limit int, p_offset int
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_rows jsonb;
  v_total int;
  v_limit int;
  v_offset int;
begin
  v_limit := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset := greatest(coalesce(p_offset, 0), 0);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'card', x.card_ref, 'code', x.card_code, 'what', x.what, 'scope', x.scope,
           'old_value', x.old_value, 'new_value', x.new_value, 'currency', x.currency,
           'reason', x.reason,
           'actor', (select u.full_name from users u where u.id = x.actor_user_id),
           'actor_role', x.actor_role,
           'at', to_char(x.at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
           order by x.at desc, x.scope), '[]'::jsonb)
    into v_rows
  from (
    select h.id, h.what, h.scope, h.old_value, h.new_value, h.currency, h.reason,
           h.actor_user_id, h.actor_role, h.at, c.ref as card_ref, c.code as card_code
      from pricing_price_history h
      join pricing_rate_cards c on c.id = h.card_id
     where h.tenant_id = p_tenant
       and (p_card is null or h.card_id = p_card)
     order by h.at desc, h.scope
     limit v_limit offset v_offset
  ) x;

  -- Counted over the whole filter, not over the page: a memory that says "4 rows" when the desk asked
  -- for a 50-row page of 400 changes is a memory that cannot be paged through.
  select count(*)::int into v_total
    from pricing_price_history h
   where h.tenant_id = p_tenant
     and (p_card is null or h.card_id = p_card);

  return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total,
    'limit', v_limit, 'offset', v_offset);
end $$;

-- ============================================================
-- 7b. the corridors this book can price
-- ============================================================

-- A line that names a route prices a road, and `routes` (019) is a tenant table: the office's tariff
-- runs along the office's corridors. Until this section the desk had no way to name one — `set_pricing_line`
-- refused a corridor that was not in the book, the resolver refused to multiply a kilometre with no
-- corridor on the line, and the sentence it printed told the clerk to "fill the corridor in on the routes
-- desk", which is a portal desk a platform seat does not sit at. So the register files its own corridors
-- here, into the book that asked, with the same seat guard every other write in this migration runs
-- through. It is deliberately not a copy of `geo_corridors` (075): those are the map's curated chains with
-- no distance, and a price keyed on a chain nobody measured is a quote nobody can honour.
--
-- `distance_km` on 019 is an `int`, so the figure asked for is rounded here rather than at the column —
-- a desk that types 985.6 is told what the register wrote, and 140's memory row carries the same number
-- the resolver will later multiply.

/** Params: book, search|null, limit, offset. */
create or replace function platform_auth.pricing_corridors(
  p_tenant uuid, p_search text, p_limit int, p_offset int
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_limit int;
  v_offset int;
  v_q text;
  v_rows jsonb;
  v_total int;
begin
  v_limit := least(greatest(coalesce(p_limit, 60), 1), 200);
  v_offset := greatest(coalesce(p_offset, 0), 0);
  v_q := nullif(trim(coalesce(p_search, '')), '');
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'A corridor belongs to a book that exists.');
  end if;

  -- `priced_on` is the card count, not the line count: the question at the desk is "is this road already
  -- in somebody's price list", and a road priced on three bases under one card is one answer.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'name', x.name, 'corridor', x.corridor,
           'origin', x.origin_text, 'dest', x.dest_text,
           'distance_km', x.distance_km, 'has_distance', (x.distance_km is not null),
           'duration_hours', x.expected_duration_hours, 'road_class', x.road_class,
           'priced_on', x.priced,
           'updated_at', to_char(x.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
           order by x.name), '[]'::jsonb),
         coalesce(max(x.whole), 0)::int
    into v_rows, v_total
  from (
    select r.id, r.name, r.corridor, r.origin_text, r.dest_text, r.distance_km,
           r.expected_duration_hours, r.road_class, r.updated_at,
           (select count(distinct l.card_id)::int from pricing_rate_lines l
              join pricing_rate_cards c on c.id = l.card_id
             where l.route_id = r.id and c.tenant_id = p_tenant
               and c.status in ('draft','pending_signature','published')) as priced,
           count(*) over () as whole
      from routes r
     where r.tenant_id = p_tenant
       and r.deleted_at is null
       and r.is_active
       and (v_q is null
            or r.name ilike '%' || v_q || '%'
            or r.corridor ilike '%' || v_q || '%'
            or r.origin_text ilike '%' || v_q || '%'
            or r.dest_text ilike '%' || v_q || '%')
     order by r.name
     limit v_limit offset v_offset
  ) x;

  return jsonb_build_object('ok', true, 'total', v_total, 'limit', v_limit, 'offset', v_offset,
    'rows', v_rows, 'clock', now());
end $$;

/**
 * Params: book, name, origin, dest, distance_km|null, actor, role, ip, ua.
 *
 * A corridor with no figure in it is still worth filing — it is the road a wildcard line will later be
 * asked about, and the resolver refuses to invent a distance. But a per-km price cannot be put on a line
 * whose corridor has never been measured, so the desk is told which of the two it is holding.
 */
create or replace function platform_auth.file_pricing_corridor(
  p_tenant uuid, p_name text, p_origin text, p_dest text, p_distance_km numeric,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_origin text;
  v_dest text;
  v_seat text;
  v_km int;
  v_route routes;
begin
  v_seat := platform_auth.approval_seat(p_actor);
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can file a corridor of the office''s book.');
  end if;
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'A corridor belongs to a book that exists.');
  end if;

  v_name := trim(coalesce(p_name, ''));
  v_origin := trim(coalesce(p_origin, ''));
  v_dest := trim(coalesce(p_dest, ''));
  if char_length(v_name) < 3 or char_length(v_name) > 120 then
    return jsonb_build_object('ok', false, 'error', 'bad_name',
      'message', 'Name the corridor in 3-120 characters — the way a clerk would say it out loud.');
  end if;
  if char_length(v_origin) < 2 or char_length(v_origin) > 80
     or char_length(v_dest) < 2 or char_length(v_dest) > 80 then
    return jsonb_build_object('ok', false, 'error', 'bad_ends',
      'message', 'Both ends are 2-80 characters. A job priced along a road nobody knows the ends of is '
        || 'a figure with no road under it.');
  end if;
  if p_distance_km is not null and (p_distance_km <= 0 or p_distance_km > 5000) then
    return jsonb_build_object('ok', false, 'error', 'bad_distance', 'asked', p_distance_km,
      'message', 'The distance is the kilometres between the two ends, in whole kilometres. Nothing in '
        || 'this country runs 5000 km, so a number that big is a keystroke, not a road.');
  end if;
  v_km := case when p_distance_km is null then null else round(p_distance_km)::int end;

  if exists (select 1 from routes r where r.tenant_id = p_tenant and r.deleted_at is null
              and lower(trim(r.name)) = lower(v_name)) then
    return jsonb_build_object('ok', false, 'error', 'corridor_taken', 'name', v_name,
      'message', 'This book already files a corridor under that name. A second card priced along two '
        || 'roads of one name is a price nobody can be held to.');
  end if;

  insert into routes (id, tenant_id, name, origin_text, dest_text, distance_km, is_active,
                      created_by, updated_by)
  values (gen_random_uuid(), p_tenant, v_name, v_origin, v_dest, v_km, true, p_actor, p_actor)
  returning * into v_route;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'routes', v_route.id, 'pricing.corridor_filed', null,
    jsonb_build_object('name', v_route.name, 'origin', v_route.origin_text,
      'dest', v_route.dest_text, 'distance_km', v_route.distance_km, 'seat', v_seat));

  return jsonb_build_object('ok', true,
    'corridor', jsonb_build_object('id', v_route.id, 'name', v_route.name,
      'origin', v_route.origin_text, 'dest', v_route.dest_text,
      'distance_km', v_route.distance_km, 'has_distance', (v_route.distance_km is not null),
      'filed_by', v_seat),
    'message', 'Filed ' || v_route.name || ' in this book'
      || (case when v_route.distance_km is null
               then ' with no distance — a per-kilometre price needs one, and the board will say so.'
               else ' at ' || v_route.distance_km || ' km.' end));
end $$;

-- ============================================================
-- 8. the draft doors
-- ============================================================

create or replace function platform_auth.open_pricing_card(
  p_tenant uuid, p_code text, p_label text, p_currency text, p_effective_from date,
  p_note text, p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_code text;
  v_label text;
  v_cur text;
  v_note text;
  v_from date;
  v_version int;
  v_card pricing_rate_cards;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can open a price list.');
  end if;
  v_code := upper(replace(trim(coalesce(p_code, '')), ' ', '_'));
  v_label := trim(coalesce(p_label, ''));
  v_cur := upper(trim(coalesce(p_currency, 'TZS')));
  v_note := trim(coalesce(p_note, ''));
  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{1,29}$' then
    return jsonb_build_object('ok', false, 'error', 'bad_code', 'asked', v_code,
      'message', 'A list is named in capitals with underscores, like FREIGHT-STD: the name is said out '
        || 'loud and survives a version bump.');
  end if;
  if char_length(v_label) < 3 or char_length(v_label) > 80 then
    return jsonb_build_object('ok', false, 'error', 'bad_label',
      'message', 'The label is the sentence a clerk reads, and it is 3-80 characters.');
  end if;
  if v_cur not in ('TZS','USD') then
    return jsonb_build_object('ok', false, 'error', 'bad_currency', 'asked', v_cur,
      'message', 'A list is one money: TZS or USD. 135 refuses a count that mixes them, and a card '
        || 'that mixes them is the same mistake one level up.');
  end if;
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'Say in 8-600 characters what this list is for: the second seat reads it before '
        || 'signing the price.');
  end if;
  v_from := coalesce(p_effective_from, current_date);
  if not exists (select 1 from tenants t where t.id = p_tenant and t.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'no_book',
      'message', 'A price list belongs to a book that exists.');
  end if;

  v_version := coalesce((select max(c.version) from pricing_rate_cards c
                          where c.tenant_id = p_tenant and c.code = v_code), 0) + 1;

  insert into pricing_rate_cards (id, tenant_id, ref, code, label, currency, status, version,
    effective_from, note, created_by, updated_by)
  values (gen_random_uuid(), p_tenant,
          'PRC-' || to_char(now(), 'YYYY') || '-'
                  || lpad(nextval('pricing_card_number_seq')::text, 5, '0'),
          v_code, v_label, v_cur, 'draft', v_version, v_from, v_note, p_actor, p_actor)
  returning * into v_card;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_rate_cards', v_card.id, 'pricing.card_opened', null,
    jsonb_build_object('ref', v_card.ref, 'code', v_card.code, 'label', v_card.label,
      'currency', v_card.currency, 'version', v_card.version,
      'effective_from', v_card.effective_from::text, 'note', v_card.note, 'seat', v_name));

  return platform_auth.pricing_card_detail(p_tenant, v_card.id);
end $$;

-- Editing a draft. The money is frozen once the card has figures under it, because a TZS rate re-labelled
-- USD is the 138 defect wearing a different hat.
create or replace function platform_auth.edit_pricing_card(
  p_tenant uuid, p_card uuid, p_label text, p_currency text, p_effective_from date,
  p_note text, p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_card pricing_rate_cards;
  v_label text;
  v_cur text;
  v_note text;
  v_before jsonb;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can change a draft.');
  end if;
  select * into v_card from pricing_rate_cards
    where id = p_card and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no price list with that number in this book. Quote the PRC- number on the paper.');
  end if;
  if v_card.status = 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'paper_is_out', 'ref', v_card.ref,
      'message', v_card.ref || ' is waiting for a second seat. Refuse the signature first — a paper the '
        || 'office is asked to sign cannot change underneath them.');
  end if;
  if v_card.published_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_lived', 'ref', v_card.ref,
      'message', v_card.ref || ' was a live price. Clone it to a new version instead of editing it.');
  end if;

  v_label := trim(coalesce(p_label, v_card.label));
  v_cur := upper(trim(coalesce(p_currency, v_card.currency)));
  v_note := trim(coalesce(p_note, coalesce(v_card.note, '')));
  if char_length(v_label) < 3 or char_length(v_label) > 80 then
    return jsonb_build_object('ok', false, 'error', 'bad_label',
      'message', 'The label is 3-80 characters.');
  end if;
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'The note is 8-600 characters: it is the sentence the second seat reads.');
  end if;
  if v_cur not in ('TZS','USD') then
    return jsonb_build_object('ok', false, 'error', 'bad_currency', 'asked', v_cur,
      'message', 'A list is one money: TZS or USD.');
  end if;
  if v_cur <> v_card.currency and exists (select 1 from pricing_rate_lines where card_id = v_card.id) then
    return jsonb_build_object('ok', false, 'error', 'figures_are_typed', 'ref', v_card.ref,
      'message', v_card.ref || ' already carries figures. A TZS rate relabelled USD is not a price in '
        || 'USD, so the money is fixed once the first line is written — open a new list instead.');
  end if;

  v_before := jsonb_build_object('label', v_card.label, 'currency', v_card.currency,
    'effective_from', v_card.effective_from::text, 'note', v_card.note);

  update pricing_rate_cards
     set label = v_label, currency = v_cur, note = v_note,
         effective_from = coalesce(p_effective_from, effective_from), updated_by = p_actor
   where id = v_card.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_rate_cards', v_card.id, 'pricing.card_edited', v_before,
    jsonb_build_object('ref', v_card.ref, 'label', v_label, 'currency', v_cur,
      'effective_from', coalesce(p_effective_from, v_card.effective_from)::text, 'note', v_note,
      'seat', v_name));

  return platform_auth.pricing_card_detail(p_tenant, v_card.id);
end $$;

-- Put a price on a scope. One call inserts or replaces, because a clerk who has to delete before they fix
-- a typed figure will get the order wrong once and lose the line.
create or replace function platform_auth.set_pricing_line(
  p_tenant uuid, p_card uuid, p_route uuid, p_vehicle_class text, p_container text,
  p_basis text, p_rate numeric, p_min_charge numeric,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_card pricing_rate_cards;
  v_class text;
  v_cont text;
  v_basis text;
  v_scope text;
  v_line pricing_rate_lines;
  v_old pricing_rate_lines;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can write a price.');
  end if;
  select * into v_card from pricing_rate_cards
    where id = p_card and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no price list with that number in this book.');
  end if;
  if v_card.status <> 'draft' then
    return jsonb_build_object('ok', false, 'error', 'not_a_draft', 'ref', v_card.ref,
      'status', v_card.status,
      'message', v_card.ref || ' is ' || v_card.status || '. A price that has been signed is changed by '
        'cloning the list to a new version, never by editing the live one.');
  end if;

  v_class := nullif(lower(trim(coalesce(p_vehicle_class, ''))), '');
  v_cont := nullif(lower(trim(coalesce(p_container, ''))), '');
  v_basis := lower(trim(coalesce(p_basis, '')));
  if p_rate is null or p_rate < 0 or p_rate >= 10000000000 then
    return jsonb_build_object('ok', false, 'error', 'bad_rate', 'asked', p_rate,
      'message', 'A rate is a figure from 0 up. A negative price is a refund, and a refund is money '
        || 'leaving — 126 signs those.');
  end if;
  if p_min_charge is not null and (p_min_charge < 0 or p_min_charge >= 100000000000) then
    return jsonb_build_object('ok', false, 'error', 'bad_min', 'asked', p_min_charge,
      'message', 'A minimum is a figure from 0 up, or nothing at all.');
  end if;
  if not exists (select 1 from pricing_dimensions d where d.kind = 'basis' and d.key = v_basis) then
    return jsonb_build_object('ok', false, 'error', 'bad_basis', 'asked', v_basis,
      'message', 'The basis has to be one this register can multiply: '
        || (select string_agg(d.key, ', ' order by d.sort) from pricing_dimensions d
             where d.kind = 'basis') || '.');
  end if;
  if v_class is not null and not exists (
       select 1 from pricing_dimensions d where d.kind = 'vehicle_class' and d.key = v_class) then
    return jsonb_build_object('ok', false, 'error', 'bad_class', 'asked', v_class,
      'message', 'The vehicle class has to be one the board already asks a company to choose: '
        || (select string_agg(d.key, ', ' order by d.sort) from pricing_dimensions d
             where d.kind = 'vehicle_class') || '.');
  end if;
  if v_cont is not null and not exists (
       select 1 from pricing_dimensions d where d.kind = 'container' and d.key = v_cont) then
    return jsonb_build_object('ok', false, 'error', 'bad_container', 'asked', v_cont,
      'message', 'The container kind has to be one a cargo file can be filed as: '
        || (select string_agg(d.key, ', ' order by d.sort) from pricing_dimensions d
             where d.kind = 'container') || '.');
  end if;
  if p_route is not null and not exists (
       select 1 from routes r where r.id = p_route and r.tenant_id = p_tenant
         and r.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'route_not_in_book', 'route', p_route,
      'message', 'That route is not a corridor of this book, so nothing in this book can be priced along '
        || 'it. A card prices its own routes — 137 learned what happens when a desk reaches over the wall. '
        || 'File the corridor on this desk if it is genuinely the office''s own road.');
  end if;

  v_scope := coalesce(p_route::text, '*') || '|' || coalesce(v_class, '*') || '|'
          || coalesce(v_cont, '*') || '|' || v_basis;

  select * into v_old from pricing_rate_lines
    where card_id = v_card.id and scope_key = v_scope;

  insert into pricing_rate_lines (id, tenant_id, card_id, route_id, vehicle_class, container_type,
    basis, rate, min_charge, scope_key, created_by)
  values (gen_random_uuid(), p_tenant, v_card.id, p_route, v_class, v_cont, v_basis,
          p_rate::numeric(14,4), p_min_charge::numeric(14,2), v_scope, p_actor)
  on conflict (card_id, scope_key) do update
     set rate = excluded.rate,
         min_charge = excluded.min_charge,
         updated_at = now()
  returning * into v_line;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_rate_lines', v_line.id, 'pricing.line_set',
    case when v_old.id is null then null else jsonb_build_object('rate', v_old.rate::text,
      'min_charge', v_old.min_charge::text, 'scope', v_scope) end,
    jsonb_build_object('card', v_card.ref, 'card_version', v_card.version, 'scope', v_scope,
      'route', p_route, 'vehicle_class', v_class, 'container_type', v_cont, 'basis', v_basis,
      'rate', v_line.rate::text, 'min_charge', v_line.min_charge::text, 'currency', v_card.currency,
      'seat', v_name));

  return platform_auth.pricing_card_detail(p_tenant, v_card.id);
end $$;

create or replace function platform_auth.remove_pricing_line(
  p_tenant uuid, p_line uuid, p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_line pricing_rate_lines;
  v_card pricing_rate_cards;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can take a price off a draft.');
  end if;
  select * into v_line from pricing_rate_lines where id = p_line and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'That line is not in this book.');
  end if;
  select * into v_card from pricing_rate_cards where id = v_line.card_id for update;
  if v_card.status <> 'draft' then
    return jsonb_build_object('ok', false, 'error', 'not_a_draft', 'ref', v_card.ref,
      'status', v_card.status,
      'message', v_card.ref || ' is ' || v_card.status || '. A price a customer may have been quoted '
        || 'stays on the paper even when it is wrong — supersede the version.');
  end if;

  delete from pricing_rate_lines where id = v_line.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_rate_lines', v_line.id, 'pricing.line_removed',
    jsonb_build_object('scope', v_line.scope_key, 'rate', v_line.rate::text,
      'min_charge', v_line.min_charge::text),
    jsonb_build_object('card', v_card.ref, 'card_version', v_card.version, 'seat', v_name));

  return platform_auth.pricing_card_detail(p_tenant, v_card.id);
end $$;

-- A draft nobody signed is thrown away, not edited into something else. It leaves a row in the audit log
-- and no row here, which is 135's rule for an unanswered count: the register keeps what the office acted
-- on, and the log keeps the fact that somebody opened it.
create or replace function platform_auth.discard_pricing_card(
  p_tenant uuid, p_card uuid, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_card pricing_rate_cards;
  v_reason text;
  v_lines int;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can discard a draft.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'Say in 8-600 characters why the draft is thrown away: the audit line is the only thing '
        || 'that will remember it existed.');
  end if;
  select * into v_card from pricing_rate_cards
    where id = p_card and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no price list with that number in this book.');
  end if;
  if v_card.status <> 'draft' or v_card.approval_id is not null or v_card.published_at is not null then
    return jsonb_build_object('ok', false, 'error', 'not_a_draft', 'ref', v_card.ref,
      'status', v_card.status,
      'message', v_card.ref || ' is ' || v_card.status || ' and a signature '
        || case when v_card.approval_id is not null then 'stood' else 'never stood' end
        || ' on it. A paper that anyone was asked to sign is kept.');
  end if;

  -- Counted before the delete: an audit payload that asks how many lines the card held after they were
  -- gone answers "0" for every draft ever thrown away.
  v_lines := (select count(*)::int from pricing_rate_lines where card_id = v_card.id);

  delete from pricing_rate_lines where card_id = v_card.id;
  delete from pricing_rate_cards where id = v_card.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_rate_cards', v_card.id, 'pricing.card_discarded',
    jsonb_build_object('ref', v_card.ref, 'code', v_card.code, 'version', v_card.version,
      'status', v_card.status, 'lines', v_lines),
    jsonb_build_object('reason', v_reason, 'seat', v_name, 'lines_removed', v_lines));

  return jsonb_build_object('ok', true, 'discarded', v_card.ref, 'code', v_card.code,
    'version', v_card.version, 'reason', v_reason,
    'message', v_card.ref || ' was thrown away. Nothing was priced and nothing was signed.');
end $$;

-- The one way a live price changes: copy it forward. This is also how a rollback is done — clone the old
-- version, sign it, and it becomes the newest price without any row in the memory being rewritten.
create or replace function platform_auth.clone_pricing_card(
  p_tenant uuid, p_card uuid, p_effective_from date, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_src pricing_rate_cards;
  v_new pricing_rate_cards;
  v_from date;
  v_note text;
  v_lines int;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can clone a price list.');
  end if;
  select * into v_src from pricing_rate_cards
    where id = p_card and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no price list with that number in this book.');
  end if;
  if v_src.status = 'draft' or v_src.status = 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'nothing_to_clone', 'ref', v_src.ref,
      'status', v_src.status,
      'message', v_src.ref || ' is still a ' || v_src.status || '. Clone a version that has been '
        || 'published, superseded or withdrawn — that is where the figures worth carrying are.');
  end if;
  v_from := coalesce(p_effective_from, current_date);
  if v_from < current_date then
    return jsonb_build_object('ok', false, 'error', 'back_dating', 'asked', v_from::text,
      'message', 'A new version starts today or later. A price cannot be made valid for days that were '
        || 'already quoted under another one — that is what 140 keeps a memory for.');
  end if;
  v_note := trim(coalesce(p_note, v_src.note));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'Say in 8-600 characters what this version is for.');
  end if;

  insert into pricing_rate_cards (id, tenant_id, ref, code, label, currency, status, version,
    effective_from, note, supersedes_id, created_by, updated_by)
  values (gen_random_uuid(), p_tenant,
          'PRC-' || to_char(now(), 'YYYY') || '-'
                  || lpad(nextval('pricing_card_number_seq')::text, 5, '0'),
          v_src.code, v_src.label, v_src.currency, 'draft',
          (select max(c.version) from pricing_rate_cards c
            where c.tenant_id = p_tenant and c.code = v_src.code) + 1,
          v_from, v_note, v_src.id, p_actor, p_actor)
  returning * into v_new;

  insert into pricing_rate_lines (id, tenant_id, card_id, route_id, vehicle_class, container_type,
    basis, rate, min_charge, scope_key, sort, created_by)
  select gen_random_uuid(), p_tenant, v_new.id, l.route_id, l.vehicle_class, l.container_type,
         l.basis, l.rate, l.min_charge, l.scope_key, l.sort, p_actor
    from pricing_rate_lines l where l.card_id = v_src.id;
  get diagnostics v_lines = row_count;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_rate_cards', v_new.id, 'pricing.card_cloned',
    jsonb_build_object('ref', v_src.ref, 'code', v_src.code, 'version', v_src.version,
      'status', v_src.status),
    jsonb_build_object('ref', v_new.ref, 'code', v_new.code, 'version', v_new.version,
      'effective_from', v_new.effective_from::text, 'lines', v_lines, 'note', v_new.note,
      'seat', v_name));

  return platform_auth.pricing_card_detail(p_tenant, v_new.id);
end $$;

-- ============================================================
-- 9. the signature
-- ============================================================

create or replace function platform_auth.propose_pricing_publish(
  p_tenant uuid, p_card uuid, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_card pricing_rate_cards;
  v_reason text;
  v_lines int;
  v_paper jsonb;
  v_sha text;
  v_id uuid;
  v_open uuid;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can ask for a price to be signed.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'The reason must be 8-600 characters: it is the sentence the second seat signs.');
  end if;
  select * into v_card from pricing_rate_cards
    where id = p_card and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no price list with that number in this book.');
  end if;
  if v_card.status = 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'already_open', 'ref', v_card.ref,
      'approval_id', v_card.approval_id,
      'message', v_card.ref || ' is already waiting for a second seat. Refuse that paper first.');
  end if;
  if v_card.published_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_lived', 'ref', v_card.ref,
      'message', v_card.ref || ' has been a live price. Clone it forward — a version that was signed '
        || 'is not signed twice.');
  end if;
  if v_card.status <> 'draft' then
    return jsonb_build_object('ok', false, 'error', 'not_a_draft', 'ref', v_card.ref,
      'status', v_card.status, 'message', 'Only a draft can be put up for a signature.');
  end if;

  select count(*)::int into v_lines from pricing_rate_lines where card_id = v_card.id;
  if v_lines = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_prices', 'ref', v_card.ref,
      'message', v_card.ref || ' has no figures on it. There is nothing for a second seat to sign — '
        || 'a signature that approves an empty list approves whatever is typed next.');
  end if;
  if v_card.effective_from is null then
    return jsonb_build_object('ok', false, 'error', 'no_start', 'ref', v_card.ref,
      'message', v_card.ref || ' has no start date, so the resolver could never tell which day it was '
        || 'the price for.');
  end if;

  v_paper := platform_auth.pricing_paper(v_card.id);
  v_sha := encode(extensions.digest(v_paper::text, 'sha256'), 'hex');

  begin
    insert into platform_approvals (id, action, target_kind, target_id, payload, payload_sha256,
        reason, status, proposed_by, proposed_role, proposed_ip, proposed_ua, expires_at)
    values (gen_random_uuid(), 'pricing.publish', 'rate_card', v_card.id::text, v_paper, v_sha,
        v_reason, 'pending', p_actor, p_role, p_ip,
        left(coalesce(p_ua, ''), 300), now() + interval '7 days')
    returning id into v_id;
  exception when unique_violation then
    select a.id into v_open from platform_approvals a
     where a.action = 'pricing.publish' and a.target_kind = 'rate_card'
       and a.target_id = v_card.id::text and a.status = 'pending'
     order by a.created_at desc limit 1;
    return jsonb_build_object('ok', false, 'error', 'already_open', 'open_id', v_open,
      'message', 'A signature for this version is already open and waiting for a second seat.');
  end;

  update pricing_rate_cards
     set status = 'pending_signature', approval_id = v_id, updated_by = p_actor
   where id = v_card.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_rate_cards', v_card.id, 'pricing.publish_proposed',
    jsonb_build_object('status', v_card.status, 'approval_id', v_card.approval_id),
    jsonb_build_object('ref', v_card.ref, 'code', v_card.code, 'version', v_card.version,
      'currency', v_card.currency, 'lines', v_lines,
      'effective_from', v_card.effective_from::text, 'reason', v_reason,
      'payload_sha256', v_sha, 'approval_id', v_id, 'seat', v_name,
      'expires_at', to_char(now() + interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));

  return jsonb_build_object('ok', true, 'approval_id', v_id, 'action', 'pricing.publish',
    'target_kind', 'rate_card', 'target_id', v_card.id, 'ref', v_card.ref,
    'version', v_card.version, 'lines', v_lines, 'payload_sha256', v_sha,
    'card', platform_auth.pricing_card_detail(p_tenant, v_card.id));
end $$;

create or replace function platform_auth.refuse_pricing_publish(
  p_tenant uuid, p_card uuid, p_note text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_card pricing_rate_cards;
  v_a platform_approvals%rowtype;
  v_note text;
  v_dec jsonb;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can refuse a paper.');
  end if;
  v_note := trim(coalesce(p_note, ''));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_note',
      'message', 'Say why in 8-600 characters: it is the sentence the next version answers.');
  end if;
  select * into v_card from pricing_rate_cards
    where id = p_card and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no price list with that number in this book.');
  end if;
  if v_card.status <> 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'nothing_open', 'ref', v_card.ref,
      'status', v_card.status,
      'message', 'No signature is standing on ' || v_card.ref || '. Refusing a price the office never '
        || 'asked anyone to sign is not a thing a register can record.');
  end if;

  select * into v_a from platform_approvals where id = v_card.approval_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'approval_missing',
      'message', 'The paper ' || v_card.ref || ' points at is gone. Say so on the register, not here.');
  end if;
  if v_a.status = 'pending' then
    v_dec := platform_auth.decide_approval(v_a.id, 'reject', v_note, p_actor, p_role, p_ip,
      left(coalesce(p_ua, ''), 300));
    if v_dec ->> 'status' <> 'ok' then
      return jsonb_build_object('ok', false, 'error', 'refused_the_signature_first',
        'message', 'The signature was not answered: '
          || coalesce(v_dec ->> 'message', v_dec ->> 'status'),
        'approval_answer', v_dec);
    end if;
  elsif v_a.status not in ('lapsed','rejected') then
    return jsonb_build_object('ok', false, 'error', 'already_signed',
      'approval_status', v_a.status,
      'message', 'The signature on ' || v_card.ref || ' was released. A price that has been signed is '
        || 'spent on Approvals or withdrawn from this desk — it is not refused from here.');
  end if;

  update pricing_rate_cards
     set status = 'draft', refusals = refusals + 1, updated_by = p_actor
   where id = v_card.id;

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_rate_cards', v_card.id, 'pricing.publish_refused',
    jsonb_build_object('status', v_card.status, 'approval_id', v_a.id,
      'paper_sha256', v_a.payload_sha256),
    jsonb_build_object('ref', v_card.ref, 'code', v_card.code, 'version', v_card.version,
      'note', v_note, 'refusals', v_card.refusals + 1, 'seat', v_name,
      'proposed_by', (select u.full_name from users u where u.id = v_a.proposed_by)));

  return jsonb_build_object('ok', true, 'card', platform_auth.pricing_card_detail(p_tenant, v_card.id),
    'refusals', v_card.refusals + 1, 'approval_id', v_a.id);
end $$;

-- Spend the signature and put the price live.
--
-- Called inside the same transaction as `decide_approval` and `claim_approval`, in 121's order, and it
-- expects the approval already spent by the seat calling it. The bytes are rebuilt from the row before a
-- single column moves: a line edited in the seven days a paper waited is refused here rather than
-- published under a signature that never described it.
create or replace function platform_auth.apply_pricing_publish(
  p_approval_id uuid, p_actor_user_id uuid, p_actor_role text, p_actor_ip text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_a        platform_approvals%rowtype;
  v_card     pricing_rate_cards;
  v_old      pricing_rate_cards;
  v_lines    record;
  v_paper    jsonb;
  v_close_to date;
  v_to       date;
  v_seated   int;
begin
  select * into v_a from platform_approvals where id = p_approval_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no signature with that number.');
  end if;
  if v_a.action <> 'pricing.publish' or v_a.target_kind <> 'rate_card' then
    return jsonb_build_object('ok', false, 'error', 'not_a_price',
      'message', 'That signature is not a price publish.');
  end if;
  if v_a.status <> 'applied' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'approval_status', v_a.status,
      'message', 'The signature was not spent by this call.');
  end if;
  if v_a.decided_by <> p_actor_user_id then
    return jsonb_build_object('ok', false, 'error', 'unauthorised',
      'message', 'Only the seat that released a signature may spend it.');
  end if;

  select * into v_card from pricing_rate_cards
    where id = v_a.target_id::uuid for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'The price list this signature was cut on is no longer in the book.');
  end if;
  if v_card.status <> 'pending_signature' then
    return jsonb_build_object('ok', false, 'error', 'conflict', 'card_status', v_card.status,
      'ref', v_card.ref,
      'message', v_card.ref || ' is not waiting for that signature any more.');
  end if;

  v_paper := platform_auth.pricing_paper(v_card.id);
  if encode(extensions.digest(v_paper::text, 'sha256'), 'hex') <> v_a.payload_sha256 then
    return jsonb_build_object('ok', false, 'error', 'paper_moved', 'ref', v_card.ref,
      'signed_sha256', v_a.payload_sha256,
      'message', 'The figures on ' || v_card.ref || ' are not the ones that were signed. Nothing was '
        || 'published; the version has to be signed again.');
  end if;
  if v_card.effective_from is null then
    return jsonb_build_object('ok', false, 'error', 'no_start', 'ref', v_card.ref,
      'message', v_card.ref || ' lost its start date. A price with no day cannot go live.');
  end if;

  -- The window the previous version was valid for closes the day before the new one starts, and only
  -- then is the new one published — otherwise the overlap guard sees the collision it is being asked to
  -- create and refuses the publish it is standing for.
  --
  -- A version replaced on the very day it started keeps that one day: the register cannot store an end
  -- date before its own start, and the day is not ambiguous, because the row being closed here is
  -- already superseded and the resolver only reads published ones.
  v_close_to := v_card.effective_from - 1;
  v_seated := 0;
  for v_old in
    select * from pricing_rate_cards
     where tenant_id = v_card.tenant_id and code = v_card.code
       and status = 'published' and id <> v_card.id
       and effective_from <= v_card.effective_from
       and coalesce(effective_to, date 'infinity') >= v_card.effective_from
     order by effective_from desc
  loop
    v_to := greatest(least(coalesce(v_old.effective_to, date 'infinity'), v_close_to),
                     v_old.effective_from);

    update pricing_rate_cards
       set status = 'superseded', effective_to = v_to
     where id = v_old.id;

    insert into pricing_price_history (tenant_id, card_id, what, scope, old_value, new_value,
        currency, reason, actor_user_id, actor_role, approval_id)
    values (v_card.tenant_id, v_old.id, 'window', v_old.code || ' (version ' || v_old.version || ')',
        v_old.effective_to::text, v_to::text, v_old.currency,
        'Closed by ' || v_card.ref || ' version ' || v_card.version || ', which this signature published.',
        p_actor_user_id, p_actor_role, v_a.id);
    v_seated := v_seated + 1;
  end loop;

  update pricing_rate_cards
     set status = 'published', published_by = p_actor_user_id, published_at = now(),
         published_note = v_a.reason, updated_by = p_actor_user_id
   where id = v_card.id;

  -- One memory row per figure on the version that just went live. The old value is what the same scope
  -- cost on the version this one replaces — which is exactly the question 069 said nobody could answer.
  for v_lines in
    select l.id, l.scope_key, l.rate::text as rate, l.min_charge::text as min_charge,
           (select p.rate::text from pricing_rate_lines p
             join pricing_rate_cards pc on pc.id = p.card_id
            where pc.tenant_id = v_card.tenant_id and pc.code = v_card.code
              and pc.id <> v_card.id and p.scope_key = l.scope_key
              and pc.published_at is not null
            order by pc.version desc limit 1) as was,
           -- Clamped to the column's own ceiling: a route named on the corridors desk can be long, and a
           -- memory row that cannot be written because its sentence is 201 characters is no memory at all.
           left(trim(both ' ' from concat(coalesce(
             (select r.name from routes r where r.id = l.route_id), 'any route'), ' / ',
             coalesce(l.vehicle_class, 'any class'), ' / ',
             coalesce(l.container_type, 'any container'), ' / ', l.basis)), 200) as said
      from pricing_rate_lines l where l.card_id = v_card.id
      order by l.sort, l.scope_key
  loop
    insert into pricing_price_history (tenant_id, card_id, line_id, what, scope, old_value,
        new_value, currency, reason, actor_user_id, actor_role, approval_id)
    values (v_card.tenant_id, v_card.id, v_lines.id, 'rate', v_lines.said, v_lines.was,
        v_lines.rate, v_card.currency,
        case when v_lines.was is null
             then 'New scope on ' || v_card.ref || ' version ' || v_card.version || '.'
             else v_card.ref || ' version ' || v_card.version || ' moved this price from '
                  || v_lines.was || ' to ' || v_lines.rate || '.' end,
        p_actor_user_id, p_actor_role, v_a.id);

    if v_lines.min_charge is not null then
      insert into pricing_price_history (tenant_id, card_id, line_id, what, scope, old_value,
          new_value, currency, reason, actor_user_id, actor_role, approval_id)
      values (v_card.tenant_id, v_card.id, v_lines.id, 'min_charge', v_lines.said, null,
          v_lines.min_charge, v_card.currency,
          'Minimum charge carried by this scope on ' || v_card.ref || ' version '
            || v_card.version || '.',
          p_actor_user_id, p_actor_role, v_a.id);
    end if;
  end loop;

  insert into pricing_price_history (tenant_id, card_id, what, scope, old_value, new_value,
      currency, reason, actor_user_id, actor_role, approval_id)
  values (v_card.tenant_id, v_card.id, 'state', v_card.code || ' (version ' || v_card.version || ')',
      'pending_signature', 'published', v_card.currency,
      'Signed by ' || coalesce((select u.full_name from users u where u.id = v_a.decided_by),
                               'a second seat')
        || ' and effective from ' || v_card.effective_from::text || '.',
      p_actor_user_id, p_actor_role, v_a.id);

  perform platform_auth.money_audit(v_card.tenant_id, p_actor_user_id, p_actor_role, p_actor_ip, null,
    'pricing_rate_cards', v_card.id, 'pricing.published',
    jsonb_build_object('status', v_card.status, 'approval_id', v_card.approval_id),
    jsonb_build_object('ref', v_card.ref, 'code', v_card.code, 'version', v_card.version,
      'currency', v_card.currency, 'effective_from', v_card.effective_from::text,
      'superseded_versions', v_seated, 'payload_sha256', v_a.payload_sha256,
      'approval_id', v_a.id,
      'signed_by', (select u.full_name from users u where u.id = v_a.decided_by),
      'proposed_by', (select u.full_name from users u where u.id = v_a.proposed_by)));

  return jsonb_build_object('ok', true, 'card_id', v_card.id, 'ref', v_card.ref,
    'code', v_card.code, 'version', v_card.version, 'currency', v_card.currency,
    'effective_from', v_card.effective_from::text, 'superseded_versions', v_seated,
    'approval_id', v_a.id, 'published_by', p_actor_user_id,
    'card', platform_auth.pricing_card_detail(v_card.tenant_id, v_card.id));
end $$;

-- ============================================================
-- 10. the stop
-- ============================================================

-- One seat, dated forward, fully explained, never a delete: see the header for why stopping a price is
-- not the act that needs a second hand on it.
create or replace function platform_auth.withdraw_pricing_card(
  p_tenant uuid, p_card uuid, p_effective_to date, p_reason text,
  p_actor uuid, p_role text, p_ip text, p_ua text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_card pricing_rate_cards;
  v_reason text;
  v_to date;
begin
  v_name := platform_auth.approval_seat(p_actor);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_a_seat',
      'message', 'Only a live platform seat can stop a price.');
  end if;
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('ok', false, 'error', 'bad_reason',
      'message', 'Say in 8-600 characters why the price stops: this is the sentence a customer is '
        || 'answered with.');
  end if;
  select * into v_card from pricing_rate_cards
    where id = p_card and tenant_id = p_tenant for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'There is no price list with that number in this book.');
  end if;
  if v_card.status <> 'published' then
    return jsonb_build_object('ok', false, 'error', 'not_live', 'ref', v_card.ref,
      'status', v_card.status,
      'message', v_card.ref || ' is ' || v_card.status || '. There is nothing to stop.');
  end if;
  v_to := coalesce(p_effective_to, current_date);
  if v_to < current_date then
    return jsonb_build_object('ok', false, 'error', 'rewriting_history', 'asked', v_to::text,
      'message', 'A price stops today or later. Stopping it before a day that has already passed would '
        || 'un-quote jobs the office may have billed under ' || v_card.ref || '.');
  end if;
  if v_card.effective_from > v_to then
    return jsonb_build_object('ok', false, 'error', 'empty_window', 'ref', v_card.ref,
      'message', v_card.ref || ' starts ' || v_card.effective_from::text || ', after the day you are '
        || 'stopping it on. Supersede it with the version that replaces it instead.');
  end if;

  update pricing_rate_cards
     set status = 'withdrawn', effective_to = v_to, withdrawn_by = p_actor, withdrawn_at = now(),
         withdrawn_reason = v_reason, updated_by = p_actor
   where id = v_card.id;

  insert into pricing_price_history (tenant_id, card_id, what, scope, old_value, new_value, currency,
      reason, actor_user_id, actor_role)
  values (p_tenant, v_card.id, 'window', v_card.code || ' (version ' || v_card.version || ')',
      v_card.effective_to::text, v_to::text, v_card.currency, v_reason, p_actor, p_role);
  insert into pricing_price_history (tenant_id, card_id, what, scope, old_value, new_value, currency,
      reason, actor_user_id, actor_role)
  values (p_tenant, v_card.id, 'state', v_card.code || ' (version ' || v_card.version || ')',
      'published', 'withdrawn', v_card.currency, v_reason, p_actor, p_role);

  perform platform_auth.money_audit(p_tenant, p_actor, p_role, p_ip, p_ua,
    'pricing_rate_cards', v_card.id, 'pricing.card_withdrawn',
    jsonb_build_object('status', v_card.status, 'effective_to', v_card.effective_to::text),
    jsonb_build_object('ref', v_card.ref, 'code', v_card.code, 'version', v_card.version,
      'effective_to', v_to::text, 'reason', v_reason, 'seat', v_name));

  return platform_auth.pricing_card_detail(p_tenant, v_card.id);
end $$;

-- ============================================================
-- 11. the answer
-- ============================================================

-- What one scope costs on one day. Specificity decides it: a line that names the route beats one that
-- names only the class, and so on down to the wildcard — and the tie-break is written out so two rows
-- that are equally specific cannot make the answer depend on which one the planner reached first.
--
-- The basis is part of the question, because one scope is legitimately priced more than once: a corridor
-- carries a per-kilometre rate and a flat handling charge on the same card, and a seat that asks "what
-- does a tonne cost" must not be handed the handling fee because it sorted first. Asked with no basis,
-- the door answers the most specific line and names the others that also stand, so the desk can say what
-- it left out instead of looking like it knew.
create or replace function platform_auth.pricing_rate_in_force(
  p_tenant uuid, p_day date, p_code text, p_route uuid, p_vehicle_class text, p_container text,
  p_basis text
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_day date;
  v_code text;
  v_class text;
  v_cont text;
  v_basis text;
  v_all jsonb;
  v jsonb;
begin
  v_day := coalesce(p_day, current_date);
  v_code := nullif(upper(trim(coalesce(p_code, ''))), '');
  v_class := nullif(lower(trim(coalesce(p_vehicle_class, ''))), '');
  v_cont := nullif(lower(trim(coalesce(p_container, ''))), '');
  v_basis := nullif(lower(trim(coalesce(p_basis, ''))), '');
  if v_basis is not null and not exists (
       select 1 from pricing_dimensions d where d.kind = 'basis' and d.key = v_basis) then
    return jsonb_build_object('ok', false, 'error', 'bad_basis', 'asked', v_basis,
      'message', 'This register does not price on a ' || v_basis || ' basis. It knows: '
        || (select string_agg(d.key, ', ' order by d.sort) from pricing_dimensions d
             where d.kind = 'basis') || '.');
  end if;
  if p_route is not null and not exists (
       select 1 from routes r where r.id = p_route and r.tenant_id = p_tenant
         and r.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'route_not_in_book', 'route', p_route,
      'message', 'That route is not a corridor of this book, so this book has no price along it.');
  end if;

  -- Every line that stands for this scope on this day, whatever it is priced by. One pass, so the
  -- refusal and the answer are counted from the same window and cannot disagree.
  select coalesce(jsonb_agg(jsonb_build_object(
           'basis', l.basis, 'specificity', s.v_score, 'rate', l.rate::text, 'ref', c.ref,
           'version', c.version) order by l.basis), '[]'::jsonb)
    into v_all
  from pricing_rate_lines l
  join pricing_rate_cards c on c.id = l.card_id
  cross join lateral (
    select ((case when l.route_id is not null then 1 else 0 end)
          + (case when l.vehicle_class is not null then 1 else 0 end)
          + (case when l.container_type is not null then 1 else 0 end))::int as v_score
  ) s
  where c.tenant_id = p_tenant
    and c.status = 'published'
    and c.effective_from <= v_day
    and coalesce(c.effective_to, date 'infinity') >= v_day
    and (v_code is null or c.code = v_code)
    and (l.route_id is null or l.route_id = p_route)
    and (l.vehicle_class is null or l.vehicle_class = v_class)
    and (l.container_type is null or l.container_type = v_cont);

  select jsonb_build_object(
    'id', l.id, 'card_id', c.id, 'ref', c.ref, 'code', c.code, 'label', c.label,
    'version', c.version, 'currency', c.currency,
    'effective_from', c.effective_from::text, 'effective_to', c.effective_to::text,
    'scope_key', l.scope_key, 'route_id', l.route_id,
    'route', (select r.name from routes r where r.id = l.route_id),
    'distance_km', (select r.distance_km from routes r where r.id = l.route_id),
    'vehicle_class', l.vehicle_class, 'container_type', l.container_type,
    'basis', l.basis, 'basis_label', (select d.label from pricing_dimensions d
                                       where d.kind = 'basis' and d.key = l.basis),
    'needs', (select d.needs from pricing_dimensions d
               where d.kind = 'basis' and d.key = l.basis),
    'rate', l.rate::text, 'min_charge', l.min_charge::text,
    'specificity', s.v_score
  ) into v
  from pricing_rate_lines l
  join pricing_rate_cards c on c.id = l.card_id
  cross join lateral (
    select ((case when l.route_id is not null then 1 else 0 end)
          + (case when l.vehicle_class is not null then 1 else 0 end)
          + (case when l.container_type is not null then 1 else 0 end))::int as v_score
  ) s
  where c.tenant_id = p_tenant
    and c.status = 'published'
    and c.effective_from <= v_day
    and coalesce(c.effective_to, date 'infinity') >= v_day
    and (v_code is null or c.code = v_code)
    and (l.route_id is null or l.route_id = p_route)
    and (l.vehicle_class is null or l.vehicle_class = v_class)
    and (l.container_type is null or l.container_type = v_cont)
    and (v_basis is null or l.basis = v_basis)
  order by s.v_score desc, c.version desc, c.effective_from desc, c.code, l.basis, l.scope_key
  limit 1;

  if v is null then
    return jsonb_build_object('ok', false, 'error', 'no_price', 'day', v_day::text,
      'list', coalesce(v_code, 'any published list in this book'),
      'route', p_route, 'vehicle_class', v_class, 'container_type', v_cont,
      'basis', v_basis, 'priced_that_day', v_all,
      'message', 'Nothing in this book prices '
        || coalesce((select r.name from routes r where r.id = p_route), 'that job')
        || (case when v_basis is null then '' else ' on a ' || v_basis || ' basis' end)
        || ' on ' || to_char(v_day, 'YYYY-MM-DD') || '. The price is not zero — it has not been set.'
        || (case when jsonb_array_length(v_all) > 0
              then ' What does stand there is: '
                || (select string_agg((x ->> 'basis') || ' at ' || (x ->> 'rate')
                        || ' (' || (x ->> 'ref') || ' v' || (x ->> 'version') || ')', ', ')
                      from jsonb_array_elements(v_all) x) || '.'
              else '' end));
  end if;
  return jsonb_build_object('ok', true, 'price', v, 'asked_on', v_day::text,
    'other_bases', (select coalesce(jsonb_agg(x), '[]'::jsonb)
                      from jsonb_array_elements(v_all) x
                     where x ->> 'basis' <> v ->> 'basis'));
end $$;

-- The simulator. One call, the whole arithmetic, and the working printed beside it, because a figure a
-- clerk cannot reproduce is a figure a customer cannot be argued with.
create or replace function platform_auth.price_a_freight(
  p_tenant uuid, p_day date, p_code text, p_route uuid, p_vehicle_class text, p_container text,
  p_basis text, p_tonnes numeric, p_teu int, p_cbm numeric, p_days int
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_hit jsonb;
  v_basis text;
  v_rate numeric;
  v_min numeric;
  v_quantity numeric;
  v_distance int;
  v_amount numeric;
  v_label text;
begin
  v_hit := platform_auth.pricing_rate_in_force(p_tenant, p_day, p_code, p_route,
    p_vehicle_class, p_container, p_basis);
  if v_hit ->> 'ok' <> 'true' then
    return v_hit;
  end if;
  v_basis := v_hit #>> '{price,basis}';
  v_rate := (v_hit #>> '{price,rate}')::numeric;
  v_min := nullif(v_hit #>> '{price,min_charge}', '')::numeric;
  v_label := coalesce(v_hit #>> '{price,route}', 'any route');

  if v_basis = 'per_km' then
    v_distance := (select r.distance_km from routes r where r.id = p_route);
    if v_distance is null then
      return jsonb_build_object('ok', false, 'error', 'no_distance', 'route', p_route,
        'message', case when p_route is null
          then 'That price is per kilometre and no corridor was named, so there is nothing to multiply. '
            || 'Say which route the job runs.'
          else 'That price is per kilometre and the route has no distance on file, so there is '
            || 'nothing to multiply. File the corridor with its distance on the pricing desk first.' end);
    end if;
    v_quantity := v_distance;
    v_label := v_label || ' × ' || v_distance || ' km';
  elsif v_basis = 'per_tonne' then
    if p_tonnes is null or p_tonnes <= 0 then
      return jsonb_build_object('ok', false, 'error', 'no_tonnes',
        'message', 'A per-tonne price needs the tonnage of the job.');
    end if;
    v_quantity := p_tonnes;
    v_label := v_label || ' × ' || trim(to_char(p_tonnes, 'FM999999990.999')) || ' t';
  elsif v_basis = 'per_teu' then
    if p_teu is null or p_teu <= 0 then
      return jsonb_build_object('ok', false, 'error', 'no_teu',
        'message', 'A per-container price needs how many containers the job carries.');
    end if;
    v_quantity := p_teu;
    v_label := v_label || ' × ' || p_teu || ' TEU';
  elsif v_basis = 'per_cbm' then
    if p_cbm is null or p_cbm <= 0 then
      return jsonb_build_object('ok', false, 'error', 'no_cbm',
        'message', 'A per-cubic-metre price needs the volume of the job.');
    end if;
    v_quantity := p_cbm;
    v_label := v_label || ' × ' || trim(to_char(p_cbm, 'FM999999990.999')) || ' m³';
  elsif v_basis = 'per_day' then
    if p_days is null or p_days <= 0 then
      return jsonb_build_object('ok', false, 'error', 'no_days',
        'message', 'A per-day price needs how many days the job runs.');
    end if;
    v_quantity := p_days;
    v_label := v_label || ' × ' || p_days || ' days';
  elsif v_basis in ('per_trip','flat') then
    v_quantity := 1;
    v_label := v_label || case when v_basis = 'per_trip' then ' — one trip' else ' — flat' end;
  else
    return jsonb_build_object('ok', false, 'error', 'unknown_basis', 'basis', v_basis,
      'message', 'This register does not know how to multiply a ' || v_basis || ' price.');
  end if;

  v_amount := v_rate * v_quantity;
  if v_min is not null and v_amount < v_min then
    v_amount := v_min;
  end if;

  return jsonb_build_object('ok', true,
    -- Printed wide: a rate is capped below 1e10, but a quantity is whatever the job carries, and a figure
    -- that overflows a narrowed cast would answer a quotation with a database error instead of a number.
    'amount', trim(to_char(round(v_amount, 2), 'FM99999999999999999990.00')),
    'currency', v_hit #>> '{price,currency}',
    'basis', v_basis, 'rate', v_rate::text, 'quantity', v_quantity,
    'floor_applied', (v_min is not null and (v_rate * v_quantity) < v_min),
    'min_charge', v_min::text,
    'working', v_label || ' at ' || trim(to_char(v_rate, 'FM999999999990.0000')) || ' '
      || (v_hit #>> '{price,basis_label}')
      || case when v_min is not null and (v_rate * v_quantity) < v_min
              then ' — held up to the minimum of '
                   || trim(to_char(v_min, 'FM999999999990.00'))
              else '' end,
    'card', jsonb_build_object('ref', v_hit #>> '{price,ref}',
                              'code', v_hit #>> '{price,code}',
                              'version', (v_hit #>> '{price,version}')::int,
                              'effective_from', v_hit #>> '{price,effective_from}',
                              'effective_to', v_hit #>> '{price,effective_to}'),
    'asked_on', v_hit ->> 'asked_on',
    -- What the same scope also costs on that day. A clerk who is told one figure and never told that a
    -- handling charge stands beside it is a clerk who under-quotes.
    'other_bases', coalesce(v_hit -> 'other_bases', '[]'::jsonb));
end $$;

-- ============================================================
-- 12. the duties
-- ============================================================

-- Reading a price, writing a draft, and putting a price live are three authorities. `.publish` is kept
-- away from `.manage` on purpose, the way 135 kept `.recon` away from `.post`: a seat that can edit the
-- figures and sign them alone is a seat that has not needed a second person since the day the register
-- opened. Withdrawing is under `.manage`, because it is the act that stops a wrong price from being
-- quoted an hour longer.
insert into permissions (key, description) values
  ('control.pricing.view',
   'Control - Read the price lists, their versions, their memory and what a job would cost'),
  ('control.pricing.manage',
   'Control - Open and edit a draft price list, put figures on it, clone a version and stop a price'),
  ('control.pricing.publish',
   'Control - Put a price list up for a second seat and spend the signature that publishes it')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.pricing.view'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','billing_admin','finance_officer','platform_analyst','auditor')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.pricing.manage'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','billing_admin')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.pricing.publish'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','billing_admin')
on conflict do nothing;

-- ============================================================
-- 13. grants on the doors
-- ============================================================

-- A trigger body is fired, never called (110, 121, 125, 133). `pricing_paper` and `pricing_sha256` are
-- revoked from the app role as well: they are the canonical bytes a signature is cut on, and a route that
-- could call them directly could hash a payload it never proposed.
revoke all on function
  platform_auth.pricing_history_is_kept(),
  platform_auth.pricing_card_is_kept(),
  platform_auth.pricing_card_header_is_immutable(),
  platform_auth.pricing_one_price_per_day(),
  platform_auth.pricing_signed_price_is_not_edited(),
  platform_auth.pricing_line_names_its_own_book(),
  platform_auth.pricing_paper(uuid),
  platform_auth.pricing_sha256(uuid)
from public, anon, authenticated, service_role, app_runtime;

grant execute on function
  platform_auth.pricing_board(uuid, text, text, text, int, int),
  platform_auth.pricing_card_detail(uuid, uuid),
  platform_auth.pricing_history(uuid, uuid, int, int),
  platform_auth.pricing_corridors(uuid, text, int, int),
  platform_auth.file_pricing_corridor(uuid, text, text, text, numeric, uuid, text, text, text),
  platform_auth.open_pricing_card(uuid, text, text, text, date, text, uuid, text, text, text),
  platform_auth.edit_pricing_card(uuid, uuid, text, text, date, text, uuid, text, text, text),
  platform_auth.set_pricing_line(uuid, uuid, uuid, text, text, text, numeric, numeric,
    uuid, text, text, text),
  platform_auth.remove_pricing_line(uuid, uuid, uuid, text, text, text),
  platform_auth.discard_pricing_card(uuid, uuid, text, uuid, text, text, text),
  platform_auth.clone_pricing_card(uuid, uuid, date, text, uuid, text, text, text),
  platform_auth.propose_pricing_publish(uuid, uuid, text, uuid, text, text, text),
  platform_auth.refuse_pricing_publish(uuid, uuid, text, uuid, text, text, text),
  platform_auth.apply_pricing_publish(uuid, uuid, text, text),
  platform_auth.withdraw_pricing_card(uuid, uuid, date, text, uuid, text, text, text),
  platform_auth.pricing_rate_in_force(uuid, date, text, uuid, text, text, text),
  platform_auth.price_a_freight(uuid, date, text, uuid, text, text, text, numeric, int, numeric, int)
to app_runtime;

-- `create or replace function` hands EXECUTE back to PUBLIC, so every door is revoked after it is
-- granted — the sweep 114 lists and every stage since has honoured.
revoke all on function
  platform_auth.pricing_board(uuid, text, text, text, int, int),
  platform_auth.pricing_card_detail(uuid, uuid),
  platform_auth.pricing_history(uuid, uuid, int, int),
  platform_auth.pricing_corridors(uuid, text, int, int),
  platform_auth.file_pricing_corridor(uuid, text, text, text, numeric, uuid, text, text, text),
  platform_auth.open_pricing_card(uuid, text, text, text, date, text, uuid, text, text, text),
  platform_auth.edit_pricing_card(uuid, uuid, text, text, date, text, uuid, text, text, text),
  platform_auth.set_pricing_line(uuid, uuid, uuid, text, text, text, numeric, numeric,
    uuid, text, text, text),
  platform_auth.remove_pricing_line(uuid, uuid, uuid, text, text, text),
  platform_auth.discard_pricing_card(uuid, uuid, text, uuid, text, text, text),
  platform_auth.clone_pricing_card(uuid, uuid, date, text, uuid, text, text, text),
  platform_auth.propose_pricing_publish(uuid, uuid, text, uuid, text, text, text),
  platform_auth.refuse_pricing_publish(uuid, uuid, text, uuid, text, text, text),
  platform_auth.apply_pricing_publish(uuid, uuid, text, text),
  platform_auth.withdraw_pricing_card(uuid, uuid, date, text, uuid, text, text, text),
  platform_auth.pricing_rate_in_force(uuid, date, text, uuid, text, text, text),
  platform_auth.price_a_freight(uuid, date, text, uuid, text, text, text, numeric, int, numeric, int)
from public, anon, authenticated, service_role;

-- The number a card's ref is minted from. 134 says it of the three refs it cut and 135 of the run
-- number: a client role that can take a number without writing a row leaves the office a hole in its own
-- numbering to explain, and a ref that skips is a ref somebody has to account for at the desk. Nothing
-- outside the doors in section 8 asks for a number, and those doors run as their own owner, so the app
-- role is revoked along with the rest.
revoke all on sequence pricing_card_number_seq
  from public, anon, authenticated, app_runtime, service_role;

-- ============================================================
-- 14. say what this leaves the platform in
-- ============================================================

do $$ declare
  v_tables int;
  v_unprotected int;
  v_readers int;
  v_writers int;
  v_words int;
  v_leaks int;
  v_trigger_grants int;
  v_seq_holders int;
  v_live int;
begin
  select count(*)::int into v_tables from pg_tables
   where schemaname = 'public'
     and tablename in ('pricing_dimensions','pricing_rate_cards','pricing_rate_lines',
                       'pricing_price_history');
  if v_tables <> 4 then
    raise exception '140: the price register is % of its four tables', v_tables;
  end if;

  select count(*)::int into v_unprotected from pg_tables t
   where t.schemaname = 'public'
     and t.tablename in ('pricing_rate_cards','pricing_rate_lines','pricing_price_history',
                         'pricing_dimensions')
     and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where c.relname = t.tablename and n.nspname = 'public' and c.relrowsecurity);
  if v_unprotected <> 0 then
    raise exception '140: % of the price registers can be read without a book being named',
      v_unprotected;
  end if;

  select count(distinct c.relname)::int into v_readers
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join aclexplode(c.relacl) a
   where n.nspname = 'public'
     and c.relname in ('pricing_dimensions','pricing_rate_cards','pricing_rate_lines',
                       'pricing_price_history')
     and a.grantee = (select oid from pg_roles where rolname = 'app_runtime')
     and a.privilege_type = 'SELECT';
  if v_readers <> 4 then
    raise exception '140: the app role must read all four price registers; it reads % of them',
      v_readers;
  end if;

  select count(*)::int into v_writers
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join aclexplode(c.relacl) a
   where n.nspname = 'public'
     and c.relname in ('pricing_dimensions','pricing_rate_cards','pricing_rate_lines',
                       'pricing_price_history')
     and a.grantee = (select oid from pg_roles where rolname = 'app_runtime')
     and a.privilege_type in ('INSERT','UPDATE','DELETE');
  if v_writers <> 0 then
    raise exception '140: the app role writes prices through a door and holds % direct write grant(s)',
      v_writers;
  end if;

  select count(*)::int into v_words from pricing_dimensions;
  if v_words <> 21 then
    raise exception '140: the price vocabulary is 10 classes, 4 containers and 7 bases — it holds % '
      'words, so a line could be keyed on a word with no author', v_words;
  end if;
  if exists (select 1 from pricing_dimensions d
              where d.kind = 'basis'
                and d.needs not in ('none','distance_km','tonnes','teu','cbm','days','one')) then
    raise exception '140: a basis in the vocabulary asks for a quantity the simulator cannot be given';
  end if;

  select coalesce(count(*)::int, 0) into v_leaks
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     cross join aclexplode(p.proacl) a
   where n.nspname = 'platform_auth'
     and p.proname in ('pricing_board','pricing_card_detail','pricing_history','open_pricing_card',
                       'edit_pricing_card','set_pricing_line','remove_pricing_line',
                       'discard_pricing_card','clone_pricing_card','propose_pricing_publish',
                       'refuse_pricing_publish','apply_pricing_publish','withdraw_pricing_card',
                       'pricing_rate_in_force','price_a_freight')
     and (a.grantee = 0
          or a.grantee = any (select oid from pg_roles
                               where rolname in ('anon','authenticated','service_role')));
  if v_leaks <> 0 then
    raise exception '140: % of the price doors are still grantable to a client role or to PUBLIC',
      v_leaks;
  end if;

  select coalesce(count(*)::int, 0) into v_trigger_grants
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     cross join aclexplode(p.proacl) a
   where n.nspname = 'platform_auth'
     and p.proname in ('pricing_history_is_kept','pricing_card_is_kept',
                       'pricing_card_header_is_immutable','pricing_one_price_per_day',
                       'pricing_signed_price_is_not_edited','pricing_line_names_its_own_book',
                       'pricing_paper','pricing_sha256')
     and (a.grantee = 0 or a.grantee = (select oid from pg_roles where rolname = 'app_runtime'));
  if v_trigger_grants <> 0 then
    raise exception '140: a trigger body is fired, never called, and % of 140''s guards still answer '
      'a caller', v_trigger_grants;
  end if;

  if not exists (select 1 from pg_roles r
                  where r.rolname = 'app_runtime'
                    and has_function_privilege(r.oid,
                          'platform_auth.apply_pricing_publish(uuid, uuid, text, text)', 'EXECUTE')) then
    raise exception '140: the door that spends a publish signature is not executable by the app role';
  end if;

  if not exists (select 1 from permissions where key = 'control.pricing.publish') then
    raise exception '140: a price can be published without a duty to ask for it';
  end if;

  -- The numbering is only worth keeping if nobody outside the doors can spend it. An owner needs no
  -- grant of its own — and once a grant has been revoked Postgres still writes the owner's own three
  -- letters into the list — so the entry counted here is any grantee that is not the owner.
  select coalesce(count(*)::int, 0) into v_seq_holders
    from pg_class cl cross join aclexplode(cl.relacl) a
   where cl.relname = 'pricing_card_number_seq' and cl.relkind = 'S'
     and a.grantee <> cl.relowner;
  if v_seq_holders <> 0 then
    raise exception '140: % role(s) besides its owner can take a card number without writing a card, so '
      'the office''s numbering can be burned from outside a door', v_seq_holders;
  end if;

  select count(*)::int into v_live from pricing_rate_cards where status = 'published';
  raise notice '140: the price register is open — % words in the vocabulary, % live price list(s), and '
    'a version that was signed cannot be edited, deleted, or overlapped by anybody',
    v_words, v_live;
end $$;

commit;
