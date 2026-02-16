/**
 * ============================================================
 * KAMPFSYSTEM (combat.js)
 * ============================================================
 * Implementiert das Raycasting-basierte Schusssystem.
 * - Schuss von der Kamera-Mitte nach vorn
 * - Trefferprüfung gegen Gegner-Meshes
 * - Muzzle-Flash-Animation
 * - Schuss-Cooldown
 * ============================================================
 */

import { istWand, WAND_GROESSE, wallGroup } from './maze-generator.js';
import { getKamera } from './renderer.js';

// ── Kampf-Einstellungen ─────────────────────────────────────
const SCHUSS_COOLDOWN = 0.2;    // Sekunden zwischen Schüssen
const SCHUSS_REICHWEITE = 50;   // Maximale Trefferdistanz
const MUZZLE_FLASH_DAUER = 0.08; // Dauer des Mündungsfeuers in Sekunden
const STRAHL_DAUER = 0.15;       // Dauer des Laserstrahls in Sekunden
export const MAX_LEBEN = 100;           // Maximale Lebenspunkte
export const SCHADEN_KOERPER = 15; // Schaden bei Körpertreffer
export const SCHADEN_KOPF = 30;   // Schaden bei Headshot
export const MAX_MUNITION = 20;         // Maximal 20 Schuss pro Spieler
const EINSCHLAG_OFFSET = 0.5;   // Versatz der Lichtquelle vor der Wand (für bessere Sichtbarkeit)

// ── Zustand ─────────────────────────────────────────────────
let letzterSchussZeit = 0;
let muzzleFlashAktiv = false;
let muzzleFlashTimer = 0;
let muzzleFlashLicht = null;
let leben = MAX_LEBEN;
let munition = 10;
let minen = 0; // Start mit 0 Minen
const MAX_MINEN_INVENTORY = 2;
const SCHADEN_MINE = 50;

// Laserstrahl-Zustand
let strahlTimer = 0;             // Verbleibende Sichtbarkeit
let strahlScene = null;          // Referenz auf die Scene für Aufräumen

// Raycaster für Trefferprüfung
const raycaster = new THREE.Raycaster();
raycaster.far = SCHUSS_REICHWEITE;

// Raycaster für Wand-Treffer (Endpunkt des Strahls)
const wandRaycaster = new THREE.Raycaster();
wandRaycaster.far = SCHUSS_REICHWEITE;

// Liste der treffbaren Ziele (Gegner-Meshes)
const ziele = [];

// Audio-Kontext für Sound-Effekte (lazy init nach User-Interaktion)
let audioCtx = null;

// Statischer Rausch-Buffer für Schüsse (Performance & Konsistenz)
let noiseBuffer = null;

// ── Performance-Pooling (Gegen Schuss-Hitch) ──────────────────
const LICHT_POOL_GROESSE = 10;
const lichtPool = [];
const einschlagMeshPool = [];
let poolLaser = null;
let muzzleFlashMesh = null; // NEU: Pooling für Mündungsfeuer

/**
 * Erzeugt einen Buffer für weißes Rauschen.
 */
function getNoiseBuffer(ctx) {
    if (!noiseBuffer) {
        const bufferGroesse = ctx.sampleRate * 0.2; // 200ms Rauschen
        noiseBuffer = ctx.createBuffer(1, bufferGroesse, ctx.sampleRate);
        const daten = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferGroesse; i++) {
            daten[i] = Math.random() * 2 - 1;
        }
    }
    return noiseBuffer;
}

/**
 * Erzeugt einen prozeduralen Retro-Schuss-Sound via Web Audio API.
 */
