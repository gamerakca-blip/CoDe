# Akıncı AI

Claude (Opus 5.5) tabanlı, akış (streaming) cevaplı web sohbet uygulaması. İki uzmanlık alanı vardır:

- **Kod yazma:** eksiksiz, çalıştırılabilir kod; renklendirilmiş kod blokları, kopyalama ve dosya olarak indirme
- **Osmanlı:** tarih, kurumlar, kültür; Osmanlı Türkçesi transkripsiyonu, sadeleştirme ve kelime kökenleri; Hicri/Rumi → Miladi tarih karşılıkları

 Pikselli fesli maskot uygulamanın durumunu gösterir:

| Durum | Maskot |
|---|---|
| Boşta | Kahve içer (buharlı fincan, ara ara yudum alır) |
| 30 sn hareketsiz | Uyur (gözler kapalı, Zzz, fincan yerde) |
| Model düşünüyor | Laptop başında, gözler yukarıda, düşünce noktaları |
| Cevap yazılıyor | Laptopta hızlı yazar, ekrandan bitler yükselir |

## Abonelik planları

| Plan | Fiyat | Günlük mesaj | Düşünme seviyesi | Mesaj uzunluğu |
|---|---|---|---|---|
| Free | Ücretsiz | 50 | düşük (kısa cevap) | 4.000 karakter |
| Pro | 150 TL / ay | 150 | yüksek | 32.000 karakter |
| Full | 300 TL / ay | Sınırsız | en yüksek (`max`) | 32.000 karakter |

- Tüm planlar Claude Opus 5.5 kullanır. Plan ayarları: `src/plans.ts`.
- Günlük kota İstanbul saatine göre gece yarısı sıfırlanır. Sağlayıcı hatasında veya güvenlik reddinde hak iade edilir; kullanıcının durdurduğu tur sayılır.
- Kötüye kullanıma karşı tüm planlarda dakikada 12 mesaj sınırı vardır.
- Ücretli planlar 30 gün geçerlidir. Aynı planı tekrar almak süreyi uzatır; süre bitince Free'ye dönülür.
- Hesaplar e-posta + şifre ile açılır (scrypt ile saklanır, oturum HttpOnly çerez). Veriler SQLite'ta: `data/akinci.db`.

## Ödeme (iyzico)

iyzico Ödeme Formu kullanılır: kullanıcı iyzico'nun güvenli ödeme sayfasına yönlenir, ödeme sonrası iyzico
`/api/payment/iyzico/callback` adresine döner, sunucu sonucu iyzico'dan sorgulayıp sipariş numarası ve
tutar eşleşirse planı açar. Kart bilgisi bu sunucuya hiç gelmez.

1. [iyzico](https://www.iyzico.com) üye işyeri başvurusu yap. Test için sandbox hesabı aç: https://sandbox-merchant.iyzipay.com
2. API ve güvenlik anahtarlarını `.env` içine yaz: `IYZICO_API_KEY`, `IYZICO_SECRET_KEY`.
3. Test: `IYZICO_BASE_URL=https://sandbox-api.iyzipay.com`, canlı: `https://api.iyzipay.com`.
4. Canlıda `PUBLIC_BASE_URL` (ör. `https://akinci.ornek.com`) ve `COOKIE_SECURE=true` ayarla.

Notlar:
- Ödeme her ay kullanıcı tarafından yenilenir (otomatik kart çekimi yok). Otomatik yenileme için iyzico'nun ayrı "Abonelik" ürünü gerekir.
- iyzico alıcı için T.C. kimlik no ve adres ister. Bu uygulama bunları toplamaz; `IYZICO_BUYER_*` varsayılanları gönderilir. Bunun hesabın için uygun olduğunu iyzico ile teyit et.
- Yerelde ödeme almadan denemek için `PAYMENT_MODE=demo` (canlıda kullanma).

## Telefonda kullanım

- Arayüz telefona uyumludur; ana ekrana uygulama olarak eklenebilir (PWA).
- Aynı Wi-Fi'daki telefondan: sunucu açılışta `http://192.168.x.x:3000` adresini yazdırır, telefonun tarayıcısında aç.
- Ana ekrana ekleme (PWA kurulumu) tarayıcıların kuralı gereği yalnızca HTTPS'te çalışır. Bunun için uygulamayı HTTPS'li bir sunucuya yayınla (ör. Render, Railway, kendi VPS'in + Cloudflare).

## Kurulum

```bash
cd akinci-ai
npm install
cp .env.example .env   # ANTHROPIC_API_KEY değerini gir
npm run build
npm start              # http://localhost:3000
```

Geliştirme modu: `npm run dev`

## Ayarlar (`.env`)

Tüm değişkenler açıklamalarıyla `.env.example` içinde. En önemlileri:

| Değişken | Açıklama |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API anahtarı (zorunlu) |
| `IYZICO_API_KEY`, `IYZICO_SECRET_KEY` | iyzico anahtarları (satın alma için zorunlu) |
| `IYZICO_BASE_URL` | sandbox veya canlı iyzico adresi |
| `PUBLIC_BASE_URL` | canlıda sitenin dış adresi |
| `PORT`, `HOST` | varsayılan `3000`, `0.0.0.0` |

## Yapı

- `src/server.ts` — Express sunucu, hesap/abonelik/sohbet uç noktaları, `/api/chat` SSE akışı
- `src/plans.ts` — plan fiyatları, kotalar, düşünme seviyeleri
- `src/db.ts` — SQLite şeması: kullanıcılar, oturumlar, günlük kullanım, siparişler
- `src/auth.ts` — şifre özeti, oturum çerezi, hız sınırı, CSRF kontrolü
- `src/payments/iyzico.ts` — iyzico ödeme formu başlatma ve doğrulama
- `src/prompt.ts` — Akıncı'nın sistem talimatı (kod + Osmanlı)
- `public/` — arayüz: `app.js` (sohbet), `account.js` (giriş, planlar), `mascot.js`, `markdown.js`, `sw.js` (PWA)

## Notlar

- Sunucu tarafı yedek model (`fallbacks: "default"`) açık: güvenlik sınıflandırıcısı isteği reddederse API aynı istekte uygun yedek modele geçer.
- Sohbet geçmişi sunucu belleğinde tutulur; sunucu yeniden başlarsa sıfırlanır.
- Durdur butonu veya hata durumunda o tur geçmişe eklenmez.
