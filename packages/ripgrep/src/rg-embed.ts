/**
 * Embedded ripgrep binary path.
 *
 * When built with `bun build --compile`, the rg binary is embedded at
 * `/$bunfs/root/rg-dqx81qav.`. For Node-only runs, this path won't exist
 * and `resolveRgPath()` will fall through to download or PATH resolution.
 */
export const rgPath: string = "/$bunfs/root/rg-dqx81qav.";
