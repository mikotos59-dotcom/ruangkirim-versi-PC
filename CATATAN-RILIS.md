# Catatan rilis

## 0.1.0
- Kirim file dan folder antar PC dan HP di WiFi yang sama, tanpa internet dan tanpa server.
- Perangkat lain di WiFi yang sama muncul otomatis. Kalau router memblok pencarian, pakai Tambah lewat IP.
- Enkripsi ujung ke ujung: ECDH P-256 + AES-256-GCM. Kunci baru dibuat untuk setiap kiriman.
- Setiap kiriman masuk minta izin **Terima / Tolak**, lengkap dengan tanda **Perangkat dikenal** atau **Belum dikenal**.
- Pasangkan perangkat (jadi dikenal) dengan dua cara:
  - Pindai kode QR di PC dari HP. Kodenya sekali pakai dan berlaku 5 menit.
  - Cocokkan kode 6 angka yang muncul di kedua layar.
- Pengaturan:
  - Terima otomatis dari perangkat dikenal.
  - Hanya terima dari perangkat dikenal.
  - Folder penyimpanan.
  - Tetap berjalan di tray.
- Seret file dari Explorer ke kartu perangkat. Ada progres, kecepatan, sisa waktu, dan tombol Batal di kedua sisi.
