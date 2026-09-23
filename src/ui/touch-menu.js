// Main menu on touch devices (src/ui/menu.js adds .gkm-touch in touch mode): no keyboard hints, finger-sized targets,
// and on phone-sized screens a compact layout — landscape: aircraft and a horizontally scrolling card strip on the
// left, start points and a big "Uç" on the right; portrait: one column with the start list scrolling and "Uç" at the
// bottom. The menu's --u scale (min 0.66 of the 1440×900 design) is pinned to ≈ 0.9 on phones so text stays legible.
export const MENU_TOUCH_CSS = `
.gkm.gkm-touch .gkm-foot > span:not(.gkm-foot-r), .gkm.gkm-touch .gkm-card-key, .gkm.gkm-touch .gkm-fly-k kbd, .gkm.gkm-touch .gkm-ctrl { display: none; }
.gkm.gkm-touch .gkm-foot-r { margin-left: auto; }
.gkm.gkm-touch .gkm-foot-r button { min-height: 40px; }
.gkm.gkm-touch .gkm-spawn { min-height: 46px; }
.gkm.gkm-touch .gkm-spawns { -webkit-overflow-scrolling: touch; overscroll-behavior: contain; touch-action: pan-y; }
.gkm.gkm-touch .gkm-card:hover { transform: none; }
.gkm.gkm-touch .gkm-card[aria-checked="true"] { transform: translateY(calc(-5 * var(--u1))); }
.gkm-touch-note { display: none; }

@media (max-height: 520px), (max-width: 560px) {
  .gkm.gkm-touch { --u: .9 !important; }
  .gkm.gkm-touch .gkm-ui { grid-template-columns: minmax(0, 1fr) minmax(250px, 41%); grid-template-rows: auto auto minmax(0, 1fr) auto; column-gap: 14px;
    padding: max(10px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); }
  .gkm.gkm-touch .gkm-over { display: none; }
  .gkm.gkm-touch .gkm-brand h1 { margin: 0; font-size: 30px; line-height: 1; }
  .gkm.gkm-touch .gkm-sub { margin-top: 3px; font-size: 10px; letter-spacing: .26em; }
  .gkm.gkm-touch .gkm-hero { grid-row: 2; align-self: start; margin-top: 8px; }
  .gkm.gkm-touch .gkm-hero-art { display: none; }
  .gkm.gkm-touch .gkm-hero-text { flex: 1 1 auto; }
  .gkm.gkm-touch .gkm-chip { font-size: 9.5px; padding: 3px 9px; }
  .gkm.gkm-touch .gkm-hero h2 { margin: 6px 0 3px; font-size: 22px; }
  .gkm.gkm-touch .gkm-blurb { font-size: 12.5px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .gkm.gkm-touch .gkm-specs, .gkm.gkm-touch .gkm-extra { display: none; }
  .gkm.gkm-touch .gkm-cards { grid-row: 3; align-self: end; min-width: 0; }
  .gkm.gkm-touch .gkm-cards-h { margin-bottom: 4px; }
  .gkm.gkm-touch .gkm-h { font-size: 10px; }
  .gkm.gkm-touch .gkm-row { display: flex; gap: 8px; overflow-x: auto; overflow-y: hidden; scroll-snap-type: x proximity; padding: 8px 2px 4px; margin: -6px -2px 0;
    scrollbar-width: none; touch-action: pan-x; -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain; }
  .gkm.gkm-touch .gkm-row::-webkit-scrollbar { display: none; }
  .gkm.gkm-touch .gkm-card { flex: 0 0 clamp(118px, 17vw, 150px); scroll-snap-align: start; border-radius: 12px; }
  .gkm.gkm-touch .gkm-card[aria-checked="true"] { transform: translateY(-3px); }
  .gkm.gkm-touch .gkm-card-body { padding: 5px 8px 7px; }
  .gkm.gkm-touch .gkm-card-name { font-size: 12.5px; }
  .gkm.gkm-touch .gkm-card-role { font-size: 10.5px; }
  .gkm.gkm-touch .gkm-card-cat { font-size: 8.5px; top: 6px; right: 6px; padding: 2px 6px; }
  .gkm.gkm-touch .gkm-foot { grid-row: 4; margin-top: 8px; }
  .gkm.gkm-touch .gkm-foot-r button { min-height: 36px; padding: 6px 12px; font-size: 12.5px !important; }
  .gkm.gkm-touch .gkm-side { grid-column: 2; grid-row: 1 / span 4; border-radius: 16px; }
  .gkm.gkm-touch .gkm-side-top { padding: 10px 14px 2px; }
  .gkm.gkm-touch .gkm-sel { margin-top: 3px; font-size: 15px; }
  .gkm.gkm-touch .gkm-spawns { padding: 0 8px 6px; }
  .gkm.gkm-touch .gkm-group-h { font-size: 11.5px; padding: 6px 8px 3px; }
  .gkm.gkm-touch .gkm-spawn { grid-template-columns: 42px minmax(0, 1fr) auto; gap: 8px; min-height: 44px; padding: 4px 8px; }
  .gkm.gkm-touch .gkm-sp-id { height: 28px; font-size: 13px; }
  .gkm.gkm-touch .gkm-sp-txt { font-size: 13px; }
  .gkm.gkm-touch .gkm-sp-txt small { font-size: 11px; }
  .gkm.gkm-touch .gkm-fly-wrap { padding: 6px 10px 10px; }
  .gkm.gkm-touch .gkm-fly { padding: 10px 14px 10px 18px; border-radius: 13px; }
  .gkm.gkm-touch .gkm-fly-t { font-size: 26px; }
  .gkm.gkm-touch .gkm-fly-s { font-size: 11px; max-width: 100%; }
  .gkm.gkm-touch .gkm-fly-k svg { width: 24px; height: 24px; }
  .gkm.gkm-touch .gkm-credit { display: none; }
  .gkm.gkm-touch .gkm-scene { opacity: .8; }
}
@media (max-height: 345px) {
  .gkm.gkm-touch .gkm-blurb { display: none; }
  .gkm.gkm-touch .gkm-hero h2 { margin-bottom: 0; }
}
@media (max-width: 560px) and (orientation: portrait) {
  .gkm.gkm-touch .gkm-ui { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto minmax(0, 1fr) auto; row-gap: 0;
    padding-top: max(14px, env(safe-area-inset-top)); }
  .gkm.gkm-touch .gkm-brand h1 { font-size: 34px; }
  .gkm.gkm-touch .gkm-hero { grid-row: 2; margin-top: 10px; }
  .gkm.gkm-touch .gkm-blurb { -webkit-line-clamp: 3; }
  .gkm.gkm-touch .gkm-cards { grid-row: 3; margin-top: 12px; }
  .gkm.gkm-touch .gkm-card { flex-basis: 40vw; }
  .gkm.gkm-touch .gkm-side { grid-column: 1; grid-row: 4; margin-top: 12px; min-height: 0; }
  .gkm.gkm-touch .gkm-foot { grid-row: 5; justify-content: center; }
  .gkm.gkm-touch .gkm-foot-r { margin: 0 auto; }
  .gkm.gkm-touch .gkm-touch-note { display: block; margin: 0 14px 8px; font-size: 12px; font-weight: 650; text-align: center; color: var(--gk-teal); }
  .gkm.gkm-touch .gkm-scene { opacity: .45; }
}
`;
