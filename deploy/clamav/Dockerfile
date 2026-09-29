# Antivirüs tarayıcısı (ClamAV clamd). Resmî imaj; virüs tanımlarını freshclam kendisi günceller.
# Dosya başına 100 MB'a kadar yükleme tarandığı için akış ve dosya sınırları açıkça yükseltilir,
# TCP 3310 (yalnızca docker ağı içinden erişilir; dışarıya açılmaz).
FROM clamav/clamav:1.4
RUN set -eu; f=/etc/clamav/clamd.conf; \
    for kv in "TCPSocket 3310" "TCPAddr 0.0.0.0" "StreamMaxLength 150M" "MaxFileSize 150M" "MaxScanSize 400M"; do \
      k="${kv%% *}"; sed -i "/^#*[[:space:]]*${k}[[:space:]]/d" "$f"; echo "$kv" >> "$f"; \
    done; \
    grep -E '^(TCPSocket|TCPAddr|StreamMaxLength|MaxFileSize|MaxScanSize) ' "$f"
