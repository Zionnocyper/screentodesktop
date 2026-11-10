// Downloads the scrcpy-server binary that runs on the phone and verifies its checksum.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SCRCPY_VERSION, SERVER_FILENAME } from '../web/src/shared/scrcpy-options.js';

const SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536';
const URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/${SERVER_FILENAME}`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'web', 'public', SERVER_FILENAME);

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

if (fs.existsSync(target) && sha(fs.readFileSync(target)) === SHA256) {
  console.log(`${SERVER_FILENAME} đã có sẵn.`);
  process.exit(0);
}

console.log(`Đang tải ${URL}`);
const res = await fetch(URL);
if (!res.ok) {
  console.error(`Tải thất bại: HTTP ${res.status}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const actual = sha(buf);
if (actual !== SHA256) {
  console.error(`Sai checksum: ${actual} (mong đợi ${SHA256})`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, buf);
console.log(`Đã lưu ${path.relative(root, target)} (${buf.length} bytes)`);
