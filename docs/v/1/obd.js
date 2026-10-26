// ELM327-compatible OBD2 adapter over Bluetooth Low Energy (Web Bluetooth).
// Works only in browsers with Web Bluetooth: on iPhone that means the Bluefy browser,
// not Safari. Classic-Bluetooth and Wi-Fi adapters cannot be reached from a web page.

const SERVICES = [
  0xfff0, 0xffe0, 0x18f0, 0xae30,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',   // Vgate iCar Pro BLE / OBDLink-style
  '0000fff0-0000-1000-8000-00805f9b34fb',
];

export class Obd {
  constructor(log) {
    this.log = log || (() => {});
    this.dev = null; this.rx = null; this.tx = null;
    this.buf = ''; this.waiter = null;
    this.polling = false;
    this.onSpeed = null;
    this.rateHz = 0;
  }

  static available() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }

  async connect(initCmds) {
    this.dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
    this.dev.addEventListener('gattserverdisconnected', () => { this.log('Adapter disconnected'); this.polling = false; });
    const gatt = await this.dev.gatt.connect();
    this.log(`Connected to ${this.dev.name || 'adapter'}`);
    const services = await gatt.getPrimaryServices();
    for (const s of services) {
      let chars = [];
      try { chars = await s.getCharacteristics(); } catch (e) { continue; }
      for (const c of chars) {
        const p = c.properties;
        if (!this.rx && (p.notify || p.indicate)) this.rx = c;
        if (!this.tx && (p.writeWithoutResponse || p.write)) this.tx = c;
      }
      if (this.rx && this.tx) break;
    }
    if (!this.rx || !this.tx) throw new Error('No ELM327 serial characteristic found on this adapter');
    await this.rx.startNotifications();
    this.rx.addEventListener('characteristicvaluechanged', (e) => {
      this.buf += new TextDecoder().decode(e.target.value);
      if (this.buf.includes('>') && this.waiter) {
        const out = this.buf.slice(0, this.buf.indexOf('>'));
        this.buf = this.buf.slice(this.buf.indexOf('>') + 1);
        const w = this.waiter; this.waiter = null; w(out);
      }
    });
    for (const cmd of initCmds) {
      const r = await this.send(cmd, cmd === 'ATZ' ? 2500 : 1500);
      this.log(`${cmd} → ${clean(r)}`);
    }
  }

  send(cmd, timeout = 1000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiter = null; resolve('TIMEOUT'); }, timeout);
      this.waiter = (s) => { clearTimeout(timer); resolve(s); };
      this.buf = '';
      const data = new TextEncoder().encode(cmd + '\r');
      (this.tx.properties.writeWithoutResponse ? this.tx.writeValueWithoutResponse(data) : this.tx.writeValue(data))
        .catch((e) => { clearTimeout(timer); this.waiter = null; resolve('ERR ' + e.message); });
    });
  }

  async poll() {
    this.polling = true;
    let n = 0, t0 = performance.now(), fails = 0;
    while (this.polling) {
      const r = await this.send('010D', 800);
      const kmh = parseSpeed(r);
      if (kmh != null) {
        fails = 0;
        this.onSpeed && this.onSpeed(kmh / 3.6, performance.now() / 1000);
        n++;
      } else if (++fails === 5) {
        this.log(`Speed PID 010D not answered: ${clean(r)}`);
      }
      const el = performance.now() - t0;
      if (el > 2000) { this.rateHz = n / (el / 1000); n = 0; t0 = performance.now(); }
      if (fails > 5) await new Promise((r) => setTimeout(r, 500));
    }
  }

  stop() { this.polling = false; try { this.dev && this.dev.gatt.disconnect(); } catch (e) { /* ignore */ } }
}

export function clean(s) { return (s || '').replace(/[\r\n]+/g, ' ').trim(); }

export function parseSpeed(s) {
  const hex = (s || '').replace(/\s+/g, '').toUpperCase();
  const i = hex.indexOf('410D');
  if (i < 0 || hex.length < i + 6) return null;
  const v = parseInt(hex.substr(i + 4, 2), 16);
  return Number.isFinite(v) ? v : null;
}
