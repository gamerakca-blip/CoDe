# Akıncı AI

Claude (Opus 5.5) veya Google Gemini ile çalışan, akış (streaming) cevaplı web sohbet uygulaması. İki uzmanlık alanı vardır:

- **Kod yazma:** eksiksiz, çalıştırılabilir kod; renklendirilmiş kod blokları, kopyalama ve dosya olarak indirme
- **Osmanlı:** tarih, kurumlar, kültür; Osmanlı Türkçesi transkripsiyonu, sadeleştirme ve kelime kökenleri; Hicri/Rumi → Miladi tarih karşılıkları

 Pikselli fesli maskot uygulamanın durumunu gösterir:

| Durum | Maskot |
|---|---|
| Boşta | Kahve içer (buharlı fincan, ara ara yudum alır) |
| 30 sn hareketsiz | Uyur (gözler kapalı, Zzz, fincan yerde) |
| Model düşünüyor | Laptop başında, gözler yukarıda, düşünce noktaları |
| Cevap yazılıyor | Laptopta hızlı yazar, ekrandan bitler yükselir |

## Yapay zeka sağlayıcısı

| Ayar | Sağlayıcı | Not |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude Opus 5.5 | Ücretli; en iyi kalite. Planlara göre düşünme seviyesi değişir. |
| `GEMINI_API_KEY` | Google Gemini (`gemini-3.8-flash`) | Ücretsiz katmanı var; dakika/gün istek sınırı uygulanır. Ücretsiz katmanda Google verileri model geliştirmek için kullanabilir. |

Yalnızca biri doluysa o kullanılır; ikisi de doluysa Claude. `AI_PROVIDER=gemini` veya `claude` ile zorlanabilir.
Gemini'de planlar mesaj kotası ve cevap uzunluğuyla ayrışır (düşünme seviyesi ayarı Claude'a özeldir).
Ücretsiz Gemini anahtarı: https://aistudio.google.com/apikey

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

## Site sahibi hesabı

`OWNER_EMAILS` içindeki e-posta(lar) süresiz Full plan alır ve ödeme ekranı onlara kapalıdır.

- Bu e-postalar herkese açık kayıtla **alınamaz**: kayıt sırasında site `OWNER_SIGNUP_CODE` ile aynı "Sahip kodu"nu ister. Böylece biri senden önce o e-postayla kaydolup sahip yetkisi alamaz.
- Adım adım: sunucuda `OWNER_EMAILS` ve `OWNER_SIGNUP_CODE` ayarla → siteden o e-postayla "Kayıt ol" → istenince sahip kodunu gir.
- Daha önce sıradan hesap olarak kaydolduysan sunucuda: `npm run make-owner -- e-posta@adresin.com`
- E-posta bu depoya yazılmadı çünkü depo herkese açık; yalnızca sunucu ayarında durur.

## Ödeme (iyzico)

iyzico Ödeme Formu kullanılır: kullanıcı iyzico'nun güvenli ödeme sayfasına yönlenir, ödeme sonrası iyzico
`/api/payment/iyzico/callback` adresine döner, sunucu sonucu iyzico'dan imzalı istekle sorgular; sipariş numarası,
tutar ve durum eşleşirse planı açar. Kart bilgisi bu sunucuya hiç gelmez. Satın almadan önce kullanıcı mesafeli satış
sözleşmesini onaylar.

### iyzico hesabın henüz doğrulanmadıysa

1. **Şimdi, onay beklemeden test et:** https://sandbox-merchant.iyzipay.com adresinden ayrı bir *sandbox* (test) hesabı aç.
   Panelden test API anahtarı ve güvenlik anahtarını al; `IYZICO_API_KEY`, `IYZICO_SECRET_KEY` olarak gir,
   `IYZICO_BASE_URL=https://sandbox-api.iyzipay.com` bırak. Test kartlarıyla (iyzico dokümanındaki test kartı listesi)
   para çekilmeden tüm akışı dene.
2. **Canlı hesap için başvuruyu tamamla:** iyzico üye işyeri başvurusunda genellikle şirket veya şahıs şirketi bilgileri
   (vergi levhası), kimlik, IBAN ve yayında olan bir site istenir. Sitede mesafeli satış, iade, gizlilik/KVKK ve iletişim
   sayfaları bulunmalı; bunlar `/yasal/...` altında hazır, `SELLER_*` ayarlarıyla bilgilerin otomatik dolar.
