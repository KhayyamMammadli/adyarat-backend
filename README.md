# AdYarat Backend

WhatsApp-da məhsul şəklini və reklam təsvirini qəbul edib qısa AI videosu hazırlayan NestJS backend.

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

1. İstifadəçi məhsul şəklini göndərir.
2. Bot videoda nə baş verməli olduğunu soruşur.
3. İstifadəçi, məsələn, `Kamera qəhvəyə yaxınlaşsın, buxar qalxsın, premium reklam olsun` yazır.
4. Backend video işi yaradır.
5. Hazır MP4 həmin söhbətə göndərilir.

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
