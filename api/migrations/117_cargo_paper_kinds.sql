-- 117: the paper a clearing desk actually holds, named on the column that stores it.
--
-- The office asked for seven document types on a cargo file: Prevision, Delivery Note, TDRN,
-- invoices, and the three warehouse slips — receipt, entry, exit.
--
-- Two of the seven names were already in the column: `delivery_note` (034) and `invoice`. A
-- second word for the same paper would leave a clerk choosing between two kinds for one sheet
-- and the register printing two labels for the same thing, so this adds the five that do not
-- exist and the desks offer all seven.
--
-- The list is copied from `pg_constraint`, not from a previous migration file — the rule 109
-- wrote down. A CHECK that quietly drops a value strands the rows already filed under it, and
-- `add constraint` validates against them.
--
-- `warehouse_entry` / `warehouse_exit` are the slips of the inventory register asked for next:
-- goods in, goods out. `warehouse_receipt` is the store's own acknowledgement that it holds the
-- cargo. All three are kinds of *paper*, not a stock ledger — a file carries the slips whether
-- or not anybody has counted the pallets they describe.
--
-- `prevision` is the office's estimate of what the file will cost before the bill lands.
-- `tdrn` keeps the acronym the desk uses: it is the name on the paper, and expanding it here
-- would put a guess of ours where their word should stand.

alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check
  check (kind in ('logo','avatar','licence','insurance','inspection','road_licence',
                  'delivery_note','invoice','bill_of_lading','packing_list','contract',
                  'other','attachment','receipt','shipper_upload','arrival_notice',
                  'delivery_order','declaration','assessment','release_note','permit',
                  'pod','handover','proforma','attendance_proof',
                  'prevision','tdrn','warehouse_receipt','warehouse_entry','warehouse_exit'));