function spieleSchussSound() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    const zeit = audioCtx.currentTime;

    // ── Master Gain (Sehr knackig) ──────────────────────────
    const masterGain = audioCtx.createGain();
    masterGain.gain.setValueAtTime(0.8, zeit);
    masterGain.gain.exponentialRampToValueAtTime(0.001, zeit + 0.3); // Etwas länger für das "NG"
    masterGain.connect(audioCtx.destination);

    // ── 1. Der "P"-Knall (Noise Burst) ──────────────────────
    const rauschQuelle = audioCtx.createBufferSource();
    rauschQuelle.buffer = getNoiseBuffer(audioCtx);

    const rauschGain = audioCtx.createGain();
    rauschGain.gain.setValueAtTime(0.7, zeit);
    rauschGain.gain.exponentialRampToValueAtTime(0.001, zeit + 0.05);

    const rauschFilter = audioCtx.createBiquadFilter();
    rauschFilter.type = 'highpass';
    rauschFilter.frequency.setValueAtTime(1200, zeit);

    rauschQuelle.connect(rauschFilter);
    rauschFilter.connect(rauschGain);
    rauschGain.connect(masterGain);
    rauschQuelle.start(zeit);
    rauschQuelle.stop(zeit + 0.05);

    // ── 2. Das "E" (Mechanischer Punch / Sweep) ─────────────
    const punch = audioCtx.createOscillator();
    punch.type = 'triangle';
    punch.frequency.setValueAtTime(450, zeit);
    punch.frequency.exponentialRampToValueAtTime(60, zeit + 0.08);

    const punchGain = audioCtx.createGain();
    punchGain.gain.setValueAtTime(0.4, zeit);
    punchGain.gain.exponentialRampToValueAtTime(0.01, zeit + 0.08);

    punch.connect(punchGain);
    punchGain.connect(masterGain);
    punch.start(zeit);
    punch.stop(zeit + 0.08);

    // ── 3. Das "NG" (Metallische Resonanz) ──────────────────
    const ring = audioCtx.createOscillator();
    ring.type = 'sine';
    ring.frequency.setValueAtTime(1400, zeit); // Typischer metallischer Oberton
    ring.frequency.exponentialRampToValueAtTime(800, zeit + 0.2); // Fällt leicht ab

    const ringGain = audioCtx.createGain();
    ringGain.gain.setValueAtTime(0.15, zeit);
    ringGain.gain.exponentialRampToValueAtTime(0.001, zeit + 0.25);

    ring.connect(ringGain);
    ringGain.connect(masterGain);
    ring.start(zeit);
    ring.stop(zeit + 0.25);
}

/**
 * Erzeugt einen prozeduralen Sound für das Einsammeln von Munition.
 * Aufsteigender "Pling"-Sound (200Hz → 800Hz).
 */
function spielePickupSound() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    const zeit = audioCtx.currentTime;
    const osz = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osz.type = 'triangle'; // Weicherer Sound als Sägezahn
    osz.frequency.setValueAtTime(400, zeit);
    osz.frequency.exponentialRampToValueAtTime(1200, zeit + 0.1);

    gain.gain.setValueAtTime(0.2, zeit);
    gain.gain.exponentialRampToValueAtTime(0.01, zeit + 0.1);

    osz.connect(gain);
    gain.connect(audioCtx.destination);

    osz.start(zeit);
    osz.stop(zeit + 0.1);
}

/**
 * Erzeugt einen prozeduralen Sound für einen Treffer (wenn der Spieler getroffen wird).
 * Tiefer, dumpfer Impact-Sound.
 */
function spieleTrefferSound() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    const zeit = audioCtx.currentTime;

    // ── Oszillator: Tiefer Thud (150Hz → 40Hz) ──────────────
    const osz = audioCtx.createOscillator();
    osz.type = 'square';
    osz.frequency.setValueAtTime(150, zeit);
    osz.frequency.exponentialRampToValueAtTime(40, zeit + 0.2);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.4, zeit);
    gain.gain.exponentialRampToValueAtTime(0.01, zeit + 0.2);

    // Tiefpass-Filter für dumpferen Sound
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;

    osz.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);

    osz.start(zeit);
    osz.stop(zeit + 0.2);
}

