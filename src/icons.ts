// Hugeicons (free, MIT) stroke icons, inlined as SVG markup so they render offline and under
// Obsidian's CSP — no webfont/CDN. Bodies pulled from the Hugeicons free set (24×24, currentColor).
// `icon(name)` returns an <svg> sized to 1em, so callers control size via font-size.

const BODIES: Record<string, string> = {
  "clock-01":
    `<g fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l2 2"/></g>`,
  "minus-sign":
    `<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 12H4"/>`,
  "arrow-expand-01":
    `<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16.5 3.266c.844-.012 3.64-.593 4.234 0s.012 3.39 0 4.234m-.228-4.009l-7.004 7.005M3.266 16.5c-.012.845-.593 3.641 0 4.234s3.39.012 4.234 0m3.002-7.236l-7.004 7.005"/>`,
  "cancel-01":
    `<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18 6L6 18m12 0L6 6"/>`,
  "arrow-up-01":
    `<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 15s-4.42-6-6-6s-6 6-6 6"/>`,
  "stop":
    `<path fill="currentColor" stroke="none" d="M4 12c0-3.28 0-4.919.814-6.081a4.5 4.5 0 0 1 1.105-1.105C7.08 4 8.72 4 12 4s4.919 0 6.081.814a4.5 4.5 0 0 1 1.105 1.105C20 7.08 20 8.72 20 12s0 4.919-.814 6.081a4.5 4.5 0 0 1-1.105 1.105C16.92 20 15.28 20 12 20s-4.919 0-6.081-.814a4.5 4.5 0 0 1-1.105-1.105C4 16.92 4 15.28 4 12Z"/>`,
  "text-check":
    `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"><path stroke-linejoin="round" d="M11 16.5s1.5.5 2.25 2.5c0 0 3.573-5.833 6.75-7"/><path d="M4 5h14M4 10h11M4 15h4"/></g>`,
  "magic-wand-02":
    `<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m17.5 17.5l4 4M5.972 3.793L9.318 4.92c.462.16 1.165.055 1.562-.228l2.347-1.674c1.502-1.07 2.745-.432 2.746 1.423l.013 3.14c.002.53.372 1.19.823 1.477l2.398 1.504c1.897 1.191 1.681 2.602-.48 3.15l-3.01.76c-.543.137-1.104.698-1.248 1.248l-.76 3.01c-.541 2.156-1.964 2.371-3.149.48l-1.503-2.398c-.287-.45-.947-.82-1.478-.823l-3.14-.013c-1.847-.007-2.491-1.244-1.422-2.746l1.674-2.348c.277-.391.382-1.093.221-1.556L3.785 5.98c-.609-1.819.374-2.802 2.187-2.187"/>`,
  "search-01":
    `<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m17 17l4 4m-2-10a8 8 0 1 0-16 0a8 8 0 0 0 16 0"/>`,
  "note-01":
    `<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16.5 2v3m-9-3v3M12 2v3m1-1.5h-2c-3.3 0-4.95 0-5.975 1.025S4 7.2 4 10.5V15c0 3.3 0 4.95 1.025 5.975S7.7 22 11 22h2c3.3 0 4.95 0 5.975-1.025S20 18.3 20 15v-4.5c0-3.3 0-4.95-1.025-5.975S16.3 3.5 13 3.5M8 15h4m-4-4h8"/>`,
  "tick-02":
    `<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m5 14l3.5 3.5L19 6.5"/>`,
};

export type IconName = keyof typeof BODIES;

export function icon(name: IconName): string {
  return `<svg viewBox="0 0 24 24" width="1em" height="1em" class="buddy-ic">${BODIES[name]}</svg>`;
}

// Official Claude "spark" mark. currentColor so it inherits text/accent color like the rest.
export const CLAUDE_SPARK =
  `<svg viewBox="0 0 256 257" width="1em" height="1em" class="buddy-ic" fill="currentColor">` +
  `<path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"/></svg>`;
