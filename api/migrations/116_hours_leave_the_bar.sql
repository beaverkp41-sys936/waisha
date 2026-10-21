-- 116: the answering-hours sentence leaves the bar, and the mark goes back into it.
--
-- Two words of the platform's own copy were asked for, not two features. The office wants
-- "Mon–Fri 08:00–17:30 EAT, Saturday 09:00–13:00. A person answers, not a queue." gone from
-- every page that carries the bar; and the brand line, which opened that bar until 105 moved
-- it under the sign-in card, is wanted there again.
--
-- The hours were never in the code. 100 seeded the block empty and a desk typed the sentence
-- into it, which is why clearing it takes a migration rather than an edit: the value lives
-- only in the running database, and a page cannot be fixed by deleting the words from the
-- component that reads them.
--
-- Clearing the value rather than deleting the row is the desk's own rule (100 grants no
-- DELETE on purpose): an empty block already means "the page does not show this", and the row
-- survives so the office can say the hours again from /control/content without a deploy.
-- Writing the clear here instead of only in the running database is what stops a fresh seed
-- or a restored copy from putting the sentence back.

update content_blocks set value = '', updated_at = now()
 where key = 'footer.hours' and locale in ('en', 'sw') and value <> '';