/**
 * Initialisiert das Kampfsystem.
 * @param {THREE.Scene} scene - Die Spielszene
 * @param {THREE.Camera} kamera - Die Spieler-Kamera
 */
export function initCombat(scene, kamera) {
    strahlScene = scene;

    // 1. Mündungsfeuer (persistent)
    muzzleFlashLicht = new THREE.PointLight(0xffcc00, 0, 5);
    muzzleFlashLicht.userData.persistent = true;
    scene.add(muzzleFlashLicht);

    const muzzleGeo = new THREE.SphereGeometry(0.12, 4, 4);
    const muzzleMat = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0 });
    muzzleFlashMesh = new THREE.Mesh(muzzleGeo, muzzleMat);
    muzzleFlashMesh.visible = false;
    muzzleFlashMesh.userData.persistent = true;
    scene.add(muzzleFlashMesh);

    // 2. Objekt-Pooling Initialisierung
    // Wir erstellen die Lichter und Meshes vorab und verstecken sie
    for (let i = 0; i < LICHT_POOL_GROESSE; i++) {
        const licht = new THREE.PointLight(0xffaa00, 0, 6);
        licht.userData.persistent = true;
        scene.add(licht);
        lichtPool.push(licht);

        const mesh = new THREE.Mesh(einschlagsGeometrie, materialFunken);
        mesh.visible = false;
        mesh.userData.persistent = true;
        scene.add(mesh);
        einschlagMeshPool.push(mesh);
    }

    // 3. Laser-Strahl vorab erstellen
    const laserGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const laserMat = new THREE.LineBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0 });
    poolLaser = new THREE.Line(laserGeo, laserMat);
    poolLaser.userData.persistent = true;
    scene.add(poolLaser);

    console.log('[Kampf] System initialisiert (Pooling aktiv)');

    // 4. Shader Warm-up wird jetzt extern nach dem Maze-Build getriggert
    // warmupCombat(scene);

    // Audio-Kontext und Puffer vorab initialisieren (verhindert Lag beim ersten Schuss)
    try {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') {
                // Autoplay-Policy: Wir probieren es, aber oft braucht es einen Klick
                audioCtx.resume();
            }
            getNoiseBuffer(audioCtx);
        }
    } catch (e) {
        console.warn('[Audio] Initialisierung verzögert:', e);
    }

    updateMunitionAnzeige();
    console.log('[Kampf] Kampfsystem bereit');
}

/**
 * Führt einen Schuss aus.
 * Sendet einen Raycast von der Kamera-Mitte und prüft auf Treffer.
 * 
 * @param {THREE.Camera} kamera - Die Spieler-Kamera
 * @param {THREE.Scene} scene - Die Spielszene
 * @param {number} aktuelleZeit - Aktuelle Zeit in Sekunden
 * @returns {{treffer: boolean, spielerId: string|null, punkt: THREE.Vector3|null}}
 */
