# Biznes qeydiyyatı və admin təsdiqi

Branch: `feat/business-registration-moderation`. Main dəyişdirilmir; production deploy və migration tətbiqi bu işə daxil deyil.

## Hazır olan axın

WhatsApp-da **İşçi axtarıram** → biznes növü (şirkət, dönərxana, kababxana, restoran, kafe, mağaza, xidmət, digər) → biznes/müəssisə adı → VÖEN-in rəsmi mövcudluq yoxlaması → məcburi profil şəkli → əlaqədar şəxsin adı → biznes haqqında məlumat → şəhər/ünvan → email → profil telefonu → önbaxış → təsdiq.

`company_name` mövcud canonical schema ilə uyğunluq üçün saxlanılır, istifadəçiyə “biznes/müəssisə” göstərilir. Növ `business_type` sahəsidir.

Profil WhatsApp-da təsdiqlənəndə `registration_status=pending`, `verified=false` olur. Telegram admininə şəkil, məlumatlar, **Təsdiq et / Rədd et** düymələri gəlir. `/admin` → **Biznes profilləri** ilk 10 pending profili göstərir; həmin profillər moderasiya olunduqca növbəti pending profillər gəlir. Bildiriş itdikdə bu paneldən bərpa edilir.

Admin təsdiqi `approved/verified=true` yazır; WhatsApp istifadəçisinə vakansiya paylaşa biləcəyi bildirilir. Admin qərarı istifadəçinin davam edən seeker/filter state-ni dəyişmir. Profilin növünü və məlumatlarını düzəltmək təsdiqi ləğv edir; yenidən rəsmi VÖEN yoxlaması, şəkil və admin təsdiqi tələb olunur. Köhnə callback tokenləri və təkrar təsdiqlər qəbul edilmir. Telegram webhook-un mövcud secret + admin chat/user allowlist yoxlaması biznes callbacklərinə də tətbiq edilir.

Yeni vakansiya yaratmaq və göndərmək üçün təsdiqlənmiş, tam biznes profili tələb edilir. DB trigger eyni yoxlamanı WhatsApp vakansiya insertion/pending status keçidində atomik tətbiq edir. Manual vakansiyaların ayrıca Telegram moderation axını saxlanılıb. Telegram-dan adminin birbaşa aktiv elan yaratması və external source-lar bu biznes qeydiyyatı triggerindən azaddır. Köhnə elanlar dəyişdirilmir/silinmir; köhnə employer növbəti yeni elandan əvvəl qeydiyyatı tamamlamalıdır.

Seeker flow-un maaş addımından sonra çatışmayan email və profil telefonu soruşulur. Seeker və employer rolları eyni canonical profil əlaqələrini paylaşır. Öz profilində artıq saxlanmış əlaqəni təkrar istifadə etmək olar; başqa istifadəçi onu qeydiyyata ala bilməz. Vakansiyanın optional public əlaqə nömrəsi bu unikallıqdan ayrıdır və avtomatik WhatsApp nömrəsi ilə doldurulmur.

## VÖEN üçün yekun MVP qərarı: rəsmi mənbədən admin yoxlaması

Rəsmi Dövlət Vergi Xidməti xidmət səhifəsi:
https://www.taxes.gov.az/az/page/vergi-ucotuna-alinmis-vergi-odeyicileri-barede-melumatlarin-verilmesi

Rəsmi lookup linki:
https://new.e-taxes.gov.az/etaxes/services/taxpayer-info

2026-10-05 son yoxlamada rəsmi lookup səhifəsi yenə 403 qaytardı. İşlək, istifadəsi təsdiqlənmiş avtomatik API müqaviləsi əldə edilməyib. Bu fakt “DVX-də API yoxdur” demək deyil. ERPGO öz kommersiya Odoo modulunda public inteqrasiya təklif edir, amma açıq endpoint/cavab müqaviləsi dərc edilməyib və yalnız hüquqi şirkətləri əhatə etdiyini bildirir; istifadəçilərin fərdi sahibkar VÖEN-lərini əhatə etdiyi təsdiqlənməyib. VerifyVAT Azərbaycan VÖEN-i üçün “syntactic validation” göstərir; bu, bazada mövcudluq sübutu deyil. VatPortal abunə və giriş məlumatları tələb edir; belə girişimiz yoxdur. Bu alternativlərin heç biri real registry verification kimi saxtalaşdırılmır.

