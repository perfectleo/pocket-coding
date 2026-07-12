// Pocket Coding protocol — shared between server and app.
// Versioned: bump PROTOCOL_VERSION on breaking changes.
export const PROTOCOL_VERSION = 1;
// ---------- Danger detection ----------
export const DANGEROUS_PATTERNS = [
    /\brm\s+-rf?\s+[\/~]/i,
    /\bgit\s+push\s+(-f|--force)/i,
    /\bcurl\s+[^|]*\|\s*(sh|bash|zsh)/i,
    /\bwget\s+[^|]*\|\s*(sh|bash|zsh)/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    />\s*\/dev\/sd[a-z]/i,
    /\bchmod\s+-R\s+777\b/i,
    /\bsudo\b/i,
    /\:\(\)\s*\{/i,
];
export function isDangerousCommand(cmd) {
    return DANGEROUS_PATTERNS.some((re) => re.test(cmd));
}
//# sourceMappingURL=protocol.js.map