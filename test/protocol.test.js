import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../web/src/scrcpy/control.js';
import { ByteQueue, StreamClosedError, u32 } from '../web/src/scrcpy/byte-queue.js';
import { annexBNalUnits, h264CodecString } from '../web/src/scrcpy/video.js';
import { buildServerCommand, normalizeOptions, socketService } from '../web/src/shared/scrcpy-options.js';
import { parseDeviceList, parseMdnsServices } from '../server/adb.js';

const hex = (u8) => Buffer.from(u8).toString('hex');

test('inject keycode: 14 bytes, big-endian', () => {
  const m = C.injectKeycode(C.KEY_ACTION.DOWN, 66, 2, 0x1000);
  assert.equal(hex(m), '00' + '00' + '00000042' + '00000002' + '00001000');
});

test('inject text', () => {
  assert.equal(hex(C.injectText('hi')), '01' + '00000002' + '6869');
});

test('inject touch: 32 bytes layout', () => {
  const m = C.injectTouch({ action: 0, pointerId: C.POINTER_ID_GENERIC_FINGER, x: 100, y: 200, width: 1080, height: 2400, pressure: 1 });
  assert.equal(m.length, 32);
  assert.equal(
    hex(m),
    '02' + '00' + 'fffffffffffffffe' + '00000064' + '000000c8' + '0438' + '0960' + 'ffff' + '00000000' + '00000000',
  );
});

test('inject scroll: 21 bytes, i16 fixed point of value/16', () => {
  const m = C.injectScroll({ x: 1, y: 2, width: 10, height: 20, hScroll: 0, vScroll: -16 });
  assert.equal(m.length, 21);
  assert.equal(hex(m), '03' + '00000001' + '00000002' + '000a' + '0014' + '0000' + '8000' + '00000000');
  const up = C.injectScroll({ x: 0, y: 0, width: 1, height: 1, hScroll: 0, vScroll: 16 });
  assert.equal(hex(up.subarray(15, 17)), '7fff');
});

test('set clipboard with paste flag', () => {
  const m = C.setClipboard('xin chào', true);
  const text = Buffer.from('xin chào', 'utf8');
  assert.equal(m[0], 9);
  assert.equal(m[9], 1);
  assert.equal(u32(m, 10), text.length);
  assert.deepEqual(Buffer.from(m.subarray(14)), text);
});

test('simple messages', () => {
  assert.equal(hex(C.backOrScreenOn(1)), '0401');
  assert.equal(hex(C.setDisplayPower(false)), '0a00');
  assert.equal(hex(C.simple(C.MSG.RESET_VIDEO)), '11');
  assert.equal(hex(C.startApp('com.x')), '1005' + Buffer.from('com.x').toString('hex'));
});

test('ByteQueue reads across chunk boundaries', async () => {
  const q = new ByteQueue();
  const p = q.read(5);
  q.push(Uint8Array.of(1, 2));
  q.push(Uint8Array.of(3));
  q.push(Uint8Array.of(4, 5, 6, 7));
  assert.deepEqual([...(await p)], [1, 2, 3, 4, 5]);
  assert.deepEqual([...(await q.read(2))], [6, 7]);
  q.end();
  await assert.rejects(q.read(1), StreamClosedError);
});

test('Annex B splitting and avc codec string', () => {
  const sps = [0x67, 0x64, 0x00, 0x28, 0xac];
  const pps = [0x68, 0xee, 0x3c, 0x80];
  const config = Uint8Array.from([0, 0, 0, 1, ...sps, 0, 0, 1, ...pps]);
  const nals = [...annexBNalUnits(config)].map((n) => [...n]);
  assert.deepEqual(nals, [sps, pps]);
  assert.equal(h264CodecString(config), 'avc1.640028');
});

test('options are clamped and whitelisted', () => {
  const o = normalizeOptions({ maxSize: '99999', videoBitRate: -5, audioCodec: 'evil;rm', audio: 'true', maxFps: 'x' });
  assert.equal(o.maxSize, 8192);
  assert.equal(o.videoBitRate, 250000);
  assert.equal(o.audioCodec, 'opus');
  assert.equal(o.audio, true);
  assert.equal(o.maxFps, 60);
});

test('server command line', () => {
  const cmd = buildServerCommand(0x1234abcd, { audio: false, maxSize: 1024 });
  assert.match(cmd, /^CLASSPATH=\/data\/local\/tmp\/screentodesktop-server\.jar app_process \/ com\.genymobile\.scrcpy\.Server 5\.0\.1 /);
  assert.match(cmd, / scid=1234abcd /);
  assert.match(cmd, / max_size=1024 /);
  assert.match(cmd, / audio=false /);
  assert.doesNotMatch(cmd, /audio_codec/);
  assert.match(cmd, /^[\w=./ -]+$/, 'no shell metacharacters');
  assert.equal(socketService(0xab), 'localabstract:scrcpy_000000ab');
});

test('packet header flags (v5: session=bit63, config=bit62, key=bit61)', async () => {
  const { parsePacketHeader } = await import('../web/src/scrcpy/client.js');
  const h = new Uint8Array(12);
  const dv = new DataView(h.buffer);
  dv.setBigUint64(0, (1n << 61n) | 123456789n);
  dv.setUint32(8, 4242);
  assert.deepEqual(parsePacketHeader(h), { config: false, keyFrame: true, pts: 123456789, length: 4242 });
  dv.setBigUint64(0, 1n << 62n);
  assert.equal(parsePacketHeader(h).config, true);
  assert.equal(parsePacketHeader(h).keyFrame, false);
});

test('parse adb devices -l output', () => {
  const list = parseDeviceList(
    'R58M12345\tdevice usb:1-1 product:beyond1 model:SM_G973F device:beyond1 transport_id:3\n' +
      '192.168.1.5:5555 unauthorized transport_id:4\n' +
      'abc   no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html]\n',
  );
  assert.equal(list.length, 3);
  assert.deepEqual(
    { serial: list[0].serial, state: list[0].state, model: list[0].model, transportId: list[0].transportId },
    { serial: 'R58M12345', state: 'device', model: 'SM G973F', transportId: '3' },
  );
  assert.equal(list[1].state, 'unauthorized');
  assert.equal(list[2].state, 'no permissions');
});

test('parse adb mdns services output', () => {
  const list = parseMdnsServices(
    'adb-10AEBS0G2D0029Y-Xy12Ab\t_adb-tls-pairing._tcp\t192.168.1.23:37159\n' +
      'adb-10AEBS0G2D0029Y-Xy12Ab\t_adb-tls-connect._tcp.\t192.168.1.23:41235\n' +
      'List of discovered mdns services\n',
  );
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    instance: 'adb-10AEBS0G2D0029Y-Xy12Ab',
    service: '_adb-tls-pairing._tcp',
    address: '192.168.1.23:37159',
    type: 'pairing',
    serialHint: '10AEBS0G2D0029Y',
  });
  assert.equal(list[1].type, 'connect');
  assert.equal(list[1].service, '_adb-tls-connect._tcp');
});
