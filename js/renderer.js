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
// let spielerLicht = null; // Entfernt für Wandbeleuchtung


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
            // Kamera NIEMALS löschen/disposen
            if (obj === kamera) return;
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
    // renderer.shadowMap.enabled = true;
    // renderer.shadowMap.type = THREE.BasicShadowMap;


    const container = document.getElementById('game-container');
    container.innerHTML = ''; // Canvas-Leichen entfernen
    container.appendChild(renderer.domElement);

    // ── Beleuchtung ─────────────────────────────────────────
    const ambientLicht = new THREE.AmbientLight(0x404060, 0.4); // Etwas heller für Grundstimmung
    scene.add(ambientLicht);


    window.addEventListener('resize', onResize);

    console.log('[Renderer] Three.js v1.1.5 Renderer bereit (Lambert-Update)');
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
 * Deaktiviert: Spieler-Licht wird nicht mehr genutzt.
 */
export function updateSpielerLicht() {
    // Leer für Kompatibilität
}

/**
 * Bereitet den Renderer vor (Shader-Precompilation).
 * Verhindert Ruckler, wenn Objekte zum ersten Mal im Sichtfeld erscheinen.
 * sollte nach dem Aufbau des Levels aufgerufen werden.
 * @param {THREE.Scene} scene 
 * @param {THREE.Camera} kamera 
 */
export function prepareRenderer(scene, kamera) {
    if (renderer && scene && kamera) {
        console.log('[Renderer] Starte Shader-Vorbereitung...');

        // 1. Three.js interne Kompilierung
        renderer.compile(scene, kamera);

        // 2. Ein "Warmup-Render" erzwingen (offscreen oder mini-frame)
        // Wir rendern einen Frame, bevor der Spieler die Szene sieht
        renderer.render(scene, kamera);

        console.log('[Renderer] Shader-Vorbereitung abgeschlossen.');
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
 * Erzeugt ein 3D-Modell für ein Pickup basierend auf dem Typ.
 * @param {string} typ - Der Typ des Pickups (z.B. 'AMMO', 'HEALTH')
 * @returns {THREE.Group}
 */
export function erzeugePickupModel(typ) {
    const group = new THREE.Group();
    group.userData.typ = typ;

    switch (typ) {
        case 'AMMO':
            // Gehäuse (Zylinder)
            const geoHuelse = new THREE.CylinderGeometry(0.15, 0.15, 0.4, 8);
            const matHuelse = new THREE.MeshLambertMaterial({ color: 0x444444 });
            const huelse = new THREE.Mesh(geoHuelse, matHuelse);
            group.add(huelse);

            // Glühender Kern (innerer Zylinder)
            const geoKern = new THREE.CylinderGeometry(0.16, 0.16, 0.2, 8);
            const matKern = new THREE.MeshBasicMaterial({ color: 0x00ffff });
            const kern = new THREE.Mesh(geoKern, matKern);
            group.add(kern);

            // Kleines Licht
            const lichtAmmo = new THREE.PointLight(0x00ffff, 1, 2);
            lichtAmmo.castShadow = false;
            group.add(lichtAmmo);
            break;

        case 'HEALTH':
            // Rote Box mit weißem Kreuz 
            const geoBox = new THREE.BoxGeometry(0.3, 0.3, 0.3);
            const matBox = new THREE.MeshLambertMaterial({ color: 0xff0000 });
            const box = new THREE.Mesh(geoBox, matBox);
            group.add(box);

            const geoCross = new THREE.BoxGeometry(0.35, 0.1, 0.1);
            const matCross = new THREE.MeshBasicMaterial({ color: 0xffffff });
            const cross1 = new THREE.Mesh(geoCross, matCross);
            const cross2 = new THREE.Mesh(geoCross, matCross);
            cross2.rotation.y = Math.PI / 2;
            group.add(cross1);
            group.add(cross2);

            const lichtHealth = new THREE.PointLight(0xff0000, 1, 2);
            lichtHealth.castShadow = false;
            group.add(lichtHealth);
            break;
    }

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

export { AUGEN_HOEHE, aktivePickups };
