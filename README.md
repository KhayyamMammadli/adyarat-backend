# AdYarat Backend

WhatsApp-da məhsul şəklini və reklam təsvirini qəbul edib reklam videosu, reklam mətni və səsli reklam hazırlayan NestJS backend.

Gemini, ChatGPT/OpenAI, Claude, səs transkripsiyası, sənəd tərcüməsi və Runway video generasiyası dəstəklənir. Ətraflı sazlama üçün `docs/AI_SETUP.md` faylına baxın.

## Hazır funksiyalar

- Meta webhook verify və `X-Hub-Signature-256` imza yoxlaması
- şəkil → prompt → video dialoq axını
- `KÖMƏK`, `STATUS`, `LƏĞV` əmrləri
- təkrarlanan webhook və mesajların qarşısının alınması
- asinxron webhook və video worker-ləri
- pulsuz lokal sınaq üçün hazır mock MP4
- real video üçün Runway image-to-video inteqrasiyası
- Supabase database və private Storage inteqrasiyası
- Supabase olmadıqda in-memory/lokal fallback
- hər istifadəçi üçün bir pulsuz pilot video limiti
- seçilmiş test nömrələri üçün limitsiz pilot rejimi
- health endpoint, Dockerfile və Render blueprint
- build olunan TypeScript və avtomatik testlər

## Tələblər

- Node.js 22 və ya daha yeni
- npm
- Meta Developer tətbiqi və WhatsApp Cloud API test nömrəsi
- Production üçün Supabase layihəsi
- Real AI video üçün Runway API açarı

## 1. Lokal başladın

```bash
npm install
cp .env.example .env
npm run start:dev
```

Yoxlama:

```bash
curl http://localhost:3000/health
```

`VIDEO_PROVIDER=mock` olduqda AI üçün pul xərclənmir və `assets/mock-video.mp4` qaytarılır.

## 2. Meta məlumatlarını yazın

`.env` faylında bunları doldurun:

```env
META_ACCESS_TOKEN=...
META_PHONE_NUMBER_ID=...
META_APP_SECRET=...
META_WEBHOOK_VERIFY_TOKEN=...
```

Tam addımlar: [docs/META_SETUP.md](docs/META_SETUP.md).

## 3. Webhook-u internetə açın

Meta yalnız public HTTPS ünvanına sorğu göndərir. Render deploy-dan sonra callback URL:

```text
https://SIZIN-SERVICE.onrender.com/webhooks/whatsapp
```

Lokal sınaq üçün Cloudflare Tunnel və ya oxşar HTTPS tunnel istifadə edilə bilər.

## 4. Supabase-i qoşun

Production üçün migration-u tətbiq edin və `.env`-ə server secret key əlavə edin. Təlimat: [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md).

Supabase olmadan bütün proses lokal test edilə bilər, lakin restart zamanı database məlumatı silinir.

## 5. Real video generation-a keçin

```env
VIDEO_PROVIDER=runway
RUNWAYML_API_SECRET=...
RUNWAY_MODEL=gen4.5
RUNWAY_DURATION=5
RUNWAY_RATIO=720:1280
```

Runway ödənişli xidmətdir. Nəticə URL-i müvəqqəti olduğu üçün backend videonu dərhal öz storage-na yükləyir.

## İstifadəçi axını

1. İstifadəçi ilk mesajını yazır və əsas reklam menyusunu görür.
2. `Reklam yarat` seçərək video, mətn və ya səsli reklam növünü seçir.
3. Video üçün məhsul şəklini və reklam təsvirini göndərir.
4. Backend video işi yaradır.
5. Hazır MP4 həmin söhbətə göndərilir.
6. İlk uğurlu videodan sonra `free_video_used` dəyəri `true` olur.
7. Növbəti video sifarişi paket və dəstək menyusuna yönləndirilir.

## Pilot video limiti

Hər yeni istifadəçiyə bir uğurlu pulsuz video verilir. Runway xəta verərsə və video yaranmazsa pulsuz haqq istifadə edilmiş sayılmır.

Öz test nömrələrinizi limitdən azad etmək üçün Render Environment bölməsində aşağıdakı dəyişəni əlavə edin:

```env
PILOT_UNLIMITED_WA_IDS=994501234567,AZ.1798521701155548
```

Dəyərlər `wa_contacts.wa_id` sütunundan götürülməli, vergüllə ayrılmalı və aralarında boşluq olmamalıdır. Buraya AdYaratın biznes nömrəsi deyil, AdYarata mesaj göndərən test hesabları yazılır.

## Pilot buraxılış yoxlaması

1. Supabase SQL Editor-də bütün migration-ları tətbiq edin.
2. `wa_contacts` cədvəlində `free_video_used` sütununun olduğunu yoxlayın.
3. Render-də `VIDEO_PROVIDER=runway` olduğunu yoxlayın.
4. Render-də `RUNWAYML_API_SECRET` və digər secret dəyişənlərin mövcud olduğunu yoxlayın.
5. Render-də `PILOT_UNLIMITED_WA_IDS` dəyərini yalnız test hesabları üçün yazın.
6. Adi test istifadəçisi ilə bir videonun uğurla yaradıldığını yoxlayın.
7. Eyni adi istifadəçi ilə ikinci video cəhdinin bloklandığını yoxlayın.
8. Limitsiz test nömrəsi ilə təkrar video sifarişinin qəbul edildiyini yoxlayın.
9. Runway xəta verdikdə istifadəçiyə xəta mesajı və sürətli menyunun göndərildiyini yoxlayın.

## Test və build

```bash
npm test
npm run typecheck
npm run format:check
```

Production:

```bash
npm ci
npm run build
npm run start:prod
```

## Render deploy

Repo-nu GitHub-a göndərin, Render-də Blueprint yaradıb `render.yaml` faylını seçin. Secret dəyişənləri Render Dashboard-da daxil edin. Pulsuz instans yatdığı üçün ilk webhook gecikə bilər; real istifadə artanda ödənişli always-on instansa keçmək məntiqlidir.

## Endpoint-lər

| Metod  | Ünvan                | Məqsəd                    |
| ------ | -------------------- | ------------------------- |
| `GET`  | `/`                  | servis məlumatı           |
| `GET`  | `/health`            | health və storage rejimi  |
| `GET`  | `/webhooks/whatsapp` | Meta webhook verification |
| `POST` | `/webhooks/whatsapp` | imzalı webhook qəbulu     |

## Təhlükəsizlik

- `.env` və real tokenlər ZIP-ə daxil edilmir.
- Production rejimində Meta token, Phone Number ID, App Secret və verify token məcburidir.
- Media public URL ilə saxlanılmır.
- Log-lara token yazılmır.
- Gələn şəkil formatı və ölçüsü, prompt uzunluğu yoxlanılır.

Ətraflı sxem: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
