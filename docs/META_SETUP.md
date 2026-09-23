# Meta və WhatsApp Cloud API quraşdırması

## 1. Test nömrəsi ilə ilkin yoxlama

Meta Developer panelində tətbiqi açın və **Connect on WhatsApp → Step 1. Try it out** bölməsinə keçin.

1. `Generate token` ilə müvəqqəti token yaradın.
2. Öz nömrənizi `Recipient` kimi əlavə və təsdiq edin.
3. Test mesajını göndərin.
4. `Phone Number ID` dəyərini kopyalayın.

Müvəqqəti tokenin vaxtı bitir. Production üçün sonradan System User vasitəsilə daimi token yaradılmalıdır.

## 2. Backend dəyişənləri

`.env.example` faylını `.env` adı ilə kopyalayın və bunları doldurun:

```env
META_GRAPH_API_VERSION=v25.0
META_ACCESS_TOKEN=...
META_PHONE_NUMBER_ID=...
META_APP_SECRET=...
META_WEBHOOK_VERIFY_TOKEN=özünüzün_yaratdığı_uzun_təsadüfi_mətn
```

`META_APP_SECRET` tətbiqin **App settings → Basic** bölməsindədir. Heç bir açarı Git-ə göndərməyin.

## 3. Webhook qoşulması

Backend internetdən HTTPS ilə açıq olmalıdır. Meta panelində callback URL belədir:

```text
https://SIZIN-DOMENINIZ/webhooks/whatsapp
```

Verify token sahəsinə `.env`-dəki `META_WEBHOOK_VERIFY_TOKEN` dəyərini eynilə yazın. Sonra `messages` webhook sahəsinə abunə olun.

Backend:

- GET sorğusunda verify token-i yoxlayır;
- POST sorğusunda `X-Hub-Signature-256` imzasını App Secret ilə yoxlayır;
- eyni webhook-u ikinci dəfə emal etmir;
- mesajı qəbul edən kimi `200` qaytarır, ağır işi worker arxa planda görür.

## 4. Production nömrəsi

Test bitdikdən sonra **Step 2. Production setup** ilə ayrıca biznes nömrəsini əlavə edin. Nömrə SMS və ya zənglə təsdiq edilə bilməlidir. Meta-nın tələb etdiyi biznes yoxlamasını və ödəniş məlumatlarını öz panelinizdə tamamlayın.

> Token, App Secret və telefon nömrəsi kimi məlumatların ekran görüntüsünü paylaşmayın.