İstifadəçi daha yaxşı alternativ axın qurmağa icazə verdi. **Qərar: avtomatik DVX yoxlaması alınmadıqda qeydiyyatı bloklamaq əvəzinə VÖEN-i admin rəsmi bazada əl ilə yoxlayır.** Production registry provider hələ `unavailable` qaytarır; gizli scraping, CAPTCHA/login bypass, təxmin edilmiş endpoint və fake cavab yoxdur.

- Format düzgündürsə `voen_verification_method=pending_admin` yazılır. `voen_verified_at`, `voen_verified_by`, `legal_name`, `registry_reference` boş qalır. İstifadəçiyə VÖEN-in hələ yoxlanmadığı bildirilir; şəkil və digər profil məlumatlarını tamamlayıb adminə göndərə bilir.
- Admin profilin **Təsdiq et** düyməsinə basdıqda ayrıca VÖEN yoxlama session-u açılır. Bot VÖEN və rəsmi lookup linkini göstərir; admin rəsmi mənbədə uyğun qeydi tapıb qeydiyyat adını daxil etməlidir.
- Sonra ayrıca **VÖEN-i yoxladım** düyməsi göstərilir. Admin bu düymə ilə rəsmi bazada şəxsən yoxladığını təsdiqləyir. Bu, avtomatik yoxlama deyil və etibarlı adminin bəyanatına əsaslanır; backend əl ilə daxil edilən adın doğruluğunu müstəqil təsdiq etmir.
- Qərar bazada `admin_manual`, rəsmi qeydiyyat adı, admin user ID, tarix və mənbə linki ilə saxlanır. Sonra biznes `approved` olur və vakansiya yaratmaq açılır. Sadəcə 10 rəqəm daxil edilməsi və ya ilk approval düyməsi bunu açmır.
- Rəsmi səhifə admin üçün də açılmırsa və ya uyğun VÖEN tapılmırsa admin təsdiqləməməlidir: ləğv/rədd etmək olar. Yoxlama tamamlanana qədər vakansiya yaratmaq bloklu qalır. Profil düzəlişi əvvəlki audit/təsdiqi ləğv edir.
- Gələcək real provider `found` qaytararsa `registry` sübutu saxlanır və manual addım tələb olunmur. Həqiqi `not_found` və uyğunsuz/malformed nəticə yenə VÖEN addımını bloklayır; 8 saniyə timeout/unavailable manual yoxlamaya keçir.

Bu alternativ ilk istənilən “VÖEN-dən dərhal sonra avtomatik bazada yoxlama” funksiyası deyil: yoxlama profilin bütün məlumatları toplanandan sonra admin mərhələsində edilir. Avtomatik provider tamamlanmayıb, amma qeydiyyatın manual review yolu test edilib və işləyir. Heç kim yoxlama aparmasa avtomatik təsdiq yoxdur.

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

Yeni `20261005142314_manual_voen_review.sql` migration-u `voen_verification_method` və `voen_verified_by` əlavə edir. `pending_admin` üçün yoxlanmış sübut saxlanması, `admin_manual` üçün isə admin/tarix/rəsmi ad olmadan qeyd yazılması constraint-lərlə bloklanır. Hər iki migration feature branch-dədir; production-a tətbiq edilməyib.

## Yoxlama

`npm run typecheck`, `npm run build`, `npm test`.

Yeni testlər business flow, registry unavailable/not-found/malformed/mismatched responses, photo webhook/private upload/size, pending approval gate, replay/token, unauthorized admin, same-user reuse/cross-user contacts, state restart/isolation, legacy forged states və WhatsApp native limitləri əhatə edir.

PGlite-də ayrıca PostgreSQL migration testləri həqiqi constraint/RPC/trigger icrası ilə backfill, case/phone normalization, duplicate rejection, identity changes, service-only function privilege, Telegram exemption və rollback zamanı data qorunmasını yoxlayır. Bu isolated test bazasıdır; production data dəyişmir.

Yekun lokal nəticə: typecheck keçdi, build keçdi, 144/144 test keçdi; Nest application context startup/DI yoxlaması keçdi.
