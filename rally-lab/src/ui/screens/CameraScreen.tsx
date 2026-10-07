import { useEffect, useState } from 'react';
import { CalibrateView } from '../camera/CalibrateView';
import { cameraController as cc } from '../camera/controller';
import { MapView } from '../camera/MapView';
import { MarkersView } from '../camera/MarkersView';
import { PointCollector } from '../camera/PointCollector';
import { SetupView } from '../camera/SetupView';
import { TrackView } from '../camera/TrackView';
import { useLabVersion } from '../hooks';

type Sub = 'setup' | 'calibrate' | 'map' | 'markers' | 'track';
const SUBS: { id: Sub; label: string }[] = [
  { id: 'setup', label: 'Setup' },
  { id: 'calibrate', label: 'Calibrate' },
  { id: 'map', label: 'Map' },
  { id: 'markers', label: 'Markers' },
  { id: 'track', label: 'Track' },
];

export function CameraScreen() {
  useLabVersion();
  const [sub, setSub] = useState<Sub>(() => (cc.tracking ? 'track' : 'setup'));
  useEffect(() => {
    if (cc.pointRequest) setSub('track');
  }, []);
  if (cc.pointRequest) return <PointCollector />;
  return (
    <div>
      <div className="row" style={{ marginBottom: 10, flexWrap: 'nowrap', overflowX: 'auto' }}>
        {SUBS.map((s) => (
          <button key={s.id} className={`chip ${sub === s.id ? 'chip-on' : ''}`} style={{ flex: 'none' }} onClick={() => setSub(s.id)}>{s.label}</button>
        ))}
      </div>
      {sub === 'setup' && <SetupView />}
      {sub === 'calibrate' && <CalibrateView />}
      {sub === 'map' && <MapView />}
      {sub === 'markers' && <MarkersView />}
      {sub === 'track' && <TrackView />}
    </div>
  );
}
