begin;

-- Permission matrix: every module x action (spec 6.12). Extend as modules ship.
insert into permissions (key, description)
select m.key || '.' || a.key, m.name || ' - ' || a.name
from (values
  ('dashboard','Control Panel'),('profile','Company Profile'),('fleet','Fleet Management'),
  ('routes','Routes'),('trips','Trips'),('checkpoints','Weighbridge Register'),
  ('tracking','Live Tracking'),('costs','Costs and Fuel'),('garage','Garage'),
  ('drivers','Drivers and Crew'),('trainees','Trainees'),('users','Users and Roles'),
  ('customers','Customer Tracking Accounts'),('reports','Reports'),('office','Office Management'),
  ('documents','Document Vault'),('billing','Billing'),('settings','Settings')
) as m(key, name)
cross join (values
  ('view','View'),('create','Create'),('edit','Edit'),('delete','Delete'),
  ('approve','Approve'),('export','Export')
) as a(key, name)
on conflict do nothing;

insert into roles (tenant_id, key, name, is_system) values
 (null,'director','Director',true),
 (null,'general_manager','General Manager',true),
 (null,'operations_manager','Operations Manager',true),
 (null,'fleet_manager','Fleet Manager',true),
 (null,'finance_officer','Finance Officer',true),
 (null,'dispatcher','Dispatcher',true),
 (null,'checkpoint_clerk','Checkpoint / Weighbridge Clerk',true),
 (null,'hr_officer','HR Officer',true),
 (null,'workshop_manager','Workshop Manager',true),
 (null,'customer_service','Customer Service Officer',true),
 (null,'driver','Driver',true),
 (null,'trainee','Trainee',true),
 (null,'auditor','Auditor (read-only)',true),
 (null,'shipper','Shipper',true),
 (null,'customer_temp','Temporary Customer',true)
on conflict do nothing;

-- Director: unrestricted. Auditor: view + export everywhere.
insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r cross join permissions p where r.key = 'director'
on conflict do nothing;
insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r cross join permissions p
where r.key = 'auditor' and p.key like '%.view' or r.key = 'auditor' and p.key like '%.export'
on conflict do nothing;

-- Plans (edit later in Super Admin, spec 5.5 / 8)
insert into feature_flags (key, enabled, description) values
 ('marketplace', false, 'Shipper portal and quote matching (Phase 7)'),
 ('mobile_api',  false, 'Mobile app API surface (Phase 10)'),
 ('totp_transporter', false, 'Optional TOTP for transporters (spec 4.4)')
on conflict do nothing;

-- Editable content: footer (spec 2) and login microcopy, EN + SW. The brand line belongs to
-- the sign-in card (105) — the bar is the part a caller reads out loud.
insert into content_blocks (key, locale, value) values
 ('login.brand','en','powered by T ENGO AEGIS'), ('login.brand','sw','ilikowezeshwa na T ENGO AEGIS'),
 ('footer.support_email','en','support@tengoaegis.com'), ('footer.support_email','sw','support@tengoaegis.com'),
 ('footer.phone','en',''), ('footer.phone','sw',''),
 ('login.subtitle','en','Sign in to WAISHA'), ('login.subtitle','sw','Ingia kwenye WAISHA'),
 ('signup.success.title','en','Account successfully created'), ('signup.success.title','sw','Akaunti imetengenezwa'),
 ('signup.success.body','en','Your account is ready. Redirecting you to the sign-in screen.'),
 ('signup.success.body','sw','Akaunti yako iko tayari. Tunakuelekeza kwenye ukurasa wa kuingia.')
on conflict (key, locale) do nothing;

commit;