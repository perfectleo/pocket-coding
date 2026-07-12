import { config } from '../config.js';
// Ring buffer of recent server messages per session, for replay on reconnect.
export class Scrollback {
    bytes = 0;
    items = [];
    push(msg) {
        this.items.push(msg);
        this.bytes += JSON.stringify(msg).length;
        while (this.bytes > config.scrollbackBytes && this.items.length > 1) {
            const dropped = this.items.shift();
            this.bytes -= JSON.stringify(dropped).length;
        }
    }
    after(seq) {
        return this.items.filter((m) => m.seq > seq);
    }
    lastSeq() {
        return this.items.length > 0 ? this.items[this.items.length - 1].seq : 0;
    }
    clear() {
        this.items = [];
        this.bytes = 0;
    }
}
//# sourceMappingURL=scrollback.js.map