function schiessen(kamera, scene, aktuelleZeit) {
    // Cooldown prüfen
    if (aktuelleZeit - letzterSchussZeit < SCHUSS_COOLDOWN) {
        return { treffer: false, spielerId: null, punkt: null, erfolg: false };
    }

    // Munition prüfen
    if (munition <= 0) {
        return { treffer: false, spielerId: null, punkt: null, erfolg: false };
    }

    munition--;
    letzterSchussZeit = aktuelleZeit;
    updateMunitionAnzeige();

    // Schuss-Sound abspielen
    spieleSchussSound();

    // Muzzle-Flash starten
    muzzleFlashAktiv = true;
    muzzleFlashTimer = MUZZLE_FLASH_DAUER;
    muzzleFlashLicht.intensity = 3;
    muzzleFlashLicht.position.copy(kamera.position);

    // Schuss-Animation am HUD
    const waffenElement = document.getElementById('waffe');
    if (waffenElement) {
        waffenElement.classList.add('schiessen');
        setTimeout(() => waffenElement.classList.remove('schiessen'), 100);
    }

    // Mündungsfeuer-Overlay
    const flashElement = document.getElementById('muzzle-flash');
    if (flashElement) {
        flashElement.style.opacity = '1';
        setTimeout(() => { flashElement.style.opacity = '0'; }, 80);
    }

    // Raycast von Bildschirmmitte nach vorn
    raycaster.setFromCamera(new THREE.Vector2(0, 0), kamera);
    const trefferPoints = raycaster.intersectObjects(ziele, true);



    // Wall-Raycaster konfigurieren
    wandRaycaster.ray.origin.copy(kamera.position);
    wandRaycaster.ray.direction.copy(raycaster.ray.direction);
    wandRaycaster.near = 0.1;
    wandRaycaster.far = SCHUSS_REICHWEITE;

    // Nur gegen Wände (wallGroup) raycasten -> Extrem schnell!
    const alleWandTreffer = wallGroup ? wandRaycaster.intersectObject(wallGroup, true) : [];


    // Startpunkt: leicht vor der Kamera
    const strahlStart = kamera.position.clone();
    const richtung = raycaster.ray.direction.clone();
    strahlStart.add(richtung.clone().multiplyScalar(0.3));

    // Endpunkt: erster Wandtreffer oder maximale Reichweite
    let strahlEnde;
    if (alleWandTreffer.length > 0) {
        strahlEnde = alleWandTreffer[0].point.clone();
    } else {
        strahlEnde = strahlStart.clone().add(richtung.multiplyScalar(SCHUSS_REICHWEITE));
    }

    // 3D-Mündungsfeuer für den Spieler selbst deaktiviert (nur HUD-Overlay nutzen)
    // erzeuge3DMuendungsfeuer(scene, strahlStart);

    // Einschlag am Endpunkt (Wand) erzeugen, falls kein Spieler getroffen wurde
    // ODER wenn der Spieler getroffen wurde, aber die Wand näher ist (Wall-Bang Schutz)
    let hitType = 'SPARKS';
    let targetPoint = strahlEnde;

    // Trefferauswertung (Spieler)
    if (trefferPoints.length > 0) {
        const hit = trefferPoints[0];
        // Nur zählen, wenn der Spieler-Treffer näher oder gleich weit wie die Wand ist
        if (alleWandTreffer.length === 0 || hit.distance <= alleWandTreffer[0].distance) {
            const targetObj = hit.object;
            let spielerId = null;
            let schaden = SCHADEN_KOERPER;
            let headshot = false;

            let checker = targetObj;
            while (checker) {
                if (checker.userData && checker.userData.spielerId) {
                    spielerId = checker.userData.spielerId;
                }
                if (checker.name === 'head') {
                    schaden = SCHADEN_KOPF;
                    headshot = true;
                }
                checker = checker.parent;
            }

            if (spielerId) {
                triggereHitMarker();

                // Laserstrahl-Visualisierung (für lokale Anzeige)
                erzeugeStrahl(scene, strahlStart, hit.point);

                // Lokalen Treffereffekt (Blau) erzeugen
                erzeugeEinschlag(scene, hit.point, null, 'BLOOD');

                return {
                    treffer: true,
                    spielerId: spielerId,
                    punkt: hit.point,
                    schaden: schaden,
                    headshot: headshot,
                    strahlStart: strahlStart,
                    strahlEnde: hit.point,
                    hitType: 'BLOOD'
                };
            }
        }
    }

    // Wenn kein Spieler-Treffer: Funken an der Wand
    if (alleWandTreffer.length > 0) {
        const treffer = alleWandTreffer[0];

        // Laserstrahl zur Wand (für lokale Anzeige)
        erzeugeStrahl(scene, strahlStart, treffer.point);

        let normale = null;
        if (treffer.face) {
            normale = treffer.face.normal.clone();
            normale.applyQuaternion(treffer.object.quaternion);
        }
        erzeugeEinschlag(scene, treffer.point, normale, 'SPARKS');
    } else {
        // Gar nichts getroffen -> Laser ins Unendliche (oder bis Reichweite)
        erzeugeStrahl(scene, strahlStart, strahlEnde);
    }



    return {
        treffer: false,
        spielerId: null,
        punkt: null,
        strahlStart: strahlStart,
        strahlEnde: strahlEnde,
        hitType: 'SPARKS'
    };
}

