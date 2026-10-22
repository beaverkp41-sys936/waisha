-- 124 — the hours trigger reads its weekday keys with a query, not an array subtraction.
--
-- 123 wrote `v_keys := v_keys - array['mon',…]` to find keys nobody recognises. Postgres has no
-- `-` operator for two arrays at all — `array_remove()` is the function, and it takes one value,
-- not a list — and plpgsql does not resolve an operator until the body runs, so the mistake was
-- invisible at creation time. It raised on the first INSERT into platform_departments, which is
-- every desk the office creates. The trigger is meant to refuse a malformed week; instead it
-- refused every week, including the correct ones.
--
-- The fix is the same test asked of SQL in the first place: aggregate only the keys that are not
-- weekdays. No operator, no intermediate array, and the message still names the offenders.

create or replace function platform_auth.department_hours_are_readable()
returns trigger language plpgsql set search_path = public as $$ declare
  v_key text;
  v_day jsonb;
  v_open text;
  v_close text;
  v_bad text[];
begin
  if jsonb_typeof(new.business_hours) <> 'object' then
    raise exception 'platform_departments: business_hours must be an object keyed by weekday'
      using errcode = '22023';
  end if;
  -- array_agg over jsonb_object_keys is set-returning in a select: the only legal way to get
  -- the key list out of a jsonb value inside plpgsql. The not-in filter belongs in that query,
  -- because an array minus an array is not a thing this server can do.
  select coalesce(array_agg(k), '{}'::text[]) into v_bad
    from jsonb_object_keys(new.business_hours) as k
   where k <> all (array['mon','tue','wed','thu','fri','sat','sun']);
  if coalesce(array_length(v_bad, 1), 0) > 0 then
    raise exception 'platform_departments: business_hours has day(s) nobody recognises: %',
      array_to_string(v_bad, ', ')
      using hint = 'Use mon, tue, wed, thu, fri, sat, sun; omit a day or set it to null if the desk is shut.',
             errcode = '22023';
  end if;
  for v_key in select unnest(array['mon','tue','wed','thu','fri','sat','sun']) loop
    v_day := new.business_hours -> v_key;
    if v_day is null or jsonb_typeof(v_day) = 'null' then continue; end if;  -- closed day
    if jsonb_typeof(v_day) <> 'object' then
      raise exception 'platform_departments: % must be an object with open and close', v_key
        using errcode = '22023';
    end if;
    v_open := v_day ->> 'open';
    v_close := v_day ->> 'close';
    if v_open is null or v_close is null
       or v_open !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or v_close !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'platform_departments: % is not a pair of HH:MM times', v_key
        using errcode = '22023';
    end if;
    if v_open::time >= v_close::time then
      raise exception 'platform_departments: % closes before or at the minute it opens', v_key
        using errcode = '22023';
    end if;
  end loop;
  return new;
end $$;

-- `create or replace` keeps the_acl it was granted, but the invariant is stated rather than
-- assumed: a trigger body is fired, never called, so nobody holds EXECUTE on it.
revoke all on function platform_auth.department_hours_are_readable()
  from public, anon, authenticated, service_role, app_runtime;
