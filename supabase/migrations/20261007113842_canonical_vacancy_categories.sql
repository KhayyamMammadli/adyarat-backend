-- Rename only labels; category IDs/slugs and all vacancy/profile references stay intact.
UPDATE public.job_categories
SET name = CASE name
  WHEN 'Hotel / Restoran / Cafe' THEN 'Hotel / Restoran / Kafe'
  WHEN 'Nəqliyyat / Sürücü / Anbar' THEN 'Nəqliyyat / Texnika / Anbar'
  WHEN 'Digər' THEN 'Digər ixtisassız fəhlə'
END
WHERE name IN ('Hotel / Restoran / Cafe','Nəqliyyat / Sürücü / Anbar','Digər');
