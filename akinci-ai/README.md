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

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Anthropic API anahtarı (zorunlu) |
| `AKINCI_MODEL` | `claude-opus-5-5` | Kullanılacak model |
| `AKINCI_EFFORT` | `high` | `low` / `medium` / `high` / `xhigh` / `max` |
| `PORT` | `3000` | Sunucu portu |

## Yapı

- `src/server.ts` — Express sunucu, `/api/chat` SSE akışı, oturum başına bellekte sohbet geçmişi
- `public/mascot.js` — SVG piksel maskot ve durum kontrolü
- `public/style.css` — arayüz ve maskot animasyonları
- `public/markdown.js` — güvenli (HTML kaçırmalı) Markdown işleyici
- `public/app.js` — sohbet istemcisi, uyku zamanlayıcısı

## Notlar

- Sunucu tarafı yedek model (`fallbacks: "default"`) açık: güvenlik sınıflandırıcısı isteği reddederse API aynı istekte uygun yedek modele geçer.
- Sohbet geçmişi sunucu belleğinde tutulur; sunucu yeniden başlarsa sıfırlanır.
- Durdur butonu veya hata durumunda o tur geçmişe eklenmez.
