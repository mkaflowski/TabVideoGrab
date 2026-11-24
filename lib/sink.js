// Miejsce składania pobranych segmentów: OPFS (na dysku), a gdy niedostępny — pamięć (Blob).
(function (g) {
  const VG = (g.VG = g.VG || {});

  class MemSink {
    constructor() {
      this.parts = [];
      this.pending = [];
      this.pendingSize = 0;
      this.size = 0;
    }
    async write(u8) {
      this.pending.push(u8);
      this.pendingSize += u8.length;
      this.size += u8.length;
      if (this.pendingSize >= 32 * 1024 * 1024) this._flush();
    }
    _flush() {
      if (this.pending.length) {
        this.parts.push(new Blob(this.pending));
        this.pending = [];
        this.pendingSize = 0;
      }
    }
    async finish(type) {
      this._flush();
      return new Blob(this.parts, { type: type || 'application/octet-stream' });
    }
    async cleanup() {
      this.parts = [];
      this.pending = [];
    }
    async abort() {
      await this.cleanup();
    }
  }

  class OpfsSink {
    constructor(root, name, fh, w) {
      Object.assign(this, { root, name, fh, w, size: 0 });
    }
    async write(u8) {
      await this.w.write(u8);
      this.size += u8.length;
    }
    async finish() {
      await this.w.close();
      return this.fh.getFile();
    }
    async cleanup() {
      try {
        await this.root.removeEntry(this.name);
      } catch (e) {}
    }
    async abort() {
      try {
        await this.w.abort();
      } catch (e) {}
      await this.cleanup();
    }
  }

  VG.createSink = async function (name) {
    try {
      if (navigator.storage && navigator.storage.getDirectory) {
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(name, { create: true });
        if (fh.createWritable) {
          const w = await fh.createWritable();
          return new OpfsSink(root, name, fh, w);
        }
      }
    } catch (e) {
      console.warn('[TabVideoGrab] OPFS unavailable, storing in memory:', e);
    }
    return new MemSink();
  };

  VG.clearOpfs = async function () {
    try {
      const root = await navigator.storage.getDirectory();
      const names = [];
      for await (const [n] of root.entries()) names.push(n);
      for (const n of names) await root.removeEntry(n).catch(() => {});
    } catch (e) {}
  };
})(globalThis);
