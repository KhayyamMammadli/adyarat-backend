-- Add missing backup categories without changing existing IDs or vacancy links.
INSERT INTO public.job_categories(name,slug,is_active)
SELECT v.name,v.slug,true FROM (VALUES
('İnformasiya Texnologiyaları','it-informasiya-texnologiyalari'),
('Maliyyə / Audit / Mühasib','maliyye-audit-muhasib'),
('Marketinq / Sosial Media','marketinq-sosial-media'),
('İnşaat / Tikinti / Memarlıq','insaat-tikinti-memarliq'),
('Nəqliyyat / Sürücü / Anbar','neqliyyat-surucu-anbar'),
('İstehsalat / Zavod / Servis','istehsalat-zavod-servis'),
('Kənd təsərrüfatı / Sənaye','kend-teserrufati-senaye'),
('Hotel / Restoran / Cafe','otel-restoran-kafe'),
('Satış və Müştəri Xidmətləri','satis-ve-musteri-xidmetleri'),
('Səhiyyə / Tibb / Sağlamlıq','sehiyye-tibb-saglamliq'),
('Elm / Təhsil / Təlim','elm-tehsil-telim'),
('Daşınmaz Əmlak','dasinmaz-emlak'),
('İncəsənət / Yaradıcılıq','incesenet-yaradiciliq'),
('Təchizat / Loqistika','techizat-loqistika'),
('Pərakəndə Satıcılıq','perakende-satici'),
('Ofis / Sənədləşmə','ofis-senedlesme'),
('Mühafizə / Təhlükəsizlik','muhafize-tehlukesizlik'),
('Digər','diger'),
('Biznes / İdarəetmə / HR','biznes-idareetme-hr')
) AS v(name,slug)
WHERE NOT EXISTS (SELECT 1 FROM public.job_categories c WHERE c.name=v.name)
ON CONFLICT(slug) DO NOTHING;
