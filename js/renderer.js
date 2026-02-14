/**
 * ============================================================
 * RENDERER (renderer.js)
 * ============================================================
 * Verwaltet Three.js WebGLRenderer, Kamera, Szene und Beleuchtung.
 * Erstellt den Retro-Look mit Nebel und gedämpftem Licht.
 * ============================================================
 */

import { WAND_HOEHE } from './maze-generator.js';

// ── Kamera-Einstellungen ────────────────────────────────────
const SICHTFELD = 75;            // Field of View in Grad
const CLIP_NAH = 0.1;            // Nahe Clip-Ebene
const CLIP_FERN = 50;            // Ferne Clip-Ebene
const AUGEN_HOEHE = WAND_HOEHE * 0.7; // Kamera auf Augenhöhe

// ── Blick-Empfindlichkeit ───────────────────────────────────
const MAUS_EMPFINDLICHKEIT = 0.002;
const MAX_NICK_WINKEL = Math.PI / 2 - 0.1; // Fast 90° nach oben/unten

// ── Renderer-Zustand ────────────────────────────────────────
let renderer = null;
let kamera = null;
let scene = null;
let spielerLicht = null;

// Blickwinkel (Euler-Rotation)
let gierWinkel = 0;  // Yaw – horizontale Drehung
let nickWinkel = 0;   // Pitch – vertikale Neigung

/**
 * Initialisiert den Three.js Renderer, die Szene und die Kamera.
 * @returns {{renderer: THREE.WebGLRenderer, kamera: THREE.PerspectiveCamera, scene: THREE.Scene}}
 */
export function initRenderer() {
    // ── Szene erstellen ─────────────────────────────────────
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e); // Dunkler Hintergrund

    // Nebel für Retro-Atmosphäre (begrenzte Sichtweite wie Wolfenstein)
    scene.fog = new THREE.Fog(0x0a0a15, 1, 20);

    // ── Kamera erstellen ────────────────────────────────────
    kamera = new THREE.PerspectiveCamera(
        SICHTFELD,
        window.innerWidth / window.innerHeight,
        CLIP_NAH,
        CLIP_FERN
    );
    kamera.position.y = AUGEN_HOEHE;

    // ── Renderer erstellen ──────────────────────────────────
    renderer = new THREE.WebGLRenderer({ antialias: false }); // Kein AA für Retro-Look
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Performance-Limit
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.BasicShadowMap; // Einfache Schatten = Retro

    // Canvas in DOM einbinden
    const container = document.getElementById('game-container');
    container.appendChild(renderer.domElement);

    // ── Beleuchtung ─────────────────────────────────────────
    // Ambiente Grundbeleuchtung (sehr gedimmt für düstere Atmosphäre)
    const ambientLicht = new THREE.AmbientLight(0x404060, 0.3);
    scene.add(ambientLicht);

    // Spieler-Licht (bewegt sich mit der Kamera)
    spielerLicht = new THREE.PointLight(0xffaa44, 1.5, 12);
    spielerLicht.position.copy(kamera.position);
    spielerLicht.castShadow = true;
    scene.add(spielerLicht);

    // ── Fenster-Resize ──────────────────────────────────────
    window.addEventListener('resize', onResize);

    console.log('[Renderer] Three.js Renderer initialisiert');
    return { renderer, kamera, scene };
}

/**
 * Aktualisiert die Kamera-Rotation basierend auf Maus-/Touch-Eingabe.
 * @param {{x: number, y: number}} lookDelta - Mausbewegung in Pixeln
 */
export function updateKameraRotation(lookDelta) {
    gierWinkel -= lookDelta.x * MAUS_EMPFINDLICHKEIT;
    nickWinkel -= lookDelta.y * MAUS_EMPFINDLICHKEIT;

    // Vertikale Rotation begrenzen (nicht über Kopf schauen)
    nickWinkel = Math.max(-MAX_NICK_WINKEL, Math.min(MAX_NICK_WINKEL, nickWinkel));

    // Euler-Rotation anwenden (Reihenfolge: YXZ für FPS-Kamera)
    kamera.rotation.order = 'YXZ';
    kamera.rotation.y = gierWinkel;
    kamera.rotation.x = nickWinkel;
}

/**
 * Gibt den aktuellen horizontalen Blickwinkel zurück.
 * @returns {number} Yaw-Winkel in Radians
 */
export function getGierWinkel() {
    return gierWinkel;
}

/**
 * Aktualisiert das Spieler-Licht auf die aktuelle Kameraposition.
 */
export function updateSpielerLicht() {
    if (spielerLicht && kamera) {
        spielerLicht.position.copy(kamera.position);
    }
}

/**
 * Rendert einen Frame.
 */
export function renderFrame() {
    renderer.render(scene, kamera);
}

/**
 * Gibt die Kamera zurück (für externe Module).
 * @returns {THREE.PerspectiveCamera}
 */
export function getKamera() {
    return kamera;
}

/**
 * Gibt die Szene zurück (für externe Module).
 * @returns {THREE.Scene}
 */
export function getScene() {
    return scene;
}

/**
 * Gibt den WebGLRenderer zurück.
 * @returns {THREE.WebGLRenderer}
 */
export function getRenderer() {
    return renderer;
}

/**
 * Callback für Fenster-Größenänderung.
 */
function onResize() {
    kamera.aspect = window.innerWidth / window.innerHeight;
    kamera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

export { AUGEN_HOEHE };
