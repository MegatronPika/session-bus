declare module 'fzstd' {
  /** Decompress a zstd frame (pure-JS/WASM, no native deps). */
  export function decompress(data: Uint8Array, out?: Uint8Array): Uint8Array;
}
