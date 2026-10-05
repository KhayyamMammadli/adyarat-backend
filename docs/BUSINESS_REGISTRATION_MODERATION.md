# Biznes qeydiyyatı və admin təsdiqi

Branch: `feat/business-registration-moderation`. Main dəyişdirilmir; production deploy və migration tətbiqi bu işə daxil deyil.

## Hazır olan axın

WhatsApp-da **İşçi axtarıram** → biznes növü (şirkət, dönərxana, kababxana, restoran, kafe, mağaza, xidmət, digər) → biznes/müəssisə adı → VÖEN-in rəsmi mövcudluq yoxlaması → məcburi profil şəkli → əlaqədar şəxsin adı → biznes haqqında məlumat → şəhər/ünvan → email → profil telefonu → önbaxış → təsdiq.

`company_name` mövcud canonical schema ilə uyğunluq üçün saxlanılır, istifadəçiyə “biznes/müəssisə” göstərilir. Növ `business_type` sahəsidir.

Profil WhatsApp-da təsdiqlənəndə `registration_status=pending`, `verified=false` olur. Telegram admininə şəkil, məlumatlar, **Təsdiq et / Rədd et** düymələri gəlir. `/admin` → **Biznes profilləri** ilk 10 pending profili göstərir; həmin profillər moderasiya olunduqca növbəti pending profillər gəlir. Bildiriş itdikdə bu paneldən bərpa edilir.

Admin təsdiqi `approved/verified=true` yazır; WhatsApp istifadəçisinə vakansiya paylaşa biləcəyi bildirilir. Admin qərarı istifadəçinin davam edən seeker/filter state-ni dəyişmir. Profilin növünü və məlumatlarını düzəltmək təsdiqi ləğv edir; yenidən rəsmi VÖEN yoxlaması, şəkil və admin təsdiqi tələb olunur. Köhnə callback tokenləri və təkrar təsdiqlər qəbul edilmir. Telegram webhook-un mövcud secret + admin chat/user allowlist yoxlaması biznes callbacklərinə də tətbiq edilir.

Yeni vakansiya yaratmaq və göndərmək üçün təsdiqlənmiş, tam biznes profili tələb edilir. DB trigger eyni yoxlamanı WhatsApp vakansiya insertion/pending status keçidində atomik tətbiq edir. Manual vakansiyaların ayrıca Telegram moderation axını saxlanılıb. Telegram-dan adminin birbaşa aktiv elan yaratması və external source-lar bu biznes qeydiyyatı triggerindən azaddır. Köhnə elanlar dəyişdirilmir/silinmir; köhnə employer növbəti yeni elandan əvvəl qeydiyyatı tamamlamalıdır.

Seeker flow-un maaş addımından sonra çatışmayan email və profil telefonu soruşulur. Seeker və employer rolları eyni canonical profil əlaqələrini paylaşır. Öz profilində artıq saxlanmış əlaqəni təkrar istifadə etmək olar; başqa istifadəçi onu qeydiyyata ala bilməz. Vakansiyanın optional public əlaqə nömrəsi bu unikallıqdan ayrıdır və avtomatik WhatsApp nömrəsi ilə doldurulmur.

## Real VÖEN çıxışı: hazırda blokludur

Rəsmi Dövlət Vergi Xidməti səhifəsi:
https://www.taxes.gov.az/az/page/vergi-ucotuna-alinmis-vergi-odeyicileri-barede-melumatlarin-verilmesi

Oradan verilən lookup linki:
https://new.e-taxes.gov.az/etaxes/services/taxpayer-info

2026-10-05 yoxlamasında lookup səhifəsi 403 qaytardı. İstifadəsi təsdiqlənmiş, sənədləşdirilmiş açıq DVX API müqaviləsi müəyyən edilməyib. İstifadəçi rəsmi API çıxışının olmadığını təsdiqlədi. **Bu branch real DVX ilə qoşulmuş yoxlama təqdim etmir.** Production `TaxpayerRegistryService` yalnız `unavailable` qaytarır; 10 rəqəmin formatı VÖEN təsdiqi sayılmır. Yeni employer qeydiyyatı bu addımda dayanır. CAPTCHA/login/anti-bot bypass, təxmin edilmiş endpoint və production fake cavabı yoxdur.