/**
 * Löst die visuelle Trefferanzeige am Fadenkreuz aus.
 */
function triggereHitMarker() {
    const crosshair = document.getElementById('crosshair');
    if (crosshair) {
        crosshair.classList.remove('hit');
        void crosshair.offsetWidth; // Force Reflow für Neustart der Animation
        crosshair.classList.add('hit');

        // Klasse nach Animation wieder entfernen (0.2s Dauer)
        setTimeout(() => {
            crosshair.classList.remove('hit');
        }, 200);
    }
}

/**
 * Registriert ein Objekt als treffbares Ziel.
 * @param {THREE.Object3D} objekt - Das Ziel-Objekt
 */
function registriereZiel(objekt) {
    if (!ziele.includes(objekt)) {
        ziele.push(objekt);
        console.log('[Kampf] Ziel registriert:', objekt.name || 'Unnamed');
    }
}

/**
 * Entfernt ein spezifisches Ziel (z.B. bei Spieler-Disconnect).
 */
function entferneZiel(objekt) {
    const index = ziele.indexOf(objekt);
    if (index !== -1) {
        ziele.splice(index, 1);
        console.log('[Kampf] Ziel entfernt');
    }
}

/**
 * Entfernt alle registrierten Ziele (für Rundenwechsel).
 */
function entferneAlleZiele() {
    ziele.length = 0;
    console.log('[Kampf] Alle Ziele entfernt');
}

/**
 * Erzeugt einen leuchtenden Laserstrahl zwischen zwei Punkten (via Pooling).
 */
function erzeugeStrahl(scene, start, ende) {
    if (!poolLaser) return;

    // Geometrie aktualisieren (ohne neues Object zu erzeugen)
    const positions = poolLaser.geometry.attributes.position.array;
    positions[0] = start.x; positions[1] = start.y; positions[2] = start.z;
    positions[3] = ende.x; positions[4] = ende.y; positions[5] = ende.z;
    poolLaser.geometry.attributes.position.needsUpdate = true;

    poolLaser.material.opacity = 1.0;
    poolLaser.material.color.setHex(0xffaa00);
    poolLaser.visible = true;

    strahlTimer = STRAHL_DAUER;
}

/**
 * Entfernt den aktuellen Laserstrahl (macht ihn unsichtbar).
 */
function entferneStrahl() {
    if (poolLaser) {
        poolLaser.visible = false;
        poolLaser.material.opacity = 0;
    }
}

/**
 * Zwingt die Grafikkarte, die Shader für Schusseffekte vorab zu compilieren.
 * Muss aufgerufen werden, wenn bereits Geometrie (Wände) in der Scene sind!
 */
