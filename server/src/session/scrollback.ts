import { config } from '../config.js';
import type { ServerMessage } from '../protocol.js';

// Ring buffer of recent server messages per session, for replay on reconnect.
export class Scrollback {
  private bytes = 0;
  private items: ServerMessage[] = [];

  push(msg: ServerMessage): void {
    this.items.push(msg);
    this.bytes += JSON.stringify(msg).length;
    while (this.bytes > config.scrollbackBytes && this.items.length > 1) {
      const dropped = this.items.shift()!;
      this.bytes -= JSON.stringify(dropped).length;
    }
  }

  after(seq: number): ServerMessage[] {
    return this.items.filter((m) => m.seq > seq);
  }

  lastSeq(): number {
    return this.items.length > 0 ? this.items[this.items.length - 1].seq : 0;
  }

  clear(): void {
    this.items = [];
    this.bytes = 0;
  }
}
