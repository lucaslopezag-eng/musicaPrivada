import { Home, Search, Sparkles, BarChart2, Smartphone } from 'lucide-react';

// Pestañas principales (barra lateral y navegación móvil).
export const NAV_ITEMS = [
  { id: 'home', label: 'Inicio', mobileLabel: 'Inicio', Icon: Home },
  { id: 'search', label: 'Buscar', mobileLabel: 'Buscar', Icon: Search },
  { id: 'themes', label: 'Temas', mobileLabel: 'Temas', Icon: Sparkles },
  { id: 'wrapped', label: 'Resumen', mobileLabel: 'Estadísticas', Icon: BarChart2 },
  { id: 'install', label: 'Instalar App', mobileLabel: 'Instalar', Icon: Smartphone },
];
