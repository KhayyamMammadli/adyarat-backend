# Profil və vakansiya idarəetməsi

## WhatsApp

- İş axtaran və işəgötürən: **Profilim → Profili sil → Profili sil**. İkinci düymə cari təsdiq tokeninə bağlıdır. Şəxsi profil, əlaqə məlumatları, seeker kriteriyaları, biznes qeydiyyatı və profilə bağlı mesajlar silinir. Biznes şəkli etibarlı cleanup növbəsinə düşür. İşəgötürənin elanları bağlanır, əlaqə məlumatları çıxarılır, planlı yayım ləğv edilir. Sonra yenidən qeydiyyat mümkündür. Başqa istifadəçinin və Telegram adminin profilini bu əməliyyatla silmək olmur.
- Təsdiqlənmiş işəgötürənin menyusu: **Vakansiya yerləşdir**, **Elanlarım**. Elanlarım 5 elanlıq səhifələrlə göstərilir.
- Elanlarım → elan → sahə → yeni məlumat → **Digər sahələr / Saxla → Düzəlişi göndər**. Vəzifə, biznes adı, açıqlama, ünvan, iş rejimi, maaş, telefon, email, kateqoriya, xəritə və yayım vaxtı redaktə olunur. Dəyişikliklər Saxla basılana qədər yalnız draftdır. Əsas menyu draftı ləğv edir.
- İşəgötürən düzəlişi yeni versiya kimi `pending` olur və yenidən admin təsdiqi tələb edir. Təsdiqədək əvvəlki versiya da yayımlanmır. Köhnə Telegram düymələri yeni versiyanı təsdiqləyə/rədd edə bilməz.
- Yeni elan təsdiq ekranında **Tarixə planla** və **Dərhal yayımla** seçimləri var. Tarix `DD.MM.YYYY HH:mm`, Bakı vaxtı (UTC+4) ilə yazılır. Keçmiş/etibarsız tarix və 28 günlük saxlanma müddətindən sonrakı vaxt qəbul edilmir.

## Telegram

- Admin panelində **Elanlarım / Redaktə**: yalnız həmin Telegram istifadəçisinin yaratdığı elanlar, 5 elanlıq səhifələr. Sahə düymələri, məlumat girişi və **Saxla**. Office/Hybrid üçün GPS tələb olunur. Öz elanı yenilənəndə ayrıca moderasiya tələb olunmur; gələcək vaxt varsa `scheduled`, əks halda `active` olur.
- Yeni admin elanının təsdiq ekranında **Vaxt seç**, **Dərhal**, **Təsdiqlə və yarat** düymələri var.
- Admin/superadmin redaktə hüququna malikdir. Moderator üçün **Öz elanlarını redaktə et** ayrıca seçilə bilən icazədir. Hər redaktə əməliyyatında icazə yenidən yoxlanır.
- İşəgötürənin planlı elanı təsdiqlənəndə `approved_at` yazılır. Vaxt gəlməyibsə `scheduled` vəziyyətində qalır; vaxt keçibsə təsdiqdən dərhal sonra aktiv olur. Rədd edilmiş, təsdiqlənməmiş və profili silinmiş elan avtomatik yayımlanmır.

## Baza və worker

Migration: `supabase/migrations/20261007114714_vacancy_lifecycle_management.sql`.

`jobs`: `scheduled_at`, `approved_at`, `delete_at`, `revision`; status siyahısına `scheduled` əlavə olunur. Employer, Telegram və collector eyni `jobs` mənbəyindən istifadə edir. WhatsApp bütün/matching/filter/detail sorğularının mövcud `active` və `expires_at` filtrləri qorunur.

**28 gün bazaya ilk əlavə edilmə vaxtından (`created_at`) hesablanır.** Redaktə və moderasiya müddəti uzatmır. `delete_at = created_at + 28 gün`; trigger tarix dəyişdirərək müddəti uzatmağı bloklayır. `expires_at` ən gec bu son tarix olur. Planlı elan da bu müddətin daxilində yayımlanmalıdır. Migration mövcud elanları silmir, onların son tarixini hesablayır.

Backend başlananda və hər 60 saniyədə lifecycle worker:

1. Son tarixə çatmış bütün statuslardakı elanları fiziki silir. FK cascade bildiriş intentlərini də silir.
2. Təsdiqlənmiş və vaxtı çatmış planlı elanları aktivləşdirir. WhatsApp biznesinin təsdiqi də yoxlanır.
3. Silinmiş profil şəkillərini private storage-dan təmizləyir; uğursuz silinmə növbədə qalır və yenidən sınanır.

Worker DB transaction/advisory lock ilə bir neçə instance üçün təhlükəsizdir; process daxilində üst-üstə tick işləmir. Restartda catch-up edir. SQL və storage səhvləri worker-i dayandırmır. Real istifadəçiyə avtomatik yeni-vakansiya notification göndərmir.

Supabase-də `pg_cron` mövcuddursa migration **dəqiqəlik DB cron** yaradır. Private `vacancy_lifecycle_settings.enabled` ilkin olaraq false olur: migration tətbiq ediləndə heç nə yayımlanmır/silinmir. Yeni kod ilk dəfə başlayanda service-only activation RPC bu flag-i açır. Bundan sonra cron Render yatanda belə yayım/silinməni davam etdirir. Backend worker əlavə fallback və storage cleanup üçündür. Cron olmayan lokal bazada backend fallback işləyir. Yayım və fiziki silinmə təxminən 60 saniyə intervalındadır; müddəti bitmiş elan `expires_at` sayəsində dərhal listing/matching/detail-dən çıxır. Yeni env/secret tələb edilmir.

RPC-lər `SECURITY INVOKER`, yalnız `service_role` üçün açıqdır. Profil silinməsi və elan redaktəsi transaction daxilində mülkiyyət və versiya yoxlayır. `job_media_cleanup` private RLS-enabled cədvəldir. Production-da worker RPC-ni test məqsədilə işə salmayın: vaxtı bitmiş elanları həqiqətən silir.

## Test

`npm run typecheck` və `npm test` (build daxil olmaqla). Yeni migration testləri real PostgreSQL semantics ilə PGlite-də işləyir; WhatsApp/Telegram inteqrasiya testləri production-a mesaj və data göndərmir.

Merge/deploy-dan əvvəl migration tətbiq olunmalıdır. Migration DB cron-u no-op vəziyyətində saxlayır. Lifecycle yalnız bu branch-in kodu deploy olunanda aktivləşir.
