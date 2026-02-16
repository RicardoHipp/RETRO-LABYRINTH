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
            // Kamera und persistente Objekte (Pools) NIEMALS löschen/disposen
            if (obj === kamera || (obj.userData && obj.userData.persistent)) return;
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
    scene.background = new THREE.Color(0x05050a); // Fast schwarz

    // Nebel für Horror-Atmosphäre (kürzer = beklemmender)
    scene.fog = new THREE.Fog(0x05050a, 1, 15);

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

    console.log('[Renderer] Three.js v1.1.5 Renderer bereit (Phong/Pixel-Lighting active)');
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

// ── Objekt-Pooling für Pickups (Finaler Performance-Fix) ──────────
const sharedPickupAssets = {
    AMMO: {
        geoHuelse: new THREE.CylinderGeometry(0.15, 0.15, 0.4, 8),
        matHuelse: new THREE.MeshLambertMaterial({ color: 0x444444 }),
        geoKern: new THREE.CylinderGeometry(0.16, 0.16, 0.2, 8),
        matKern: new THREE.MeshBasicMaterial({ color: 0x00ffff })
    },
    HEALTH: {
        geoBox: new THREE.BoxGeometry(0.3, 0.3, 0.3),
        matBox: new THREE.MeshLambertMaterial({ color: 0xff0000 }),
        geoCross: new THREE.BoxGeometry(0.35, 0.1, 0.1),
        matCross: new THREE.MeshBasicMaterial({ color: 0xffffff })
    },
    MINE: {
        geoBody: new THREE.CylinderGeometry(0.25, 0.3, 0.1, 8),
        matBody: new THREE.MeshLambertMaterial({ color: 0x222222 }),
        geoLight: new THREE.SphereGeometry(0.08, 6, 6),
        matLight: new THREE.MeshBasicMaterial({ color: 0xff0000 }) // Blinkt später via Code?
    }
};

/** @type {Object.<string, THREE.Group[]>} */
const pickupPool = {
    AMMO: [],
    HEALTH: [],
    MINE: []
};

let poolsInitialisiert = false;

/**
 * Initialisiert die Pools und fügt sie der Scene hinzu (versteckt unter dem Boden).
 * @param {THREE.Scene} targetScene 
 */
export function initPickupPools(targetScene) {
    if (poolsInitialisiert) return;
    // initSharedPickupAssets(); // Nicht mehr nötig, da direkt definiert

    const poolGroesse = 15; // Ausreichend für Respawns

    // MINE zum Pool hinzufügen
    ['AMMO', 'HEALTH', 'MINE'].forEach(typ => {
        for (let i = 0; i < poolGroesse; i++) {
            const model = erstelleNeuesPickupModel(typ);
            model.visible = false;
            model.userData.active = false;
            model.userData.persistent = true; // Schutz vor Scene-Cleanup
            model.position.set(0, -10, 0); // Unter der Welt
            targetScene.add(model);
            pickupPool[typ].push(model);
        }
    });

    poolsInitialisiert = true;
    console.log('[Renderer] Pickup-Pools initialisiert (30 Objekte, Self-Illuminated, KEINE Lichter)');
}

/**
 * Interne Hilfsfunktion zur Erstellung der Geometrie/Materialien (Shared).
 * @param {string} typ 
 */
function erstelleNeuesPickupModel(typ) {
    const assets = sharedPickupAssets[typ];
    const group = new THREE.Group();
    group.userData.typ = typ;
    group.userData.imPool = true;
    group.userData.active = false;

    if (typ === 'MINE') {
        const body = new THREE.Mesh(assets.geoBody, assets.matBody);
        const light = new THREE.Mesh(assets.geoLight, assets.matLight);
        light.position.y = 0.1;
        group.add(body);
        group.add(light);
    } else if (typ === 'AMMO') {
        group.add(new THREE.Mesh(assets.geoHuelse, assets.matHuelse));
        group.add(new THREE.Mesh(assets.geoKern, assets.matKern));
    } else {
        // Default: HEALTH
        group.add(new THREE.Mesh(assets.geoBox, assets.matBox));
        const cross1 = new THREE.Mesh(assets.geoCross, assets.matCross);
        const cross2 = new THREE.Mesh(assets.geoCross, assets.matCross);
        cross2.rotation.y = Math.PI / 2;
        group.add(cross1);
        group.add(cross2);
    }

    return group;
}

/**
 * Holt ein fertiges Pickup-Modell aus dem Pool.
 * @param {string} typ - 'AMMO' oder 'HEALTH'
 * @returns {THREE.Group}
 */
export function erzeugePickupModel(typ) {
    if (!poolsInitialisiert) {
        // initSharedPickupAssets(); // Nicht mehr nötig
        return erstelleNeuesPickupModel(typ);
    }

    const model = pickupPool[typ].find(m => !m.userData.active) || pickupPool[typ][0];

    model.userData.active = true;
    model.visible = true;
    console.log(`[Renderer] Pickup aus Pool geholt: ${typ}, Active: true`);
    if (!aktivePickups.includes(model)) {
        aktivePickups.push(model);
    }
    return model;
}

/**
 * Legt ein Pickup zurück in den Pool.
 * @param {THREE.Group} model 
 */
export function entfernePickupModel(model) {
    const idx = aktivePickups.indexOf(model);
    if (idx !== -1) {
        aktivePickups.splice(idx, 1);
    }

    model.userData.active = false;
    model.visible = false;
    model.position.set(0, -10, 0);
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

/**
 * Erstellt ein Modell für eine platzierte (scharfe) Mine.
 * (Kein Pool, da wenige gleichzeitig existieren).
 */
export function erzeugeScharfeMineModel() {
    const assets = sharedPickupAssets.MINE;
    const group = new THREE.Group();

    const body = new THREE.Mesh(assets.geoBody, assets.matBody);
    const light = new THREE.Mesh(assets.geoLight, assets.matLight.clone()); // Clone, damit wir blinken können
    light.position.y = 0.1;
    light.name = 'blinkLight'; // Für Animation

    group.add(body);
    group.add(light);

    // Kleiner als das Pickup
    group.scale.set(0.8, 0.8, 0.8);

    return group;
}
