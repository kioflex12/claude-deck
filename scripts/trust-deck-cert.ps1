#Requires -RunAsAdministrator
# Доверить код-подписной сертификат Claude Deck — РАЗОВО на машине, от имени администратора.
# После этого подписанный установщик Deck перестаёт быть «неизвестным издателем» и не блокируется SmartScreen.
# Запуск (в PowerShell «от администратора»):
#   powershell -ExecutionPolicy Bypass -File .\trust-deck-cert.ps1
$ErrorActionPreference = 'Stop'

# Берём публичный сертификат: рядом со скриптом (если репо склонирован), иначе тянем из GitHub.
$local = Join-Path $PSScriptRoot 'deck-codesign.cer'
if (Test-Path $local) {
  $cer = $local
} else {
  $cer = Join-Path $env:TEMP 'deck-codesign.cer'
  Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/kioflex12/claude-deck/main/scripts/deck-codesign.cer' -OutFile $cer
}

Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Write-Host 'Готово: сертификат Claude Deck доверен на этой машине. Установщик Deck теперь подписан и не блокируется.' -ForegroundColor Green
