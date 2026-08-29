type RateLimitEntry = {
  startedAt: number;
  count: number;
};

export type RateLimiterOptions = {
  windowMs: number;
  maxRequests: number;
  maxKeys: number;
};

/**
 * Limitador de ventana fija deliberadamente pequeño y sin dependencias. Se usa
 * como defensa de primera línea para el endpoint MCP de una sola instancia.
 * La clave es la IP que Caddy ha validado y reenviado al proceso loopback.
 */
export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(private readonly options: RateLimiterOptions) {}

  allow(key: string, now = Date.now()): boolean {
    this.prune(now);
    const entry = this.entries.get(key);
    if (!entry || now - entry.startedAt >= this.options.windowMs) {
      if (!entry && this.entries.size >= this.options.maxKeys) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey !== undefined) this.entries.delete(oldestKey);
      }
      this.entries.delete(key);
      this.entries.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (entry.count >= this.options.maxRequests) return false;
    entry.count += 1;
    // Mantiene las entradas recientes al final del Map para poder desalojar la
    // más antigua si llegan demasiadas IPs distintas en una misma ventana.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return true;
  }

  retryAfterSeconds(key: string, now = Date.now()): number {
    const startedAt = this.entries.get(key)?.startedAt ?? now;
    const remaining = this.options.windowMs - (now - startedAt);
    return Math.max(1, Math.ceil(remaining / 1000));
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.startedAt >= this.options.windowMs)
        this.entries.delete(key);
    }
  }
}