3. **Onay gelince:** canlı anahtarları gir ve `IYZICO_BASE_URL=https://api.iyzipay.com` yap.

Anahtar girilmediği sürece site çalışır, Free plan kullanılır; Pro/Full düğmeleri "Ödeme yakında" görünür.

Notlar:
- Ödeme her ay kullanıcı tarafından yenilenir (otomatik kart çekimi yok). Otomatik yenileme için iyzico'nun ayrı "Abonelik" ürünü gerekir.
- iyzico alıcı için T.C. kimlik no ve adres ister. Bu uygulama bunları toplamaz; `IYZICO_BUYER_*` varsayılanları gönderilir. Bunun hesabın için uygun olduğunu iyzico ile teyit et.
- Yerelde ödeme almadan denemek için `PAYMENT_MODE=demo` (canlıda kullanma).

## Yayına alma (Render)

Depo kökündeki `render.yaml` hazır bir Render kurulumudur (Docker, kalıcı disk, sağlık kontrolü).

1. https://render.com hesabı aç, GitHub'ını bağla.
2. **New → Blueprint** → bu depoyu ve dalı seç.
3. Kurulum ekranında istenen değerleri gir: `ANTHROPIC_API_KEY`, `OWNER_EMAILS` (kendi e-postan), iyzico anahtarları
   (şimdilik sandbox), `SELLER_*` bilgileri. `OWNER_SIGNUP_CODE` otomatik üretilir; Render panelinde **Environment**
   sekmesinden görürsün.
4. Deploy bitince site `https://akinci-ai-xxxx.onrender.com` gibi bir adreste açılır. Kendi alan adını
   **Settings → Custom Domains** ile bağlayabilirsin.

Kalıcı disk (SQLite veritabanı) ücretli Render planı gerektirir; ücretsiz planda her yeniden başlatmada hesaplar silinir.
Docker çalıştıran başka bir yere (Railway, Fly.io, kendi VPS'in) de aynı `Dockerfile` ile kurulabilir; `/data` klasörünü
kalıcı diske bağla.

## Güvenlik

- Şifreler scrypt ile özetlenir; oturum çerezi HttpOnly + SameSite=Lax (+ HTTPS'te Secure).
- Giriş denemesi IP ve hesap başına sınırlı; şifre değişince diğer cihazlardaki oturumlar kapanır.
- Sıkı Content-Security-Policy, clickjacking ve MIME koruması (helmet), HTTPS'te HSTS.
- Başka siteden gelen API POST istekleri reddedilir; tüm SQL sorguları parametreli.
- Sahip e-postası kodsuz kayda kapalı; iyzico dönüşü sunucu tarafında doğrulanır ve bir sipariş iki kez işlenmez.
- Yazı tipleri siteden sunulur (Google Fonts yok); üçüncü taraf betik yok.
- Bağımlılıklarda bilinen açık yok (`npm audit`).

## Telefonda kullanım

- Arayüz telefona uyumludur; ana ekrana uygulama olarak eklenebilir (PWA).
- Aynı Wi-Fi'daki telefondan: sunucu açılışta `http://192.168.x.x:3000` adresini yazdırır, telefonun tarayıcısında aç.
- Ana ekrana ekleme (PWA kurulumu) yalnızca HTTPS'te çalışır; Render'a yayınlayınca otomatik HTTPS gelir. Telefonda siteyi aç → paylaş/menü → "Ana ekrana ekle".

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
| `ANTHROPIC_API_KEY` veya `GEMINI_API_KEY` | yapay zeka anahtarı (biri zorunlu) |
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
- `src/make-owner.ts` — kayıtlı hesabı site sahibi yapan komut
- `legal/` — yasal sayfa şablonları (`/yasal/...`)
- `src/providers/` — Claude ve Gemini sağlayıcıları
- `src/prompt.ts` — Akıncı'nın sistem talimatı (kod + Osmanlı)
- `public/` — arayüz: `app.js` (sohbet), `account.js` (giriş, planlar), `mascot.js`, `markdown.js`, `sw.js` (PWA)

## Notlar

- Sunucu tarafı yedek model (`fallbacks: "default"`) açık: güvenlik sınıflandırıcısı isteği reddederse API aynı istekte uygun yedek modele geçer.
- Sohbet geçmişi sunucu belleğinde tutulur; sunucu yeniden başlarsa sıfırlanır.
- Durdur butonu veya hata durumunda o tur geçmişe eklenmez.
