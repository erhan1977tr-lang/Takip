# TAKİP — Günün BT kurunu gönderen görev (4.2.30). Windows Görev Zamanlayıcı her gün 07:00, 12:30 ve 15:00'te çalıştırır
# (kurulum: kur.ps1). BT kur sayfasını alır ve OLDUĞU GİBİ TAKİP'e gönderir; kuru okuyan ve denetleyen TAKİP'tir
# (server/fx/bt-auto.js). Neden bu bilgisayar: BT, sunucumuzun ve veri merkezlerinin IP adreslerini engelliyor.
# Olmazsa 10 dakikada bir, en çok 1 saat yeniden dener. Anahtar bu klasördeki anahtar.dat dosyasında, Windows'un kullanıcıya
# bağlı şifrelemesiyle (DPAPI) durur: başka kullanıcı / bilgisayar çözemez. Günlük: bu klasördeki bt-kur.log (son 500 satır).
$ErrorActionPreference = 'Stop'
$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$BtUrl   = 'https://www.bancatransilvania.ro/curs-valutar'
$Takip   = 'https://takip.gkh.ro/kur/bt'
$LogFile = Join-Path $Here 'bt-kur.log'
$Tries   = 7      # ilk deneme + 6 yeniden deneme
$WaitSec = 600    # 10 dakika

function Log($m) {
  $line = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $m
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
  $all = Get-Content -Path $LogFile -Encoding UTF8
  if ($all.Count -gt 500) { $all | Select-Object -Last 500 | Set-Content -Path $LogFile -Encoding UTF8 }
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$sec = Get-Content -Path (Join-Path $Here 'anahtar.dat') -Raw | ConvertTo-SecureString
$Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))

for ($i = 1; $i -le $Tries; $i++) {
  try {
    $page = Invoke-WebRequest -Uri $BtUrl -UseBasicParsing -TimeoutSec 30 -Headers @{ 'Accept-Language' = 'ro-RO,ro;q=0.9' }
    $ms = New-Object IO.MemoryStream
    $page.RawContentStream.Position = 0
    $page.RawContentStream.CopyTo($ms)
    $bytes = $ms.ToArray()
    $res = Invoke-WebRequest -Uri $Takip -Method Post -UseBasicParsing -TimeoutSec 30 -Body $bytes `
      -ContentType 'text/html; charset=utf-8' -Headers @{ Authorization = "Bearer $Token" }
    Log "deneme $i: TAKİP yanıtı $($res.Content)"
    exit 0
  } catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    $body = ''
    try { $body = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch {}
    Log "deneme $i başarısız: HTTP $code $($body.Substring(0, [Math]::Min(200, $body.Length))) $($_.Exception.Message)"
    # Anahtar yanlış / otomatik okuma kapalı: yeniden denemenin anlamı yok
    if ($code -eq 401 -or $code -eq 409) { exit 2 }
  }
  if ($i -lt $Tries) { Start-Sleep -Seconds $WaitSec }
}
exit 1
