import { useApp, type Tab } from '../appStore';
import { useLabVersion } from '../hooks';
import { getLab } from '../lab';

// lab: only shown with "Lab tools" on (Data tab).
const TABS: { id: Tab; label: string; icon: string; lab?: boolean }[] = [
  { id: 'connect', label: 'Connect', icon: '⏻' },
  { id: 'monitor', label: 'Monitor', icon: '◉', lab: true },
  { id: 'console', label: 'Console', icon: '›_', lab: true },
  { id: 'drive', label: 'Drive', icon: '✥' },
  { id: 'auto', label: 'Auto', icon: '⟲' },
  { id: 'tests', label: 'Tests', icon: '⚗', lab: true },
  { id: 'camera', label: 'Camera', icon: '◫', lab: true },
  { id: 'data', label: 'Data', icon: '≡' },
];

export function TabBar() {
  useLabVersion();
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  const labTools = getLab().settings.labTools;
  return (
    <nav className="tabbar">
      {TABS.filter((t) => labTools || !t.lab || t.id === tab).map((t) => (
        <button key={t.id} className={`tab ${tab === t.id ? 'tab-active' : ''}`} onClick={() => setTab(t.id)}>
          <span className="tab-icon">{t.icon}</span>
          <span className="tab-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
