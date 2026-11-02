# Ruang Kirim (PC)

Kirim file PC ↔ HP lewat WiFi yang sama, terenkripsi ujung ke ujung. Versi HP: proyek `RuangKirim-HP`.
Detail protokol ada di `PROTOKOL.md`.

- `npm install` lalu `npm start` untuk mencoba; dirakit jadi exe lewat Pabrik SuS.
- Tampilan di `app/` dipakai juga oleh versi HP (disalin ke `app/src/main/assets/ui/` di proyek HP).
- Saat pertama dibuka, Windows Firewall akan bertanya: izinkan untuk **jaringan Pribadi**. Kalau WiFi rumah tercatat sebagai jaringan Publik di Windows, ubah ke Pribadi supaya HP bisa menemukan PC.
