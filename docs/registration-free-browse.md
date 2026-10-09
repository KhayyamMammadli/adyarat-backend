# Qeydiyyatsız vakansiya axtarışı

İlk istənilən mətn mesajı (Salam, İş varmı? və s.) işəgötürən olmayan istifadəçiyə ən yeni 5 aktiv, müddəti bitməmiş vakansiyanı açır. Ad, email, CV və maaş soruşulmur. Texniki WhatsApp identifikatoru mövcud profil cədvəlində saxlanır; bu, istifadəçinin doldurduğu qeydiyyat forması deyil.

Növbəti/əvvəlki səhifə, Filterlə → kateqoriya/şəhər/iş rejimi, elanın tam məlumatı və əlaqə vasitələri mövcud axından istifadə edir. Bütün siyahılar maksimum 10 seçimdir. Uyğun iş seçimlərim istəyə bağlı köhnə profil axınını açır. Bu dəyişiklik avtomatik vakansiya bildirişi göndərmir və yeni müraciət sistemi yaratmır; müraciət elandakı telefon/email/mənbə vasitəsilə edilir.

İşəgötürənin qeydiyyatı, biznes moderasiyası, elan yaratma/redaktə/silmə axını qorunur. Aktiv məlumat girişi zamanı Salam cavabı sahə məlumatıdır; yalnız açıq Əsas menyu/start əmri prosesi sıfırlayır.

Admin statistikasında unikal baxan istifadəçilər, Bakı təqvim günü/həftəsi/ayı üzrə aktiv baxanlar, elan detallarının baxış sayı və ən çox baxılan 5 elan/kateqoriya var. İşəgötürən və Telegram texniki profilləri baxan istifadəçi statistikasına daxil deyil. Kateqoriya göstəricisi həmin filtr ilə göstərilmiş səhifələri sayır. Tarixi rəqəmlər uydurulmur; hesablanma bu versiya aktivləşəndə başlayır. Profil silinəndə şəxsin hadisələri cascade ilə silinir; silinmiş elanın baxış sayı elan ID-si ilə qalır. Statistik yazı uğursuz olsa, istifadəçi yenə vakansiyaları görür və server warning yazır.

Rollout: `20261009101207_registration_free_browse_analytics.sql` migration-ı Xeyyamın Supabase project-inə tətbiq edilməli, sonra kod deploy olunmalıdır. Migration yalnız hadisə cədvəli, indekslər və read-only statistika RPC-si yaradır; mövcud məlumatları dəyişmir. RLS aktivdir, anon/authenticated üçün giriş yoxdur; yalnız backend service_role istifadə edir. Main merge və production deploy bu işdə icra olunmur.
