# TAKİP — BT kur görevinin kurulumu (bir kez). Bu klasörde, kuru gönderecek Windows kullanıcısıyla çalıştırın:
#   PowerShell'i açın → cd <bu klasör> → powershell -ExecutionPolicy Bypass -File .\kur.ps1
# 1) TAKİP → Entegrasyonlar → "Otomatik okuma" → "Yeni anahtar oluştur" ile aldığınız anahtarı sorar ve şifreli saklar.
# 2) "TAKIP BT kuru" görevini oluşturur: her gün 07:00, 12:30, 15:00; bilgisayar o saatte kapalıysa açılınca hemen çalışır.
# 3) Bir kez deneme gönderir; sonucu ekranda ve bt-kur.log'da görürsünüz.
# Kaldırmak için: Unregister-ScheduledTask -TaskName 'TAKIP BT kuru' -Confirm:$false
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tok = Read-Host -Prompt 'TAKİP anahtarı (btk_ ile başlar)' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($tok))
if (-not $plain.StartsWith('btk_')) { Write-Host 'Anahtar btk_ ile başlamalı.' -ForegroundColor Red; exit 1 }
$tok | ConvertFrom-SecureString | Set-Content -Path (Join-Path $Here 'anahtar.dat') -Encoding ASCII

$script = Join-Path $Here 'bt-kur.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$triggers = @('07:00', '12:30', '15:00') | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 75) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'TAKIP BT kuru' -Action $action -Trigger $triggers -Settings $settings `
  -Description 'Günün BT kurunu (În unitățile BT, EUR Vânzare) TAKİP''e gönderir.' -Force | Out-Null
Write-Host "Görev oluşturuldu. Şimdi bir deneme gönderiliyor..." -ForegroundColor Green
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script
Get-Content -Path (Join-Path $Here 'bt-kur.log') -Tail 3
