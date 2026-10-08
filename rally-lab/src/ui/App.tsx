import { useApp } from './appStore';
import { Header } from './components/Header';
import { BannerLayer, PromptLayer, Toast } from './components/PromptLayer';
import { TabBar } from './components/TabBar';
import { CameraScreen } from './screens/CameraScreen';
import { ConnectScreen } from './screens/ConnectScreen';
import { ConsoleScreen } from './screens/ConsoleScreen';
import { DataScreen } from './screens/DataScreen';
import { AutoScreen } from './screens/AutoScreen';
import { DriveScreen } from './screens/DriveScreen';
import { MonitorScreen } from './screens/MonitorScreen';
import { TestsScreen } from './screens/TestsScreen';
import { RaceApp } from './racemode/RaceApp';
import { useLabVersion } from './hooks';
import { getLab } from './lab';

export function App() {
  const tab = useApp((s) => s.tab);
  useLabVersion();
  if (getLab().settings.ui === 'race') return <RaceApp />;
  return (
    <div className="app">
      <Header />
      <BannerLayer />
      <main className="main">
        {tab === 'connect' && <ConnectScreen />}
        {tab === 'monitor' && <MonitorScreen />}
        {tab === 'console' && <ConsoleScreen />}
        {tab === 'drive' && <DriveScreen />}
        {tab === 'auto' && <AutoScreen />}
        {tab === 'tests' && <TestsScreen />}
        {tab === 'camera' && <CameraScreen />}
        {tab === 'data' && <DataScreen />}
      </main>
      <TabBar />
      <PromptLayer />
      <Toast />
    </div>
  );
}