export function warmupCombat(scene) {
    if (!scene) return;
    console.log('[Kampf] Starte Shader-Warmup für Effekte...');

    // Wir machen alles für einen kurzen Moment sichtbar (mit minimaler Intensität)
    if (poolLaser) {
        poolLaser.visible = true;
        poolLaser.material.opacity = 0.01;
    }
    if (muzzleFlashMesh) {
        muzzleFlashMesh.visible = true;
        muzzleFlashMesh.material.opacity = 0.01;
    }
    if (muzzleFlashLicht) {
        muzzleFlashLicht.intensity = 0.01;
    }

    lichtPool.forEach(l => l.intensity = 0.01);
    einschlagMeshPool.forEach(m => {
        m.visible = true;
        m.material.opacity = 0.01;
    });

    // Wir lassen es für 2 Frames aktiv (ca. 32ms), damit der Renderer es sicher sieht
    setTimeout(() => {
        if (poolLaser) poolLaser.visible = false;
        if (muzzleFlashMesh) muzzleFlashMesh.visible = false;
        if (muzzleFlashLicht) muzzleFlashLicht.intensity = 0;
        lichtPool.forEach(l => l.intensity = 0);
        einschlagMeshPool.forEach(m => m.visible = false);
        console.log('[Kampf] Shader-Warmup abgeschlossen.');
    }, 100);
}

// Shared Geometries & Materials für Einschlag-Effekte (Performance)
const einschlagsGeometrie = new THREE.SphereGeometry(0.1, 6, 6);
const materialBlut = new THREE.MeshBasicMaterial({ color: 0xff0000 });
const materialFunken = new THREE.MeshBasicMaterial({ color: 0xffcc00 });

/**
 * Erzeugt einen visuellen Einschlag-Effekt am Trefferpunkt (via Pooling).
 */
function erzeugeEinschlag(scene, punkt, normal = null, typ = 'SPARKS', schuetzenPos = null) {
    const isBlood = typ === 'BLOOD';
    const lichtFarbe = isBlood ? 0xff0000 : 0xffaa00;

    // 1. Mesh aus Pool holen
    const mesh = einschlagMeshPool.find(m => !m.visible) || einschlagMeshPool[0];
    mesh.material = isBlood ? materialBlut : materialFunken;
    mesh.position.copy(punkt);
    mesh.visible = true;

    const scale = isBlood ? 1.2 : 0.8;
    mesh.scale.set(scale, scale, scale);

    // 2. Licht aus Pool holen
    const licht = lichtPool.find(l => l.intensity === 0) || lichtPool[0];
    licht.color.setHex(lichtFarbe);
    licht.intensity = isBlood ? 3 : 5;
    licht.distance = isBlood ? 4 : 6;
    licht.position.copy(punkt);

    // Offset
    if (normal) {
        mesh.position.add(normal.clone().multiplyScalar(0.02));
        licht.position.add(normal.clone().multiplyScalar(EINSCHLAG_OFFSET));
    } else {
        const refPos = schuetzenPos || (getKamera() ? getKamera().position : null);
        if (refPos) {
            const dir = new THREE.Vector3().subVectors(refPos, punkt).normalize();
            mesh.position.add(dir.clone().multiplyScalar(0.05));
            licht.position.add(dir.multiplyScalar(EINSCHLAG_OFFSET));
        }
    }

    // Nach kurzer Zeit wieder deaktivieren (Pooling)
    setTimeout(() => {
        mesh.visible = false;
        licht.intensity = 0;
    }, 300);
}

/**
 * Trigger Schuss-Visuals für gegnerische Schüsse (aus Netzwerk).
 * @param {THREE.Scene} scene 
 * @param {object} start - {x, y, z}
 * @param {object} ende - {x, y, z}
 * @param {string} hitType - 'SPARKS' oder 'BLOOD'
 */
function triggereSchussVisuals(scene, start, ende, hitType = 'SPARKS') {
    const s = new THREE.Vector3(start.x, start.y, start.z);
    const e = new THREE.Vector3(ende.x, ende.y, ende.z);

    spieleSchussSound();

    const muzzlePos = new THREE.Vector3(start.x, start.y, start.z);
    erzeuge3DMuendungsfeuer(scene, muzzlePos);

    erzeugeEinschlag(scene, e, null, hitType, s);
}

/**
 * Erzeugt einen kurzen 3D-Lichtblitz (Mündungsfeuer) an einer Position (via Pooling).
 * @param {THREE.Scene} scene 
 * @param {THREE.Vector3} position 
 */
