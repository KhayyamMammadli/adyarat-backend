# WhatsApp AI sazlanması

Backend bu funksiyaları dəstəkləyir:

- adi mətn söhbəti: Gemini, ChatGPT/OpenAI və Claude;
- provider sırayla fallback və müvəqqəti xətalarda retry;
- məhsul şəkli → AI ilə yaxşılaşdırılmış prompt → Runway videosu;
- WhatsApp səs mesajı → mətn;
- PDF, DOCX, TXT, MD, CSV, JSON və HTML → tərcümə edilmiş TXT.

## Provider seçimi

```env
AI_DEFAULT_PROVIDER=auto
AI_PROVIDER_ORDER=gemini,openai,claude

```

WhatsApp-dan konkret provider seçmək üçün:

```text
/gemini Salam
/chatgpt Bu mətni düzəlt
/claude Bu ideyanı analiz et
```

Ən azı bir açar yazın:

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

Səs mesajı OpenAI açarı varsa `gpt-transcribe`, əks halda Gemini vasitəsilə mətnə çevrilir.

## Sənəd tərcüməsi

PDF, DOCX və ya TXT sənədi göndərin.

WhatsApp-da sənədin caption hissəsində belə tapşırıq yaza bilərsiniz:

```text
İngilis dilinə rəsmi üslubda tərcümə et
```

Caption boş buraxılarsa sənəd Azərbaycan dilinə tərcümə edilir.

Skan edilmiş və seçilə bilən mətni olmayan PDF sənədləri üçün OCR bu versiyaya daxil deyil.

## Video hazırlanması

Video yaratmaq üçün:

1. WhatsApp-a məhsul şəklini göndərin.
2. Backend şəkli qəbul etdikdən sonra video təsvirini yazın.
3. AI təsviri Runway üçün təkmilləşdirəcək.
4. Runway videonu hazırlayaraq WhatsApp-a göndərəcək.

## Render

Render-də bu bölməyə daxil olun:

```text
Service → Environment
```

İstifadə etdiyiniz bütün API açarlarını burada əlavə edin.

Həqiqi `.env` faylını və API açarlarını GitHub-a push etməyin.