// A push-based byte queue with async exact reads. Both transports (WebSocket
// relay and WebUSB) feed raw socket bytes into one of these per scrcpy socket.
export class StreamClosedError extends Error {
  constructor(message = 'Stream closed') {
    super(message);
    this.name = 'StreamClosedError';
  }
}

export class ByteQueue {
  #chunks = [];
  #offset = 0; // read offset into #chunks[0]
  #length = 0;
  #ended = false;
  #error = null;
  #waiter = null;
  bytesIn = 0;

  push(chunk) {
    if (this.#ended || !chunk.length) return;
    this.#chunks.push(chunk);
    this.#length += chunk.length;
    this.bytesIn += chunk.length;
    this.#wake();
  }

  end(error = null) {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    this.#wake();
  }

  get ended() {
    return this.#ended;
  }

  #wake() {
    const w = this.#waiter;
    this.#waiter = null;
    w?.();
  }

  /** Resolves with exactly n bytes (a view; copy it if you keep it around). */
  async read(n) {
    while (this.#length < n) {
      if (this.#ended) throw this.#error ?? new StreamClosedError();
      await new Promise((resolve) => {
        this.#waiter = resolve;
      });
    }
    return this.#take(n);
  }

  #take(n) {
    this.#length -= n;
    const first = this.#chunks[0];
    if (first.length - this.#offset >= n) {
      const out = first.subarray(this.#offset, this.#offset + n);
      this.#offset += n;
      if (this.#offset === first.length) {
        this.#chunks.shift();
        this.#offset = 0;
      }
      return out;
    }
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.#chunks[0];
      const available = chunk.length - this.#offset;
      const count = Math.min(available, n - filled);
      out.set(chunk.subarray(this.#offset, this.#offset + count), filled);
      filled += count;
      this.#offset += count;
      if (this.#offset === chunk.length) {
        this.#chunks.shift();
        this.#offset = 0;
      }
    }
    return out;
  }
}

export const u16 = (b, o) => (b[o] << 8) | b[o + 1];
export const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
