// Captura temprana del evento de instalación de la PWA. Vive en un archivo
// aparte (no inline) para cumplir la Content-Security-Policy "script-src 'self'".
window.__deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  window.__deferredInstallPrompt = e;
});
