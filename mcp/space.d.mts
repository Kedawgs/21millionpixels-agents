/**
 * Types for space.mjs, so the Worker can import the MCP server's copy.
 *
 * One implementation, two consumers: a model over stdio and Pix in the Worker
 * answer "where does this fit" identically because they run the same code.
 * The .mjs stays the source so mcp/ remains a standalone package.
 */
export function buildSat(bytes: Uint8Array, w: number, h: number): Uint32Array
export function rectPainted(
  sat: Uint32Array, w: number, x: number, y: number, rw: number, rh: number,
): number
export function findFit(
  sat: Uint32Array, w: number, h: number, rw: number, rh: number, maxPainted: number, limit?: number,
): Array<{ x: number; y: number; painted: number; dist2: number }>
export function findLargestSquare(
  sat: Uint32Array, w: number, h: number, maxPaintedFraction?: number,
): { x: number; y: number; w: number; h: number; painted: number } | null
