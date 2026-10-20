-- 105: the brand line leaves the footer and takes the one door everybody actually uses.
--
-- 100 made the footer's words editable from the command center, and the first thing the bar
-- said was the marketing line — "powered by T ENGO AEGIS". A footer exists to be read out
-- loud to a caller: the address, the numbers, the hours. A publisher's imprint in front of
-- them is the wrong word in the wrong place, so it moves to the foot of the sign-in card,
-- which is the page every person sees before they see anything else and the only page the
-- platform has that is about the platform rather than about a company's work.
--
-- The key changes with it. src/content/fields.ts is the single registry both the desk and
-- the renderers read, so a block named `footer.*` that nothing in a footer shows would be
-- exactly the lie that file's header comment warns about. The value is carried over first,
-- then the old rows go: DELETE is withheld from app_runtime (100) and this runs as the
-- owner, which is the only place a key is allowed to be retired.
begin;

insert into content_blocks (key, locale, value)
select 'login.brand', l.locale,
       coalesce(b.value, 'T ENGO AEGIS')
  from (values ('en'), ('sw')) l(locale)
  left join content_blocks b on b.key = 'footer.brand' and b.locale = l.locale
on conflict (key, locale) do nothing;

delete from content_blocks where key = 'footer.brand';

do $$
declare
  v_brand text;
  v_left int;
begin
  select value into v_brand from content_blocks where key = 'login.brand' and locale = 'en';
  select count(*)::int into v_left from content_blocks where key = 'footer.brand';
  if v_left > 0 then
    raise exception '105: % footer.brand row(s) survived', v_left;
  end if;
  raise notice '105: the brand line now reads "%" from login.brand, in both locales', v_brand;
end $$;

commit;