Sənədləşdirilmiş, istifadəsinə icazə verilmiş rəsmi inteqrasiya əldə edildikdə `TaxpayerRegistryService.lookup(voen, signal)` implementasiyası real contract əsasında əlavə edilməlidir. Provider yalnız həqiqi cavab əsasında `found + voen + legalName + reference`, `not_found` və ya `unavailable` qaytarmalıdır. Uyğunsuz VÖEN, boş sübut sahələri, xəta və 8 saniyə timeout qeydiyyatı bloklayır. Tokenləri kodda və ya söhbətdə saxlamaq olmaz. Admin qeydiyyatı üçün bu blokun bypass düyməsi yoxdur.

Testlərdə injected fixture provider istifadə olunur; fixture nəticələri production/real DVX yoxlaması deyil. Branch-i olduğu kimi production-a çıxarmaq yeni employer onboarding-i bloklayacaq; rəsmi provider tamamlanmadan deploy edilməməlidir.

## Supabase migration

`supabase/migrations/20261005135413_business_registration_moderation.sql`:

- `job_agent_profiles` və `employer_profiles` üçün RLS və server-only grants. Mövcud backend service key ilə işləyir; public/authenticated client girişinə icazə verilmir.
- `job_agent_profiles.contact_email`, `contact_phone`: rollar arasında canonical əlaqələr və normalized unique indexlər.
- `employer_profiles`: `business_type`, `business_description`, `business_address`, `photo_path`, `legal_name`, `registry_reference`, `voen_verified_at`, `registration_status`, `registration_token`, `rejection_reason`, `reviewed_by`, `reviewed_at`. Mövcud `verified` admin qərarını saxlayır.
- `normalize_job_phone`: yerli 050… və +994…/00994… formatlarını eyni nömrəyə çevirir.
- `claim_job_profile_contact`: service-only, SECURITY INVOKER RPC; transaction advisory locks + unique indexes təkrar/race claims-i bloklayır. Köhnə employer email-i və WhatsApp transport nömrəsi başqa profil tərəfindən mənimsənilə bilməz. Email/telefon dəyişdikdə pending/approved biznes yenidən draft olur və callback token silinir.
- Köhnə employer email-ləri canonical profilə backfill olunur. Dublikat legacy email varsa transaction bütövlükdə rollback olur; profil/data silinmir və avtomatik “qalib” seçilmir.
- `guard_whatsapp_business_job` trigger: WhatsApp elanına yalnız təsdiqlənmiş biznes icazə verir; employer row lock qərarla paralel əməliyyatları qoruyur.
- Private `job-business-photos` bucket: JPEG/PNG, maksimum 5 MB; public policy əlavə edilmir. Admin üçün 5 dəqiqəlik signed URL yaradılır. Mövcud bucket public-dirsə migration dayanar.

Migration production-a tətbiq edilməyib. Bu migration iki profil cədvəlinə server-only RLS/grants tətbiq edir; production-a tətbiq etməzdən əvvəl bunun ayrıca təsdiqi/review-u tələb olunur. Əvvəlki production field-only migration ümumi Job Agent RLS hissəsini tətbiq etməmişdi; heç bir RLS dəyişikliyi bu işdə production-da icra edilməyib. Backend yalnız server service key istifadə edir; repository-də bu cədvəllər üçün public/authenticated client axını yoxdur.

## Yoxlama

`npm run typecheck`, `npm run build`, `npm test`.

Yeni testlər business flow, registry unavailable/not-found/malformed/mismatched responses, photo webhook/private upload/size, pending approval gate, replay/token, unauthorized admin, same-user reuse/cross-user contacts, state restart/isolation, legacy forged states və WhatsApp native limitləri əhatə edir.

PGlite-də ayrıca PostgreSQL migration testləri həqiqi constraint/RPC/trigger icrası ilə backfill, case/phone normalization, duplicate rejection, identity changes, service-only function privilege, Telegram exemption və rollback zamanı data qorunmasını yoxlayır. Bu isolated test bazasıdır; production data dəyişmir.

Yekun lokal nəticə: typecheck keçdi, build keçdi, 139/139 test keçdi; Nest application context startup/DI yoxlaması keçdi.
