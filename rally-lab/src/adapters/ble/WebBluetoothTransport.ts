// Web Bluetooth (Chrome on Android) implementation of the Transport.
// The robot does not advertise the UART service, so we filter by name and
// list the service as optional.

import type { DeviceInfo, LinkState, Transport } from '../../core/types';

export const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
/** The phone writes here. */
export const UART_RX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
/** The robot indicates here. */
export const UART_TX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

type EventLog = (k: string, fields: Record<string, unknown>) => void;

export function webBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

export class WebBluetoothTransport implements Transport {
  readonly kind = 'web-bluetooth' as const;
  private device?: BluetoothDevice;
  private rx?: BluetoothRemoteGATTCharacteristic;
  private tx?: BluetoothRemoteGATTCharacteristic;
  private mode: 'withoutResponse' | 'withResponse' = 'withoutResponse';
  private dataCbs = new Set<(chunk: Uint8Array, t: number) => void>();
  private stateCbs = new Set<(s: LinkState, reason?: string) => void>();
  private log: EventLog = () => {};

  get writeMode(): 'withoutResponse' | 'withResponse' {
    return this.mode;
  }

  /** Lets the transport report details (write mode changes) into the session log. */
  setLog(log: EventLog): void {
    this.log = log;
  }

  get hasDevice(): boolean {
    return !!this.device;
  }

  async connect(): Promise<DeviceInfo> {
    if (!webBluetoothAvailable()) throw new Error('Web Bluetooth is not available. Use Chrome on Android over HTTPS or localhost.');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BBC micro:bit' }],
      optionalServices: [UART_SERVICE],
    });
    if (this.device && this.device !== device) {
      this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
    }
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    return this.open();
  }

  /** Re-open the link with the same BluetoothDevice (no chooser). */
  reconnect(): Promise<DeviceInfo> {
    if (!this.device) return Promise.reject(new Error('no device to reconnect to'));
    return this.open();
  }

  private async open(): Promise<DeviceInfo> {
    const device = this.device!;
    this.emit('connecting');
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(UART_SERVICE);
    this.rx = await service.getCharacteristic(UART_RX);
    this.tx = await service.getCharacteristic(UART_TX);
    this.tx.removeEventListener('characteristicvaluechanged', this.onValue);
    this.tx.addEventListener('characteristicvaluechanged', this.onValue);
    // startNotifications() also enables indications when that is what the characteristic offers.
    await this.tx.startNotifications();
    this.mode = this.rx.properties.writeWithoutResponse ? 'withoutResponse' : 'withResponse';
    this.log('ble.state', {
      state: 'gatt-ready',
      writeMode: this.mode,
      rxProps: propsOf(this.rx.properties),
      txProps: propsOf(this.tx.properties),
    });
    this.emit('connected');
    return { name: device.name ?? 'unknown', id: device.id };
  }

  async disconnect(): Promise<void> {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  async write(bytes: Uint8Array): Promise<void> {
    const rx = this.rx;
    if (!rx || !this.device?.gatt?.connected) throw new Error('GATT Server is disconnected');
    const buf = new Uint8Array(bytes); // own ArrayBuffer for BufferSource
    if (this.mode === 'withoutResponse') {
      try {
        await rx.writeValueWithoutResponse(buf);
        return;
      } catch (err) {
        if (!(err instanceof DOMException) || err.name !== 'NotSupportedError') throw err;
        this.mode = 'withResponse';
        this.log('ble.err', { op: 'write', message: `writeValueWithoutResponse rejected (${err.message}); using writeValueWithResponse` });
        this.log('ble.state', { state: 'write-mode', writeMode: this.mode });
      }
    }
    await rx.writeValueWithResponse(buf);
  }

  private onValue = (ev: Event) => {
    const now = performance.now();
    // event.timeStamp shares performance.now()'s time origin and is closer to arrival when the main thread is busy.
    const t = ev.timeStamp > 0 && ev.timeStamp <= now ? ev.timeStamp : now;
    const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (!v) return;
    const chunk = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    for (const cb of this.dataCbs) cb(chunk, t);
  };

  private onGattDisconnected = () => {
    this.emit('disconnected', 'gattserverdisconnected');
  };

  onData(cb: (chunk: Uint8Array, tMs: number) => void): () => void {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }

  onState(cb: (s: LinkState, reason?: string) => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }

  private emit(s: LinkState, reason?: string): void {
    for (const cb of this.stateCbs) cb(s, reason);
  }
}

function propsOf(p: BluetoothCharacteristicProperties): string[] {
  const keys: (keyof BluetoothCharacteristicProperties)[] = [
    'read', 'write', 'writeWithoutResponse', 'notify', 'indicate', 'broadcast', 'authenticatedSignedWrites',
  ];
  return keys.filter((k) => p[k] === true);
}
