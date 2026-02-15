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
const AUGEN_HOEHE = WAND_HOEHE * 0.6; // Kamera auf Augenhöhe (1.4 Einheiten)

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

// Pickups für Animationen
const aktivePickups = [];

/**
 * Initialisiert den Three.js Renderer, die Szene und die Kamera.
 * Singleton: Verhindert Mehrfacherstellung.
 * @returns {{renderer: THREE.WebGLRenderer, kamera: THREE.PerspectiveCamera, scene: THREE.Scene}}
 */
export function initRenderer() {
    if (renderer) {
        console.log('[Renderer] Nutze bestehende Instanz (Cleanup)');
        // Szene selektiv leeren
        const zuEntfernen = [];
        scene.children.forEach(obj => {
            // Kamera und Spielerlicht NIEMALS löschen/disposen
            if (obj === kamera || obj === spielerLicht) return;
            zuEntfernen.push(obj);
        });

        zuEntfernen.forEach(obj => {
            scene.remove(obj);
            // Ressourcen nur disposen wenn es kein Player-Teil ist
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
                if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
                else obj.material.dispose();
            }
        });

        // Grundbeleuchtung wieder hinzufügen
        const ambientLicht = new THREE.AmbientLight(0x404060, 0.3);
        scene.add(ambientLicht);

        return { renderer, kamera, scene };
    }

    // ── Szene erstellen ─────────────────────────────────────
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e); // Dunkler Hintergrund (Wolfenstein Blau)

    // Nebel für Retro-Atmosphäre
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
    renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.BasicShadowMap;

    const container = document.getElementById('game-container');
    container.innerHTML = ''; // Canvas-Leichen entfernen
    container.appendChild(renderer.domElement);

    // ── Beleuchtung ─────────────────────────────────────────
    const ambientLicht = new THREE.AmbientLight(0x404060, 0.3);
    scene.add(ambientLicht);

    spielerLicht = new THREE.PointLight(0xffaa44, 1.5, 12);
    spielerLicht.position.set(0, AUGEN_HOEHE, 0);
    spielerLicht.castShadow = true;
    scene.add(spielerLicht);

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
    // Pickups animieren
    const zeit = performance.now() * 0.002;
    aktivePickups.forEach(p => {
        p.rotation.y += 0.02;
        p.position.y = (AUGEN_HOEHE * 0.5) + Math.sin(zeit) * 0.1;
    });

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
 * Erzeugt ein 3D-Modell für eine Energiezelle (Munition).
 * @returns {THREE.Group}
 */
export function erzeugeMunitionModel() {
    const group = new THREE.Group();

    // Gehäuse (Zylinder)
    const geoHuelse = new THREE.CylinderGeometry(0.15, 0.15, 0.4, 8);
    const matHuelse = new THREE.MeshPhongMaterial({ color: 0x444444, shininess: 100 });
    const huelse = new THREE.Mesh(geoHuelse, matHuelse);
    group.add(huelse);

    // Glühender Kern (innerer Zylinder)
    const geoKern = new THREE.CylinderGeometry(0.16, 0.16, 0.2, 8);
    const matKern = new THREE.MeshBasicMaterial({ color: 0x00ffff });
    const kern = new THREE.Mesh(geoKern, matKern);
    group.add(kern);

    // Kleines Licht für das Pickup
    const licht = new THREE.PointLight(0x00ffff, 1, 2);
    licht.castShadow = false; // Performance: Kein Schattenwurf für Pickups
    group.add(licht);

    aktivePickups.push(group);
    return group;
}

/**
 * Entfernt ein Pickup aus der Animations-Liste.
 * @param {THREE.Group} model 
 */
export function entfernePickupModel(model) {
    const idx = aktivePickups.indexOf(model);
    if (idx !== -1) {
        aktivePickups.splice(idx, 1);
    }

    // Speicher freigeben (Geometrien und Materialien)
    model.traverse((obj) => {
        if (obj.isMesh) {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
                if (Array.isArray(obj.material)) {
                    obj.material.forEach(m => m.dispose());
                } else {
                    obj.material.dispose();
                }
            }
        }
    });
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
