-- 100: the command center gets a door into the content it was always meant to hold.
--
-- 001 created content_blocks (key, locale, value, updated_by, updated_at) and 002 seeded
-- the footer and the sign-in microcopy through the seed file. Then it granted the runtime
-- role SELECT and nothing else — so the table has been readable by the platform for the
-- whole build and unwritable by it ever since. The control panel has carried the duty
-- control.content.manage since 005 ("Edit platform content and templates"), granted to
-- super_admin, and no route has ever checked it and no desk has ever offered it: the duty
-- is a promise the software never kept.
--
-- This closes that loop for the copy a real person needs to change without a deploy — the
-- footer brand line, the support address and numbers, the hours, the links — and does it
-- the way 047 did announcements: a global table with no tenant column, because this text
-- belongs to the platform and not to any company, so the tenant bind that every other
-- statement in this API carries has nothing to bind here. The gate is the duty key, and
-- writeAudit records every change with the seat that made it.
--
-- INSERT and UPDATE only, never DELETE. Removing a line of copy is setting it back to the
-- empty string, which is what the renderers already treat as "do not show this". Keeping
-- DELETE out means a typo cannot take a row that the seed file is the only copy of.
begin;

grant insert, update on content_blocks to app_runtime;

-- The fields the footer can carry. Seeded empty in both locales rather than with invented
-- contact details: the desk shows the field, the office types what is true, and an empty
-- value renders nothing. The two existing blocks are left exactly as they are so nothing
-- on a live page moves when this runs.
insert into content_blocks (key, locale, value)
select b.key, l.locale, ''
  from (values
    ('footer.address'),      -- postal or street line, free text
    ('footer.hours'),        -- when the office answers, free text
    ('footer.whatsapp'),     -- one number, +E.164
    ('footer.copyright'),    -- the legal line under the bar
    ('footer.links'),        -- JSON array of {label, href}, shown as the link row
    ('footer.social')        -- JSON array of {network, handle, href}
  ) b(key)
 cross join (values ('en'), ('sw')) l(locale)
on conflict (key, locale) do nothing;

-- Say what is now editable, so the next reader can tell which keys the desk is expected to
-- know about without opening the route file.
do $$
declare
  v_keys int;
  v_rows int;
begin
  select count(distinct key)::int into v_keys from content_blocks;
  select count(*)::int into v_rows from content_blocks;
  raise notice '100: content_blocks is writable by the runtime — % key(s), % row(s), footer copy plus sign-in microcopy', v_keys, v_rows;
end $$;

commit;