function erzeuge3DMuendungsfeuer(scene, position) {
    if (!muzzleFlashMesh || !muzzleFlashLicht) return;

    // Blitz (Mesh)
    muzzleFlashMesh.position.copy(position);
    muzzleFlashMesh.visible = true;
    muzzleFlashMesh.material.opacity = 1;

    // Blitz (Licht)
    muzzleFlashLicht.position.copy(position);
    muzzleFlashLicht.intensity = 3;
    muzzleFlashLicht.distance = 2;

    setTimeout(() => {
        muzzleFlashMesh.visible = false;
        muzzleFlashLicht.intensity = 0;
    }, 60);
}

/**
 * Aktualisiert den Kampfzustand (Muzzle-Flash).
 * @param {number} deltaZeit - Vergangene Zeit seit letztem Frame
 * @param {THREE.Camera} kamera - Die Spieler-Kamera
 */
function updateCombat(deltaZeit, kamera) {
    // Muzzle-Flash abklingen lassen
    if (muzzleFlashAktiv) {
        muzzleFlashTimer -= deltaZeit;
        if (muzzleFlashTimer <= 0) {
            muzzleFlashAktiv = false;
            muzzleFlashLicht.intensity = 0;
        }
    }

    // Laserstrahl Logik (Pooling)
    if (poolLaser && poolLaser.visible) {
        strahlTimer -= deltaZeit;
        if (strahlTimer <= 0) {
            entferneStrahl();
        } else {
            const fortschritt = strahlTimer / STRAHL_DAUER;
            poolLaser.material.opacity = fortschritt;
        }
    }
}

/** @type {function|null} Callback der bei Tod aufgerufen wird */
let onTodCallback = null;

/**
 * Registriert einen Callback der automatisch aufgerufen wird,
 * wenn der Spieler durch irgendeinen Schaden auf 0 Leben fällt.
 * @param {function} callback - Wird aufgerufen bei Tod
 */
function setOnTodCallback(callback) {
    onTodCallback = callback;
}

/**
 * Wendet Schaden auf den lokalen Spieler an.
 * Löst automatisch den Tod-Callback aus, wenn Leben <= 0.
 * @param {number} schaden - Schadenspunkte
 * @returns {number} Verbleibende Lebenspunkte
 */
function empfangeSchaden(schaden) {
    leben = Math.max(0, leben - schaden);

    // Bildschirm rot blinken lassen (Schadens-Feedback)
    const overlay = document.getElementById('schaden-overlay');
    if (overlay) {
        overlay.style.opacity = '0.5';
        setTimeout(() => { overlay.style.opacity = '0'; }, 200);
    }

    // Sound abspielen
    spieleTrefferSound();

    // HUD aktualisieren
    updateLebenAnzeige();

    console.log(`[Kampf] Schaden erhalten: ${schaden}, Leben: ${leben}`);

    if (leben <= 0) {
        console.log('[Kampf] SPIELER BESIEGT!');
        if (onTodCallback) {
            onTodCallback();
        }
    }

    return leben;
}

/**
 * Aktualisiert die Lebenspunkte-Anzeige im HUD.
 */
function updateLebenAnzeige() {
    const lebenElement = document.getElementById('leben-wert');
    if (lebenElement) {
        lebenElement.textContent = leben;
    }
    const lebenBalken = document.getElementById('leben-balken');
    if (lebenBalken) {
        lebenBalken.style.width = `${leben}%`;
        // Farbe ändern je nach Lebenspunkten
        if (leben > 60) {
            lebenBalken.style.backgroundColor = '#44ff44';
        } else if (leben > 30) {
            lebenBalken.style.backgroundColor = '#ffaa00';
        } else {
            lebenBalken.style.backgroundColor = '#ff4444';
        }
    }
}

/**
 * Setzt die Lebenspunkte zurück (z.B. bei Respawn).
 */
