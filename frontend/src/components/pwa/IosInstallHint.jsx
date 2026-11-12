import { useState } from 'react';
import { Share, SquarePlus, X } from 'lucide-react';
import { isInstalledPWA } from '../../pwa.js';
import { safeGetItem, safeSetItem } from '../../lib/storage.js';

// iOS no emite beforeinstallprompt: la instalación es Compartir → "Añadir a
// pantalla de inicio". Este aviso lo explica en iPhone/iPad (solo si la app no
// está ya instalada). Fuera de Safari (Chrome, navegadores internos de
// Instagram/Facebook...) se pide abrir el enlace en Safari.
const DISMISS_KEY = 'hideIosInstallHint';

function detectIos() {
  const ua = navigator.userAgent || '';
  const isIos = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIos) return null;
  const otherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram|Line\/|WhatsApp/.test(ua);
  return { safari: !otherBrowser };
}

export default function IosInstallHint() {
  const [ios] = useState(() => (isInstalledPWA() || safeGetItem(DISMISS_KEY) ? null : detectIos()));
  const [open, setOpen] = useState(true);
  if (!ios || !open) return null;

  const dismiss = () => { safeSetItem(DISMISS_KEY, '1'); setOpen(false); };

  return (
    <div className="ios-install-hint" role="dialog" aria-label="Instalar la app en el iPhone">
      <button type="button" className="ios-install-hint-close" aria-label="No volver a mostrar" onClick={dismiss}><X size={16} /></button>
      <h4>Instala la app en tu iPhone</h4>
      {ios.safari ? (
        <ol>
          <li>Toca <span className="ios-ico"><Share size={18} /></span> <b>Compartir</b> (en la barra de Safari; si no lo ves, toca antes <b>···</b>).</li>
          <li>Elige <span className="ios-ico"><SquarePlus size={18} /></span> <b>Añadir a pantalla de inicio</b> y pulsa <b>Añadir</b>.</li>
        </ol>
      ) : (
        <p style={{ margin: 0 }}>Abre este enlace en <b>Safari</b> para poder instalarla (desde este navegador no se puede).</p>
      )}
    </div>
  );
}
