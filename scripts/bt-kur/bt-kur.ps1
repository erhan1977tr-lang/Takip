# TAKİP — Günün BT kurunu gönderen görev (4.2.30). Windows Görev Zamanlayıcı her gün 07:00, 12:30 ve 15:00'te çalıştırır
# (kurulum: kur.ps1). BT kur sayfasını alır ve OLDUĞU GİBİ TAKİP'e gönderir; kuru okuyan ve denetleyen TAKİP'tir
# (server/fx/bt-auto.js). Neden bu bilgisayar: BT, sunucumuzun ve veri merkezlerinin IP adreslerini engelliyor.
# Olmazsa 10 dakikada bir, en çok 1 saat yeniden dener. Anahtar bu klasördeki anahtar.dat dosyasında, Windows'un kullanıcıya
# bağlı şifrelemesiyle (DPAPI) durur: başka kullanıcı / bilgisayar çözemez. Günlük: bu klasördeki bt-kur.log (son 500 satır).
# -Once: tek deneme (elle deneme / kurulum için; yeniden deneme beklemesi yok)
param([switch]$Once)
$ErrorActionPreference = 'Stop'
$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$BtUrl   = 'https://www.bancatransilvania.ro/curs-valutar'
$Takip   = 'https://takip.gkh.ro/kur/bt'
$LogFile = Join-Path $Here 'bt-kur.log'
$Tries   = $(if ($Once) { 1 } else { 7 })      # ilk deneme + 6 yeniden deneme
$WaitSec = 600    # 10 dakika

function Log($m) {
  $line = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $m
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
  $all = Get-Content -Path $LogFile -Encoding UTF8
  if ($all.Count -gt 500) { $all | Select-Object -Last 500 | Set-Content -Path $LogFile -Encoding UTF8 }
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# Dosyanın sonundaki satır sonu / boşluk ConvertTo-SecureString'i bozar: önce kırp
$enc = (Get-Content -Path (Join-Path $Here 'anahtar.dat') -Raw).Trim()
$sec = ConvertTo-SecureString -String $enc
$Token = ([Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))).Trim()

$BrowserUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'

function ErrText($err) {
  $code = $null
  if ($err.Exception.Response) { $code = [int]$err.Exception.Response.StatusCode }
  $body = ''
  try { $body = (New-Object IO.StreamReader($err.Exception.Response.GetResponseStream())).ReadToEnd() } catch {}
  return @{ Code = $code; Text = "HTTP $code $($body.Substring(0, [Math]::Min(200, $body.Length))) $($err.Exception.Message)" }
}

# Edge'in açık sayfasında bir JavaScript ifadesini çalıştırıp sonucunu döndürür (Chrome DevTools Protocol, yalnızca 127.0.0.1)
function CdpEval($wsUrl, $expr) {
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $cts = New-Object System.Threading.CancellationTokenSource 20000
  try {
    $ws.ConnectAsync([Uri]$wsUrl, $cts.Token).Wait()
    $msg = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $expr; returnByValue = $true } } | ConvertTo-Json -Compress -Depth 5
    $out = [Text.Encoding]::UTF8.GetBytes($msg)
    $ws.SendAsync([ArraySegment[byte]]::new($out), [Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).Wait()
    $ms = New-Object IO.MemoryStream
    $buf = New-Object byte[] 65536
    do {
      $r = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), $cts.Token).Result
      $ms.Write($buf, 0, $r.Count)
    } while (-not $r.EndOfMessage)
  } finally { $ws.Dispose() }
  Add-Type -AssemblyName System.Web.Extensions
  $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $ser.MaxJsonLength = [int]::MaxValue
  $o = $ser.DeserializeObject([Text.Encoding]::UTF8.GetString($ms.ToArray()))
  return $o['result']['result']['value']
}

# BT sayfası: önce tarayıcı başlıklarıyla doğrudan; BT bunu reddederse (bot koruması) bilgisayardaki Edge ayrı bir profille,
# ekranın dışında NORMAL pencerede açılır ve sayfa oradan okunur (görünmez/headless Edge'i de BT reddediyor). Kullanıcının
# kendi Edge penceresine dokunulmaz; iş bitince yalnızca bu profille açılan Edge kapatılır.
function Get-BtPage {
  try {
    $page = Invoke-WebRequest -Uri $BtUrl -UseBasicParsing -TimeoutSec 30 -UserAgent $BrowserUA -Headers @{
      'Accept' = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      'Accept-Language' = 'ro-RO,ro;q=0.9,en;q=0.8'
    }
    $ms = New-Object IO.MemoryStream
    $page.RawContentStream.Position = 0
    $page.RawContentStream.CopyTo($ms)
    return ,$ms.ToArray()
  } catch {
    Log "BT doğrudan alınamadı: $((ErrText $_).Text) — Edge ile deneniyor"
  }
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
    Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $edge) { throw 'Edge bulunamadı' }
  $edgeProfile = Join-Path $Here 'edge-profil'
  $port = 9333
  Start-Process -FilePath $edge -ArgumentList @(
    "--remote-debugging-port=$port", "--user-data-dir=`"$edgeProfile`"", '--no-first-run', '--no-default-browser-check',
    '--window-position=-32000,-32000', '--window-size=1280,900', $BtUrl) | Out-Null
  $html = $null
  try {
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 3
      try { $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json" -TimeoutSec 5 } catch { continue }
      $t = $targets | Where-Object { $_.type -eq 'page' -and $_.url -like '*bancatransilvania*' } | Select-Object -First 1
      if (-not $t) { continue }
      try { $html = CdpEval $t.webSocketDebuggerUrl 'document.documentElement.outerHTML' } catch { continue }
      if ($html -and $html.Contains('in-unitatile-bt')) { break }
    }
  } finally {
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains($edgeProfile) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  if (-not $html) { throw 'Edge: sayfa okunamadı' }
  if (-not $html.Contains('in-unitatile-bt')) {
    if ($html -match 'Access Denied') { throw 'Edge: BT erişimi reddetti (Access Denied)' }
    throw 'Edge: kur tablosu sayfada yok'
  }
  return ,([Text.Encoding]::UTF8.GetBytes('<!DOCTYPE html>' + $html))
}

for ($i = 1; $i -le $Tries; $i++) {
  $bytes = $null
  try {
    $bytes = Get-BtPage
  } catch {
    Log "deneme ${i}: BT sayfası alınamadı: $($_.Exception.Message)"
  }
  if ($bytes) {
    try {
      $res = Invoke-WebRequest -Uri $Takip -Method Post -UseBasicParsing -TimeoutSec 30 -Body $bytes `
        -ContentType 'text/html; charset=utf-8' -Headers @{ Authorization = "Bearer $Token" }
      Log "deneme ${i}: TAKİP yanıtı $($res.Content)"
      exit 0
    } catch {
      $e = ErrText $_
      Log "deneme ${i}: TAKİP reddetti: $($e.Text)"
      # Anahtar yanlış / otomatik okuma kapalı: yeniden denemenin anlamı yok
      if ($e.Code -eq 401 -or $e.Code -eq 409) { exit 2 }
    }
  }
  if ($i -lt $Tries) { Start-Sleep -Seconds $WaitSec }
}
exit 1
