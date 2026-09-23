# Supabase quraşdırması

Supabase bu layihədə kontaktları, mesajları, webhook-ları, video işlərini və media fayllarını davamlı saxlamaq üçündür. Lokal sınaqda boş qala bilər; bu halda yaddaş və `data/media` qovluğu istifadə olunur.

## Variant A — CLI ilə

Supabase layihənizi linkləyin və migration-u tətbiq edin:

```bash
npx supabase login
npx supabase link --project-ref SIZIN_PROJECT_REF
npx supabase db push
```

Migration faylı: `supabase/migrations/20260923131033_initial_schema.sql`.

## Variant B — SQL Editor ilə

Migration faylının məzmununu Supabase Dashboard → SQL Editor bölməsində bir dəfə icra edin.

Sonra `.env`-ə bunları əlavə edin:

```env
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
SUPABASE_BUCKET=adyarat-media
```

Yeni layihələrdə server üçün secret key istifadə edin. Legacy layihədə müvəqqəti olaraq `SUPABASE_SERVICE_ROLE_KEY` fallback-i dəstəklənir.

## Təhlükəsizlik

- Secret/service-role açarı yalnız backend-də qalmalıdır.
- Cədvəllərdə RLS aktivdir; `anon` və `authenticated` rollarına giriş verilməyib.
- Media bucket-i private yaradılır.
- Frontend və ya mobil tətbiqə server açarı göndərməyin.

## Qeyd

Bu sadə worker bir backend instansı üçün uyğundur. Bir neçə instansla miqyaslama zamanı atomik database queue/RPC və ya ayrıca queue xidməti əlavə edin.
