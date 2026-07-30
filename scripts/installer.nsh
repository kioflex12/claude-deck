; Кастомный NSIS-хук: при установке доверяем self-signed код-сертификат Deck, чтобы подпись стала валидной
; и последующие запуски/авто-обновления шли без «неизвестного издателя»/блока SmartScreen.
; Ставим в ПОЛЬЗОВАТЕЛЬСКИЕ хранилища (-user) — без прав администратора, чтобы сохранить per-user установку
; и МОЛЧАЛИВЫЕ авто-обновления (perMachine потребовал бы UAC на каждое обновление).
; На ПЕРВОЙ установке Windows один раз спросит подтверждение на добавление корневого сертификата — это защита ОС,
; тихо добавить недоверенный корень без админа нельзя. После подтверждения все дальнейшие обновления идут молча.
!macro customInstall
  SetOutPath "$PLUGINSDIR"
  File "/oname=deck-codesign.cer" "${PROJECT_DIR}\scripts\deck-codesign.cer"
  nsExec::Exec 'certutil -addstore -user -f "TrustedPublisher" "$PLUGINSDIR\deck-codesign.cer"'
  nsExec::Exec 'certutil -addstore -user -f "Root" "$PLUGINSDIR\deck-codesign.cer"'
!macroend

!macro customUnInstall
  ; best-effort: убрать доверенный серт при удалении приложения
  nsExec::Exec 'certutil -delstore -user "TrustedPublisher" "Claude Deck (kioflex)"'
  nsExec::Exec 'certutil -delstore -user "Root" "Claude Deck (kioflex)"'
!macroend
