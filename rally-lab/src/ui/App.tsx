import { useApp } from './appStore';
import { Header } from './components/Header';
import { BannerLayer, PromptLayer, Toast } from './components/PromptLayer';
import { TabBar } from './components/TabBar';
import { CameraScreen } from './screens/CameraScreen';
import { ConnectScreen } from './screens/ConnectScreen';
import { ConsoleScreen } from './screens/ConsoleScreen';
import { DataScreen } from './screens/DataScreen';
import { DriveScreen } from './screens/DriveScreen';
import { MonitorScreen } from './screens/MonitorScreen';
import { TestsScreen } from './screens/TestsScreen';

export function App() {
  const tab = useApp((s) => s.tab);
  return (
    <div className="app">
      <Header />
      <BannerLayer />
      <main className="main">
        {tab === 'connect' && <ConnectScreen />}
        {tab === 'monitor' && <MonitorScreen />}
        {tab === 'console' && <ConsoleScreen />}
        {tab === 'drive' && <DriveScreen />}
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
