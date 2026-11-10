// User-facing server messages in Vietnamese and English.
// The web app sends its language in the X-Lang header (HTTP), the `lang`
// query parameter (SSE) or the `lang` field of the WebSocket start message.

const M = {
  vi: {
    pushing: 'Đang đẩy scrcpy-server lên thiết bị…',
    starting: 'Đang khởi động server trên thiết bị…',
    serverExited: 'scrcpy-server đã thoát trước khi kết nối',
    serverTimeout: 'Hết thời gian chờ scrcpy-server',
    serverStopped: 'scrcpy-server đã dừng',
    socketClosed: 'Thiết bị đã đóng kết nối {name}',
    deviceNotFound: 'Không tìm thấy thiết bị',
    deviceState: 'Thiết bị đang ở trạng thái "{state}"',
    badSerial: 'Serial không hợp lệ',
    authRequired: 'Cần đăng nhập',
    wrongPassword: 'Sai mật khẩu',
    retryAfter: 'Thử lại sau {s}s',
    badAddress: 'Địa chỉ không hợp lệ (ví dụ 192.168.1.10:5555)',
    badAddressShort: 'Địa chỉ không hợp lệ',
    badPairAddress: 'Địa chỉ ghép đôi phải có dạng IP:cổng, ví dụ 192.168.1.23:37159',
    badCode: 'Mã ghép đôi gồm 6 chữ số',
    pairedHint: 'Đã ghép đôi. Bật "Gỡ lỗi không dây" trên điện thoại; máy sẽ tự hiện trong danh sách, hoặc nhập IP:cổng hiển thị ở đó vào ô Kết nối.',
    fileTooLarge: 'File quá lớn',
    installFailed: 'Cài đặt thất bại',
    ADB_NOT_FOUND: 'Không tìm thấy adb ("{path}"). Cài Android platform-tools hoặc đặt biến ADB_PATH.',
    PAIR_TIMEOUT: 'Hết thời gian chờ. Hộp thoại ghép đôi trên điện thoại còn mở không?',
    wrongCode: 'Sai mã ghép đôi hoặc kết nối bị ngắt. Mã và cổng ghép đôi đổi mỗi lần mở lại hộp thoại trên điện thoại.',
    noPairClient: 'Không kết nối được tới điện thoại. Kiểm tra IP:cổng ghép đôi và hai máy cùng mạng Wi-Fi.',
    notPaired: '{m}\nĐiện thoại chưa ghép đôi với server này: dùng "Ghép đôi Wi-Fi".',
    cannotConnect: '{m}\nKiểm tra IP:cổng (xem trong Gỡ lỗi không dây) và hai máy cùng mạng.',
  },
  en: {
    pushing: 'Pushing scrcpy-server to the device…',
    starting: 'Starting the server on the device…',
    serverExited: 'scrcpy-server exited before connecting',
    serverTimeout: 'Timed out waiting for scrcpy-server',
    serverStopped: 'scrcpy-server stopped',
    socketClosed: 'The device closed the {name} connection',
    deviceNotFound: 'Device not found',
    deviceState: 'The device is "{state}"',
    badSerial: 'Invalid serial',
    authRequired: 'Sign-in required',
    wrongPassword: 'Wrong password',
    retryAfter: 'Try again in {s}s',
    badAddress: 'Invalid address (e.g. 192.168.1.10:5555)',
    badAddressShort: 'Invalid address',
    badPairAddress: 'The pairing address must be IP:port, e.g. 192.168.1.23:37159',
    badCode: 'The pairing code has 6 digits',
    pairedHint: 'Paired. Turn on "Wireless debugging" on the phone; it will show up in the list, or enter the IP:port shown there in the Connect box.',
    fileTooLarge: 'File too large',
    installFailed: 'Install failed',
    ADB_NOT_FOUND: 'adb not found ("{path}"). Install Android platform-tools or set ADB_PATH.',
    PAIR_TIMEOUT: 'Timed out. Is the pairing dialog still open on the phone?',
    wrongCode: 'Wrong pairing code or the connection dropped. The code and port change every time the pairing dialog is reopened on the phone.',
    noPairClient: 'Cannot reach the phone. Check the pairing IP:port and that both are on the same Wi-Fi network.',
    notPaired: '{m}\nThis phone is not paired with this server: use "Pair over Wi-Fi".',
    cannotConnect: '{m}\nCheck the IP:port (shown under Wireless debugging) and that both are on the same network.',
  },
};

export function normalizeLang(value) {
  return String(value ?? '').toLowerCase().startsWith('en') ? 'en' : 'vi';
}

/** Language of an HTTP request (X-Lang header, then ?lang=). */
export function langOf(req, url = null) {
  return normalizeLang(req.headers['x-lang'] || url?.searchParams.get('lang'));
}

export function t(lang, key, params = {}) {
  const text = M[lang]?.[key] ?? M.vi[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? '').toString());
}

/** Turns adb errors (English, from the adb server) into short explanations. */
export function explainAdbError(lang, err) {
  if (err?.code && M.vi[err.code]) return t(lang, err.code, err.params);
  const m = String(err?.message ?? err ?? '');
  if (/Wrong password|connection was dropped/i.test(m)) return t(lang, 'wrongCode');
  if (/Unable to start pairing client|unable to create pairing client/i.test(m)) return t(lang, 'noPairClient');
  if (/parse address|Invalid port/i.test(m)) return t(lang, 'badAddressShort');
  if (/failed to authenticate|authentication/i.test(m)) return t(lang, 'notPaired', { m });
  if (/failed to connect|cannot connect|No route|refused|timed out/i.test(m)) return t(lang, 'cannotConnect', { m });
  return m;
}