function resetLeben() {
    leben = MAX_LEBEN;
    updateLebenAnzeige();
}

/**
 * Gibt die aktuellen Lebenspunkte zurück.
 * @returns {number}
 */
function getLeben() {
    return leben;
}

/**
 * Aktualisiert die Munitions-Anzeige im HUD.
 */
function updateMunitionAnzeige() {
    const ammoElement = document.getElementById('ammo-wert');
    if (ammoElement) {
        ammoElement.textContent = munition;
    }
}

/**
 * Gibt die aktuelle Munition zurück.
 * @returns {number}
 */
function getMunition() {
    return munition;
}

/**
 * Gibt die aktuelle Minen-Anzahl zurück.
 * @returns {number}
 */
function getMinen() {
    return minen;
}

/**
 * Prüft, ob der Spieler eine Mine hat.
 */
function hasMine() {
    return minen > 0;
}

/**
 * Fügt Minen zum Inventar hinzu.
 * @param {number} menge
 * @param {boolean} mitSound
 * @returns {boolean} true wenn erfolgreich hinzugefügt
 */
function addMine(menge = 1, mitSound = true) {
    if (minen >= MAX_MINEN_INVENTORY) return false;

    minen = Math.min(MAX_MINEN_INVENTORY, minen + menge);
    updateMinenAnzeige();
    if (mitSound) spielePickupSound(); // Evtl. eigener Sound? Erstmal Pickup.
    return true;
}

/**
 * Verbraucht eine Mine aus dem Inventar.
 */
function nutzeMine() {
    if (minen > 0) {
        minen--;
        updateMinenAnzeige();
        return true;
    }
    return false;
}

/**
 * Aktualisiert die Minen-Anzeige im HUD.
 */
function updateMinenAnzeige() {
    const minenElement = document.getElementById('minen-wert');
    if (minenElement) {
        minenElement.textContent = minen;
        minenElement.style.color = minen > 0 ? '#ff4444' : '#555';
    }
}

/**
 * Erhöht die Munition (z.B. Pickup).
 * @param {number} menge - Anzahl der Schüsse
 * @param {boolean} mitSound - Ob der Pickup-Sound abgespielt werden soll
 */
function addMunition(menge, mitSound = true) {
    munition = Math.min(MAX_MUNITION, munition + menge);
    updateMunitionAnzeige();
    if (mitSound) spielePickupSound();
}

/**
 * Heilt den Spieler um einen bestimmten Betrag.
 * @param {number} betrag 
 */
function healPlayer(betrag) {
    leben = Math.min(MAX_LEBEN, leben + betrag);
    updateLebenAnzeige(leben);
    if (audioCtx) {
        // Kurzer hoher Soundfaktor für Heilung
        const zeit = audioCtx.currentTime;
        const osz = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osz.frequency.setValueAtTime(440, zeit);
        osz.frequency.exponentialRampToValueAtTime(880, zeit + 0.1);
        gain.gain.setValueAtTime(0.1, zeit);
        gain.gain.exponentialRampToValueAtTime(0.01, zeit + 0.1);
        osz.connect(gain);
        gain.connect(audioCtx.destination);
        osz.start(zeit);
        osz.stop(zeit + 0.1);
    }
    console.log(`[Kampf] Spieler geheilt um ${betrag}. Leben: ${leben}`);
}

/**
 * Setzt Munition zurück (z.B. bei Respawn).
 */
function resetMunition() {
    munition = 10;
    updateMunitionAnzeige();
}

export {
    schiessen, updateCombat, registriereZiel,
    entferneZiel, entferneAlleZiele, empfangeSchaden, healPlayer,
    updateLebenAnzeige, resetLeben, getLeben, addMunition,
    updateMunitionAnzeige, resetMunition, getMunition,
    getMinen, hasMine, addMine, nutzeMine, SCHADEN_MINE,
    triggereSchussVisuals, setOnTodCallback
};
