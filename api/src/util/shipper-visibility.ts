/**
 * Shipper portal visibility. A file is visible to a portal user when their
 * active account's client name matches the file's consignee or consignor
 * (case-insensitive, trimmed), or when the file has been shared with that
 * account explicitly. Aliases are fixed: cargo_shipments must be `cs`,
 * freight_invoices `i`, params $1 = tenant id, $2 = portal user id.
 */
export const SHIPMENT_VISIBLE_SQL = `exists (
    select 1 from shipper_accounts sa
    join clients c on c.id = sa.client_id and c.deleted_at is null
    where sa.tenant_id = $1 and sa.user_id = $2
      and sa.status = 'active' and sa.deleted_at is null
      and (lower(trim(cs.consignee_name)) = lower(trim(c.name))
        or lower(trim(cs.consignor_name)) = lower(trim(c.name)))
  )
  or exists (
    select 1 from shipper_file_shares sfs
    join shipper_accounts sa2 on sa2.id = sfs.shipper_account_id
    where sfs.tenant_id = $1 and sfs.shipment_id = cs.id and sfs.deleted_at is null
      and sa2.user_id = $2 and sa2.status = 'active' and sa2.deleted_at is null
  )`;

export const INVOICE_VISIBLE_SQL = `exists (
    select 1 from shipper_accounts sa
    join clients c on c.id = sa.client_id and c.deleted_at is null
    where sa.tenant_id = $1 and sa.user_id = $2
      and sa.status = 'active' and sa.deleted_at is null
      and lower(trim(i.customer_name)) = lower(trim(c.name))
  )`;
