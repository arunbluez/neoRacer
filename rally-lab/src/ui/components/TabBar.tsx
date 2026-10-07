import { useApp, type Tab } from '../appStore';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'connect', label: 'Connect', icon: '⏻' },
  { id: 'monitor', label: 'Monitor', icon: '◉' },
  { id: 'console', label: 'Console', icon: '›_' },
  { id: 'drive', label: 'Drive', icon: '✥' },
  { id: 'tests', label: 'Tests', icon: '⚗' },
  { id: 'camera', label: 'Camera', icon: '◫' },
  { id: 'data', label: 'Data', icon: '≡' },
];

export function TabBar() {
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  return (
    <nav className="tabbar">
      {TABS.map((t) => (
        <button key={t.id} className={`tab ${tab === t.id ? 'tab-active' : ''}`} onClick={() => setTab(t.id)}>
          <span className="tab-icon">{t.icon}</span>
          <span className="tab-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
