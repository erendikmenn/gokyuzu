// Game shell UI (contract §6.6): menu, loading screen, screen-space HUD and the camera rig.
export { createMenu } from './menu.js';
export { createLoadingScreen } from './loading.js';
export { createHUD } from './hud.js';
export { createCameraRig, CAMERA_NAMES } from './camera.js';
// onboarding: first-flight tutorial, opening key card, contextual hints (not part of the §6.6 contract)
export { createOnboarding } from './tutorial.js';
