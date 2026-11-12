import { memo } from 'react';
import { ListMusic } from 'lucide-react';
import { NAV_ITEMS } from './navItems.js';

// Navegación inferior en móvil.
function MobileNav({ activeTab, onNavigate, showQueue, onToggleQueue }) {
  return (
    <nav className="mobile-bottom-nav" aria-label="Navegación">
      {NAV_ITEMS.map(({ id, mobileLabel, Icon }) => (
        <button key={id} className={`mobile-nav-btn ${activeTab === id ? 'active' : ''}`} onClick={() => onNavigate(id)} aria-current={activeTab === id ? 'page' : undefined}>
          <Icon size={20} />
          <span>{mobileLabel}</span>
        </button>
      ))}
      <button className={`mobile-nav-btn ${showQueue ? 'active' : ''}`} onClick={onToggleQueue} aria-pressed={showQueue}>
        <ListMusic size={20} />
        <span>Cola</span>
      </button>
    </nav>
  );
}

export default memo(MobileNav);
