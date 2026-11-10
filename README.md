# ScreenToDesktop

Hiển thị và điều khiển điện thoại Android ngay trên trình duyệt (tương tự Vysor), tự host được: chạy trên máy cá nhân hoặc deploy lên máy chủ riêng.

**Dùng thử ngay (chế độ WebUSB, Chrome/Edge):** https://zionnocyper.github.io/screentodesktop/ — cắm điện thoại vào máy tính, bấm *Thêm thiết bị USB*.

- Video H.264 độ trễ thấp, giải mã bằng **WebCodecs**, tối đa 120 fps
- Điều khiển bằng chuột, cảm ứng đa điểm, bàn phím (gõ tiếng Việt qua clipboard), cuộn, Ctrl+kéo để zoom 2 ngón
- Âm thanh (Android 11+), đồng bộ clipboard hai chiều, chụp màn hình
- Kéo-thả file: APK được cài đặt, file khác vào thư mục `Download`
- Nút Back / Home / Đa nhiệm / âm lượng / nguồn / xoay / thông báo / tắt màn hình điện thoại
- ADB qua Wi-Fi (một nút bấm để rút cáp)
- Có mật khẩu đăng nhập khi deploy lên server

Phần chạy trên điện thoại là [scrcpy-server](https://github.com/Genymobile/scrcpy) v5.0.1 (được đẩy lên tự động, không cần cài app nào trên điện thoại).

## Hai cách kết nối

```
 (1) WebUSB — điện thoại cắm vào máy đang mở trình duyệt
     Trình duyệt ──USB/ADB──▶ điện thoại            (không cần server, chỉ cần file tĩnh)

 (2) Server — điện thoại cắm vào máy chạy server (hoặc ADB Wi-Fi)
     Trình duyệt ◀──WebSocket──▶ Node.js ──adb (tcp:5037)──▶ điện thoại
```

| | WebUSB | Server |
|---|---|---|
| Trình duyệt | Chrome / Edge (máy tính, Android) | Chrome, Edge, Firefox 130+, Safari 17+ |
| Yêu cầu | HTTPS hoặc `http://localhost` | Node.js 20+ và `adb` trên máy chủ |
| Xem từ xa | Không (điện thoại phải cắm vào máy đang xem) | Có, từ bất kỳ đâu |

Cả hai dùng chung phần giải mã và điều khiển; trang web tự hiện chế độ nào khả dụng.

## Chuẩn bị điện thoại

1. Cài đặt → Thông tin điện thoại → chạm 7 lần vào **Số hiệu bản tạo** để mở Tùy chọn nhà phát triển.
2. Tùy chọn nhà phát triển → bật **Gỡ lỗi USB**. (Xiaomi: bật thêm *Gỡ lỗi USB (Cài đặt bảo mật)* để điều khiển được.)
3. Cắm cáp, mở khóa máy và bấm **Cho phép** khi được hỏi.

## Chạy trên máy cá nhân

Cần [Node.js](https://nodejs.org) 20+ và [Android platform-tools](https://developer.android.com/tools/releases/platform-tools) (`adb` có trong PATH, hoặc đặt `ADB_PATH`).

```bash
npm install        # tự tải scrcpy-server và kiểm tra SHA-256
npm run build
npm start          # http://localhost:8000
```

Mặc định server chỉ nghe trên `127.0.0.1`. Để xem từ máy khác trong mạng LAN:

```bash
HOST=0.0.0.0 ACCESS_PASSWORD=mat-khau npm start
# Windows PowerShell:
$env:HOST="0.0.0.0"; $env:ACCESS_PASSWORD="mat-khau"; npm start
```

### Lưu ý cho WebUSB

- Chỉ một chương trình được giữ thiết bị USB tại một thời điểm. Nếu báo *thiết bị đang bị chương trình khác giữ*, chạy `adb kill-server` (và tắt server ScreenToDesktop trên cùng máy nếu đang chạy), rồi thử lại.
- Windows: cần driver WinUSB cho giao diện ADB (thường đã có sẵn; nếu không, cài *Google USB Driver*).
- Linux: cần udev rule cho phép user truy cập thiết bị (gói `android-sdk-platform-tools-common` hoặc tương đương).

## Deploy lên máy chủ

### Docker (khuyên dùng)

Sửa `ACCESS_PASSWORD` trong `docker-compose.yml`, rồi:

```bash
docker compose up -d --build
```

- `privileged` + mount `/dev/bus/usb` để adb trong container thấy điện thoại cắm USB vào máy chủ.
- Volume `adb-keys` giữ khóa ADB để điện thoại không hỏi lại quyền sau mỗi lần khởi động lại.
- Muốn dùng adb server có sẵn trên máy chủ thay vì adb trong container: chạy `adb -a nodaemon server start` trên máy chủ, đặt `ADB_HOST=host.docker.internal` (Linux: thêm `extra_hosts: ["host.docker.internal:host-gateway"]`) và bỏ `privileged`.

### Không dùng Docker (systemd)

```ini
# /etc/systemd/system/screentodesktop.service
[Unit]
Description=ScreenToDesktop
After=network.target

[Service]
WorkingDirectory=/opt/screentodesktop
Environment=HOST=127.0.0.1 PORT=8000 ACCESS_PASSWORD=doi-mat-khau TRUST_PROXY=1
ExecStart=/usr/bin/node server/index.js
Restart=always
User=android

[Install]
WantedBy=multi-user.target
```

### HTTPS (bắt buộc cho WebUSB, nên có cho mọi trường hợp)

Caddy tự lấy chứng chỉ Let's Encrypt và tự chuyển tiếp WebSocket:

```
phone.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 1h;
    client_max_body_size 2g;
}
```

Đặt `TRUST_PROXY=1` khi chạy sau proxy. Hoặc cho Node tự phục vụ HTTPS bằng `TLS_CERT` / `TLS_KEY`.

### Chỉ deploy file tĩnh (WebUSB)

Thư mục `dist/` sau khi `npm run build` là một website tĩnh hoàn chỉnh (kèm `scrcpy-server`), đưa lên bất kỳ hosting HTTPS nào (Nginx, GitHub Pages, Cloudflare Pages…). Khi không có server Node, trang chỉ hiện phần WebUSB.

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `HOST` | `127.0.0.1` | Địa chỉ lắng nghe (`0.0.0.0` để mở ra mạng) |
| `PORT` | `8000` | Cổng HTTP |
| `ACCESS_PASSWORD` | *(trống)* | Mật khẩu đăng nhập. **Bắt buộc** khi mở ra ngoài localhost |
| `ALLOWED_HOSTS` | *(trống)* | Tên miền được phép khi *không* đặt mật khẩu (chống DNS rebinding), ví dụ `pc.local` |
| `TRUST_PROXY` | `0` | `1` khi đứng sau reverse proxy (đọc `X-Forwarded-*`) |
| `TLS_CERT`, `TLS_KEY` | | Đường dẫn chứng chỉ để chạy HTTPS trực tiếp |
| `ADB_HOST`, `ADB_PORT` | `127.0.0.1`, `5037` | adb server cần kết nối |
| `ADB_PATH` | `adb` | Đường dẫn file `adb` (dùng để tự khởi động adb server) |
| `MAX_UPLOAD_MB` | `2048` | Giới hạn kích thước file kéo-thả |

## ADB qua Wi-Fi

- Điện thoại đang cắm USB vào server: bấm nút **Wi-Fi** trên thẻ thiết bị → server bật `adb tcpip 5555` và tự kết nối tới IP của điện thoại; sau đó rút cáp được.
- Hoặc nhập `IP:cổng` vào ô **Kết nối** (Android 11+ dùng *Gỡ lỗi không dây* thì cần ghép nối một lần bằng `adb pair IP:cổng` trên máy chủ).

## Điều khiển

| Thao tác | Tác dụng |
|---|---|
| Chuột trái / chạm | Chạm, vuốt (cảm ứng đa điểm trên màn hình cảm ứng) |
| Chuột phải | Quay lại (bật màn hình nếu đang tắt) |
| Chuột giữa | Màn hình chính |
| Nút chuột Back / Forward | Quay lại / Đa nhiệm |
| Con lăn | Cuộn |
| Ctrl + kéo | Thu phóng 2 ngón (quanh tâm màn hình) |
| Gõ phím | Nhập vào điện thoại; ký tự ngoài ASCII (tiếng Việt, emoji) được dán qua clipboard |
| Ctrl + V | Dán clipboard máy tính vào điện thoại |
| Ctrl + C trên điện thoại | Tự chép về clipboard máy tính (nếu bật đồng bộ clipboard) |

Nút **Chất lượng** ở góc trên chỉnh độ phân giải, bitrate, FPS, âm thanh, chế độ chỉ xem, giải mã GPU…

## Phát triển

```bash
npm run dev:server   # server Node (tự khởi động lại khi sửa) — cổng 8000
npm run dev          # Vite dev server — http://localhost:5173 (proxy /api, /ws sang 8000)
npm test             # unit test giao thức + test tích hợp với adb server giả lập
```

Cấu trúc:

```
server/                Node: HTTP + WebSocket, client giao thức ADB, khởi chạy scrcpy-server
web/src/scrcpy/        Giao thức scrcpy v5, giải mã H.264 (WebCodecs), âm thanh, điều khiển
web/src/transport/     server.js (WebSocket) và webusb.js (ADB qua WebUSB, dùng Tango)
web/src/shared/        Tùy chọn / dòng lệnh scrcpy dùng chung cho server và trình duyệt
web/public/            scrcpy-server (đẩy lên điện thoại), favicon
```

## Khắc phục sự cố

- **Thiết bị "Chưa cho phép"**: mở khóa điện thoại, bấm *Cho phép* trong hộp thoại gỡ lỗi USB. Không thấy hộp thoại: rút ra cắm lại, hoặc *Thu hồi ủy quyền gỡ lỗi USB* rồi thử lại.
- **Không điều khiển được (chỉ xem)**: trên Xiaomi bật *Gỡ lỗi USB (Cài đặt bảo mật)*; kiểm tra tùy chọn *Cho phép điều khiển*.
- **Không có âm thanh**: cần Android 11+; với Android 11 cần mở khóa màn hình khi bắt đầu phiên.
- **Hình giật / trễ khi xem qua Internet**: giảm bitrate (2–4 Mbps) và độ phân giải trong *Chất lượng*.
- **Màn hình đen với một số ứng dụng**: ứng dụng bật chống quay màn hình (ngân hàng, Netflix…), đây là giới hạn của Android.

## Bảo mật

Ai vào được trang này là điều khiển được điện thoại. Server đã có sẵn: đăng nhập bằng mật khẩu (cookie `HttpOnly`, `SameSite=Strict`, giới hạn số lần thử sai), chặn WebSocket/POST khác nguồn gốc, chặn DNS rebinding khi không đặt mật khẩu. Khi deploy ra Internet: luôn đặt `ACCESS_PASSWORD` mạnh và dùng HTTPS.

## Giấy phép bên thứ ba

- scrcpy-server © Genymobile, Romain Vimont — Apache License 2.0 (`web/public/scrcpy-server.LICENSE.txt`)
- Tango / ya-webadb (`@yume-chan/*`) — MIT
- ws — MIT
