/**
 * ============================================================
 * HAUPTMODUL (main.js)
 * ============================================================
 * Einstiegspunkt des Spiels. Verbindet alle Module und
 * steuert den Game-Loop.
 * 
 * Ablauf:
 *   1. Startbildschirm → Lobby (Raum erstellen/beitreten)
 *   2. Labyrinth mit Seed generieren
 *   3. Three.js initialisieren
 *   4. Auf Gegner warten / Spiel starten
 *   5. Game-Loop
 * ============================================================
 */

import {
    generateMaze,
    buildMazeGeometry,
    findeFreiePosition,
    generiereZufallsSeed,
    istWand,
    addWallLights,
    updateFackeln,
    WAND_GROESSE,
    WAND_HOEHE
} from './maze-generator.js';
import { initInput, getLookDelta, bewegeSpieler, verbrauchSchuss } from './input-handler.js';
import { initRenderer, updateKameraRotation, getGierWinkel, updateSpielerLicht, prepareRenderer, renderFrame, getKamera, getScene, getRenderer, AUGEN_HOEHE, erzeugePickupModel, entfernePickupModel, initPickupPools } from './renderer.js';
import { initCombat, warmupCombat, schiessen, updateCombat, registriereZiel, entferneZiel, entferneAlleZiele, empfangeSchaden, healPlayer, updateLebenAnzeige, resetLeben, addMunition, updateMunitionAnzeige, resetMunition, getMunition, MAX_MUNITION, triggereSchussVisuals, getLeben, MAX_LEBEN } from './combat.js';
import { NetworkManager } from './network-manager.js';

// ── Spiel-Einstellungen ─────────────────────────────────────
const LABYRINTH_BREITE = 8;   // Zellen (Gesamtraster wird 2*8+1 = 17)
const LABYRINTH_HOEHE = 8;
const MAX_PICKUPS_ON_GROUND = 8; // Maximal 8 Munitionspacks (40 Schuss) auf dem Boden
const RESPAWN_INTERVAL = 5;      // Alle 5 Sekunden prüfen

// ── Globaler Spielzustand ───────────────────────────────────
let labyrinth = null;
let netzwerk = null;
let gegnerMesh = null;
let uhr = null; // THREE.Clock für DeltaZeit
let spielGestartet = false;
let spielSeed = 0;
let letzterRespawnZeit = 0;
let rundeAktiv = true; // false wenn jemand besiegt wurde
let pickups = []; // Liste der verfügbaren Pickups (früher munitionPickups)
let neustartTimer = null; // Globaler Timer für Neustart-Countdown

// Radar-Ping System (Gegner auf Minimap)
let gegnerRadarPos = null;      // Die zuletzt "gepinnte" Position
let letzterRadarPingZeit = 0;   // Zeit des letzten Pings
const RADAR_INTERVALL = 5.0;    // Alle 5 Sekunden ein Update

// Drosselung von unkritischen Systemen (Performance)
let letztesMinimapUpdate = 0;
const MINIMAP_FPS = 20; // 20 Updates pro Sekunde reichen völlig
let letztesPickupUpdate = 0;
const PICKUP_FPS = 10;  // 10 Mal pro Sekunde prüfen reicht

// ── Score-System ────────────────────────────────────────────
let eigenePunkte = 0;
let gegnerPunkte = 0;

// ── Minimap ─────────────────────────────────────────────────
const MINIMAP_ZELLGROESSE = 5;
let minimapCanvas = null;
let minimapCtx = null;
let minimapBackgroundCanvas = null; // NEU: Cache für statischen Hintergrund
let minimapBackgroundCtx = null;

// Pool für häufig genutzte Objekte (Performance)
const bodenPosTemp = new THREE.Vector3();

/**
 * Initialisiert die Grundsysteme (Three.js etc.) OHNE Labyrinth.
 */
function initSzene() {
    const { renderer, kamera, scene } = initRenderer();
    initInput(renderer.domElement);
    initCombat(scene, kamera);
    updateLebenAnzeige();
    updateScoreAnzeige();
    uhr = new THREE.Clock();
    // Pickup Pooling initialisieren
    initPickupPools(scene);

    console.log('[Spiel] Szene initialisiert (wartet auf Labyrinth)');
}

/**
 * Baut das Labyrinth auf und startet das Spiel.
 * @param {number} seed - Der Labyrinth-Seed
 * @param {boolean} istHost - Ob dieser Spieler der Host ist
 */
function starteSpielMitSeed(seed, istHost) {
    spielSeed = seed;
    const scene = getScene();
    const kamera = getKamera();

    // Alte Pickups aufräumen
    for (let p of pickups) {
        scene.remove(p.model);
        entfernePickupModel(p.model);
    }
    pickups = [];

    // Labyrinth generieren (gleicher Seed = gleiches Labyrinth)
    labyrinth = generateMaze(LABYRINTH_BREITE, LABYRINTH_HOEHE, seed);
    buildMazeGeometry(scene, labyrinth);

    // Wandbeleuchtung hinzufügen
    addWallLights(scene, labyrinth);

    // Munitionspacks spawnen
    spawnInitialPickups(seed);

    // Shader Pre-compilation (verhindert Ruckler beim Loslaufen)
    prepareRenderer(scene, kamera);

    // Spieler spawnen – Host an Position 0, Guest an Position weit entfernt
    const spawnIndex = istHost ? 0 : Math.floor(LABYRINTH_BREITE * LABYRINTH_HOEHE * 0.8);
    const spawnPos = findeFreiePosition(labyrinth, spawnIndex);
    kamera.position.set(spawnPos.x, AUGEN_HOEHE, spawnPos.z);
    console.log(`[Spiel] Spieler gespawnt bei: (${spawnPos.x.toFixed(1)}, ${spawnPos.z.toFixed(1)})`);

    // Munition zurücksetzen
    resetMunition();
    updateMunitionAnzeige();

    // Minimap initialisieren
    initMinimap();

    // FINALER WARMUP: Jetzt wo die Welt gebaut ist, Shader für Kampf-Effekte forcieren
    warmupCombat(scene);

    // Lobby ausblenden, Spiel einblenden
    document.getElementById('lobby-screen').style.display = 'none';

    // UI-Rolle setzen
    const roleEl = document.getElementById('role-indicator');
    if (roleEl) {
        roleEl.textContent = istHost ? 'HOST' : 'GAST';
    }

    // Touch-Steuerung auf Mobile anzeigen
    if (istMobileGeraet()) {
        document.getElementById('touch-controls').style.display = 'block';
    }

    // Hinweis: PointerLock wird erst durch User-Interaktion (Klick) aktiviert
    // um WrongDocumentError zu vermeiden.

    // Positions-Updates starten
    netzwerk.startePositionsUpdates();

    // Initiale Position sofort einmal erzwingen
    const bodenPos = new THREE.Vector3(kamera.position.x, 0, kamera.position.z);
    netzwerk.sendPlayerPosition(bodenPos, kamera.rotation);
    netzwerk.pusheAktuellePosition();

    spielGestartet = true;
    console.log('[Spiel] ✅ Spiel gestartet! Ist Host:', istHost);
}

/**
 * Erstellt das Gegner-Mesh wenn ein Spieler beitritt.
 */
function erstelleGegnerMesh() {
    const scene = getScene();

    if (gegnerMesh) {
        scene.remove(gegnerMesh);
    }

    // Körper (rot)
    const koerperGeometrie = new THREE.BoxGeometry(0.6, 1.6, 0.4);
    koerperGeometrie.translate(0, 0.8, 0); // Ursprung an die Füße verschieben
    const koerperMaterial = new THREE.MeshLambertMaterial({ color: 0xff3333 });
    const koerper = new THREE.Mesh(koerperGeometrie, koerperMaterial);
    koerper.name = 'body'; // Für Treffererkennung
    gegnerMesh = new THREE.Group(); // Verwende Group statt Mesh für komplexe Ziele
    gegnerMesh.add(koerper);

    // Kopf
    const kopfGeometrie = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    const kopfMaterial = new THREE.MeshLambertMaterial({ color: 0xffcc88 });
    const kopf = new THREE.Mesh(kopfGeometrie, kopfMaterial);
    kopf.name = 'head'; // Für Headshots (doppelter Schaden)
    kopf.position.y = 1.8; // Kopf oben auf den Körper setzen
    gegnerMesh.add(kopf);

    // NEU: Visier (vorne am Kopf)
    const visierGeometrie = new THREE.BoxGeometry(0.3, 0.05, 0.05);
    const visierMaterial = new THREE.MeshBasicMaterial({ color: 0x00ffff }); // Leuchtendes Cyan
    const visier = new THREE.Mesh(visierGeometrie, visierMaterial);
    visier.position.set(0, 1.85, -0.2); // Vorne am Kopf positionieren
    gegnerMesh.add(visier);

    // NEU: Rucksack (hinten am Körper)
    const rucksackGeometrie = new THREE.BoxGeometry(0.4, 0.8, 0.15);
    const rucksackMaterial = new THREE.MeshLambertMaterial({ color: 0x444444 });
    const rucksack = new THREE.Mesh(rucksackGeometrie, rucksackMaterial);
    rucksack.position.set(0, 1.1, 0.25); // Hinten am Körper positionieren
    gegnerMesh.add(rucksack);

    // NEU: Waffe (rechts am Körper, nach vorne zeigend)
    const waffeGeometrie = new THREE.BoxGeometry(0.1, 0.1, 0.5);
    const waffeMaterial = new THREE.MeshLambertMaterial({ color: 0x777777 });
    const waffe = new THREE.Mesh(waffeGeometrie, waffeMaterial);
    waffe.name = 'weapon'; // Name hinzugefügt für einfache Suche
    waffe.position.set(0.35, 1.1, -0.3); // Rechts vorne positionieren
    gegnerMesh.add(waffe);

    // Startposition (wird durch Netzwerk sofort überschrieben)
    gegnerMesh.position.set(0, 0, 0);
    gegnerMesh.visible = false;

    // Als Ziel für Raycasting registrieren
    gegnerMesh.userData.spielerId = 'gegner'; // Wichtig für Trefferauswertung!
    registriereZiel(gegnerMesh);
    scene.add(gegnerMesh);

    console.log('[Spiel] Gegner-Mesh erstellt');
}

/**
 * Spawnt initiale Pickups im Labyrinth basierend auf dem Seed.
 * @param {number} seed 
 */
function spawnInitialPickups(seed) {
    // Einfacher Zufallsgenerator basierend auf Seed
    let random = seed;
    const seededRandom = () => {
        random = (random * 16807) % 2147483647;
        return (random - 1) / 2147483646;
    };

    const anzahl = 6;
    for (let i = 0; i < anzahl; i++) {
        // Initiale Packs sind immer Munition für den Start
        spawnEinzelnesPickup('AMMO', seededRandom, `pickup_init_${i}`, false);
    }
    console.log(`[Spiel] ${anzahl} Initial-Pickups gespawnt`);
}

/**
 * Spawnt ein einzelnes Pickup an einer zufälligen freien Stelle.
 * @param {string} typ - Der Item-Typ ('AMMO', 'HEALTH' etc.)
 * @param {function} randomFunc - Optionale Zufallsfunktion
 * @param {string} vorgabeId - Optionale ID
 * @param {boolean} sollSenden - Ob der Gast via Netzwerk informiert werden soll
 */
function spawnEinzelnesPickup(typ = 'AMMO', randomFunc = Math.random, vorgabeId = null, sollSenden = true) {
    const scene = getScene();
    if (!scene) return null;

    const randIdx = Math.floor(randomFunc() * LABYRINTH_BREITE * LABYRINTH_HOEHE);
    const pos = findeFreiePosition(labyrinth, randIdx);

    // Eindeutige ID generieren
    const id = vorgabeId || `pickup_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const model = erzeugePickupModel(typ);
    model.position.set(pos.x, 0.5, pos.z);
    // scene.add(model) entfällt, da bereits im Pool-Init geschehen

    pickups.push({
        id: id,
        typ: typ,
        pos: pos,
        model: model
    });

    // Wenn Host: Gast informieren
    if (sollSenden && netzwerk && netzwerk.istHost && netzwerk.verbunden) {
        netzwerk.sende('new_pickup', { id, pos, typ });
    }

    return id;
}

/**
 * Spawnt ein Pickup an einer im Netzwerk empfangenen Position (nur Gast).
 * @param {string} id 
 * @param {object} pos 
 * @param {string} typ
 */
export function spawnNetzwerkPickup(id, pos, typ = 'AMMO') {
    const scene = getScene();
    if (!scene) return;

    const model = erzeugePickupModel(typ);
    model.position.set(pos.x, 0.5, pos.z);
    // scene.add(model) entfällt

    pickups.push({
        id: id,
        typ: typ,
        pos: pos,
        model: model
    });
    console.log(`[Netzwerk] Neues Pickup empfangen: ${typ} (${id})`);
}

/**
 * Prüft auf Kollisionen mit Pickups.
 */
function updatePickups() {
    if (!spielGestartet || !rundeAktiv) return;

    const kamera = getKamera();
    const spielerPos = kamera.position;

    for (let i = pickups.length - 1; i >= 0; i--) {
        const p = pickups[i];
        const dx = spielerPos.x - p.pos.x;
        const dz = spielerPos.z - p.pos.z;
        const distSq = dx * dx + dz * dz;

        // Einsammel-Radius: 0.6 Einheiten (quadriert = 0.36)
        if (distSq < 0.36) {
            if (wendePickupEffektAn(p.typ)) {
                console.log(`[Spiel] Pickup eingesammelt: ${p.typ} (${p.id})`);

                // Vom Netzwerk benachrichtigen
                netzwerk.sende('pickup_collected', { id: p.id });
                entfernePickup(p.id);
            }
        }
    }
}

/**
 * Wendet den Effekt eines Pickups auf den Spieler an.
 * @param {string} typ - Item-Typ
 * @returns {boolean} true wenn erfolgreich eingesammelt
 */
function wendePickupEffektAn(typ) {
    switch (typ) {
        case 'AMMO':
            if (getMunition() < MAX_MUNITION) {
                addMunition(5);
                return true;
            }
            return false;
        case 'HEALTH':
            if (getLeben() < MAX_LEBEN) {
                healPlayer(25);
                return true;
            }
            return false;
        default:
            return false;
    }
}

/**
 * Entfernt ein Munitionspack aus der Szene.
 * @param {string} id 
 */
export function entfernePickup(id) {
    const idx = pickups.findIndex(p => p.id === id);
    if (idx !== -1) {
        const p = pickups[idx];
        const scene = getScene();
        if (scene) scene.remove(p.model);
        entfernePickupModel(p.model);
        pickups.splice(idx, 1);
    }
}

/**
 * Entfernt das Gegner-Mesh wenn ein Spieler das Spiel verlässt.
 */
function entferneGegnerMesh() {
    if (gegnerMesh) {
        const scene = getScene();
        scene.remove(gegnerMesh);
        entferneZiel('gegner');
        gegnerMesh = null;
        console.log('[Spiel] Gegner-Mesh entfernt');
    }
}

// ═══════════════════════════════════════════════════════════
// LOBBY-LOGIK
// ═══════════════════════════════════════════════════════════

/**
 * Liest die Version aus dem Meta-Tag und aktualisiert die UI.
 */
function initVersionUI() {
    const meta = document.querySelector('meta[name="version"]');
    const display = document.getElementById('version-display');
    if (meta && display) {
        display.textContent = `v${meta.content} alpha`;
    }
}

/**
 * Initialisiert die gesamte Lobby-UI und Event-Handler.
 */
function initLobby() {
    initVersionUI(); // Version synchronisieren
    const startScreen = document.getElementById('start-screen');
    const lobbyScreen = document.getElementById('lobby-screen');
    const startButton = document.getElementById('start-button');
    const erstellenButton = document.getElementById('raum-erstellen-btn');
    const beitretenButton = document.getElementById('raum-beitreten-btn');
    const codeInput = document.getElementById('raum-code-input');
    const lobbyStatus = document.getElementById('lobby-status');
    const codeAnzeige = document.getElementById('raum-code-anzeige');
    const codeText = document.getElementById('raum-code-text');

    // Netzwerk-Manager erstellen
    netzwerk = new NetworkManager();

    // ── Startbildschirm → Lobby ─────────────────────────────
    startButton.addEventListener('click', () => {
        startScreen.style.display = 'none';
        lobbyScreen.style.display = 'flex';
    });

    // ── Solo-Test (Direkter Start ohne Netzwerk) ────────────
    const soloButton = document.getElementById('solo-test-button');
    if (soloButton) {
        soloButton.addEventListener('click', () => {
            startScreen.style.display = 'none';
            lobbyScreen.style.display = 'none';

            // Netzwerk-Initialisierung täuschen für Solo-Modus
            netzwerk.istHost = true;
            netzwerk.verbunden = false;
            // Dummy-Funktionen um Abstürze zu vermeiden
            netzwerk.sende = () => { };
            netzwerk.sendHit = () => { };
            netzwerk.sendPlayerPosition = () => { };
            netzwerk.startePositionsUpdates = () => { };
            netzwerk.sendeSeed = () => { };

            spielSeed = generiereZufallsSeed();

            // Szene initialisieren
            initSzene();

            // Spiel direkt starten
            starteSpielMitSeed(spielSeed, true);

            console.log('[Solo] Test-Modus gestartet (Seed: ' + spielSeed + ')');
        });
    }

    // ── Raum erstellen (Host) ───────────────────────────────
    erstellenButton.addEventListener('click', async () => {
        erstellenButton.disabled = true;
        beitretenButton.disabled = true;
        lobbyStatus.textContent = 'Raum wird erstellt...';

        try {
            const code = await netzwerk.erstelleRaum();
            codeAnzeige.style.display = 'block';
            codeText.textContent = code;

            // In Zwischenablage kopieren (mit Fallback für nicht-HTTPS Umgebungen)
            try {
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(code);
                    lobbyStatus.textContent = 'Raum erstellt & Code kopiert! 🎉';
                    console.log('[Netzwerk] Code via Clipboard-API kopiert');
                } else {
                    // FALLBACK: Veraltete Methode für file:// oder http:// ohne SSL
                    const textArea = document.createElement("textarea");
                    textArea.value = code;
                    textArea.style.position = "fixed"; // Versteckt ausführen
                    textArea.style.left = "-9999px";
                    textArea.style.top = "0";
                    document.body.appendChild(textArea);
                    textArea.focus();
                    textArea.select();
                    const erfolgreich = document.execCommand('copy');
                    document.body.removeChild(textArea);

                    if (erfolgreich) {
                        lobbyStatus.textContent = 'Raum erstellt & Code kopiert! 🎉';
                        console.log('[Netzwerk] Code via Fallback kopiert');
                    } else {
                        lobbyStatus.textContent = 'Raum erstellt! (Bitte manuell kopieren)';
                    }
                }
            } catch (clipErr) {
                console.warn('[Netzwerk] Clipboard-Fehler:', clipErr);
                lobbyStatus.textContent = 'Raum erstellt! (Fehler beim Kopieren)';
            }

            lobbyStatus.className = 'lobby-status verbunden';

            // Seed generieren
            spielSeed = generiereZufallsSeed();

            // Szene schon mal initialisieren
            initSzene();

            // Wenn Gegner verbindet
            netzwerk.onSpielerVerbunden = (peerId) => {
                lobbyStatus.textContent = 'Spieler verbunden! Spiel startet...';
                lobbyStatus.className = 'lobby-status verbunden';

                // Seed an Guest senden
                netzwerk.sendeSeed(spielSeed);

                // Gegner-Mesh erstellen
                erstelleGegnerMesh();

                // Netzwerk-Callbacks einrichten
                richteNetzwerkCallbacks();

                // Kurz warten dann Spiel starten
                setTimeout(() => {
                    starteSpielMitSeed(spielSeed, true);
                    netzwerk.sende('start', {});
                }, 500);
            };

            // Wenn Gegner disconnectet
            netzwerk.onSpielerGetrennt = () => {
                entferneGegnerMesh();
            };

        } catch (err) {
            lobbyStatus.textContent = 'Fehler: ' + err.message;
            lobbyStatus.className = 'lobby-status fehler';
            erstellenButton.disabled = false;
            beitretenButton.disabled = false;
        }
    });

    // ── Raum beitreten (Guest) ──────────────────────────────
    beitretenButton.addEventListener('click', async () => {
        const code = codeInput.value.trim().toUpperCase();
        if (code.length !== 4) {
            lobbyStatus.textContent = 'Bitte 4-Buchstaben-Code eingeben!';
            lobbyStatus.className = 'lobby-status fehler';
            return;
        }

        erstellenButton.disabled = true;
        beitretenButton.disabled = true;
        lobbyStatus.textContent = 'Verbinde mit Raum ' + code + '...';

        // Szene initialisieren
        initSzene();

        // Seed-Callback: Wenn Host den Seed sendet, Spiel starten
        netzwerk.onSeedEmpfangen = (seed) => {
            spielSeed = seed;
            erstelleGegnerMesh();
            richteNetzwerkCallbacks();

            setTimeout(() => {
                starteSpielMitSeed(seed, false);
            }, 300);
        };

        // Wenn Host disconnectet
        netzwerk.onSpielerGetrennt = () => {
            entferneGegnerMesh();
        };

        try {
            await netzwerk.treteRaumBei(code);
            lobbyStatus.textContent = 'Verbunden! Warte auf Spielstart...';
            lobbyStatus.className = 'lobby-status verbunden';
        } catch (err) {
            lobbyStatus.textContent = 'Raum nicht gefunden!';
            lobbyStatus.className = 'lobby-status fehler';
            erstellenButton.disabled = false;
            beitretenButton.disabled = false;
        }
    });

    // Code-Input: Auto-Uppercase und max 4 Zeichen
    codeInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').substring(0, 4);
    });

    // Enter-Taste im Code-Input → Beitreten
    codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            beitretenButton.click();
        }
    });
}

/**
 * Richtet die Netzwerk-Callbacks für das Spiel ein.
 */
function richteNetzwerkCallbacks() {
    // Gegner-Position empfangen
    netzwerk.onUpdateEnemyPosition((daten) => {
        if (gegnerMesh) {
            const zielPos = new THREE.Vector3(daten.x, daten.y, daten.z);

            // Wenn der Gegner noch unsichtbar ist oder sehr weit weg (Teleport/Start), 
            // setzen wir ihn SOFORT an die Position statt zu gleiten (lerp).
            const distanz = gegnerMesh.position.distanceTo(zielPos);

            if (!gegnerMesh.visible || distanz > 3.0) {
                gegnerMesh.position.copy(zielPos);
                console.log(`[Netzwerk] Gegner-Teleport nach (${daten.x}, ${daten.z})`);
            } else {
                // Sanfte Interpolation für normale Bewegung
                gegnerMesh.position.lerp(zielPos, 0.3);
            }

            gegnerMesh.rotation.y = daten.rotY || 0;
            gegnerMesh.visible = true;
        }
    });

    // Treffer empfangen
    netzwerk.onReceiveHit((daten) => {
        const restLeben = empfangeSchaden(daten.schaden);
        if (restLeben <= 0) {
            // Ich wurde besiegt → Gegner informieren
            netzwerk.sende('besiegt', {});
            zeigeErgebnis('NIEDERLAGE', '💀 Du wurdest besiegt!');
        }
    });

    netzwerk.onBesiegtEmpfangen = () => {
        zeigeErgebnis('SIEG', '🏆 Du hast gewonnen!');
    };

    // Munition-Pickup Synchronisation
    netzwerk.onPickupCollected = (pickupId) => {
        console.log(`[Netzwerk] Pickup eingesammelt durch Gegner: ${pickupId}`);
        entfernePickup(pickupId);
    };

    // Neue Munitionspacks empfangen (nur Gast)
    netzwerk.onNewPickup = (id, pos, typ) => {
        spawnNetzwerkPickup(id, pos, typ);
    };

    // Schüsse empfangen
    netzwerk.onSchussEmpfangen = (start, ende, hitType) => {
        const scene = getScene();
        let muzzlePos = start;

        // Wenn der Gegner existiert, holen wir die Position direkt von seiner Waffe
        if (gegnerMesh) {
            const waffe = gegnerMesh.children.find(c => c.name === 'weapon');
            if (waffe) {
                const tempPos = new THREE.Vector3(0, 0, -0.25);
                waffe.localToWorld(tempPos);
                muzzlePos = tempPos;
            }
        }

        triggereSchussVisuals(scene, muzzlePos, ende, hitType || 'SPARKS');
    };

    // WICHTIG: Neuen Seed für Runden-Neustart empfangen (nur Gast)
    netzwerk.onSeedEmpfangen = (seed) => {
        console.log('[Netzwerk] Neuer Seed empfangen, starte neue Runde!');
        stoppeNeustartTimer();
        spielSeed = seed;
        starteNeueRunde();
    };
}

/**
 * Zeigt das Sieg-/Niederlage-Overlay und startet nach 4 Sekunden neu.
 * @param {string} titel - 'SIEG' oder 'NIEDERLAGE'
 * @param {string} nachricht - Beschreibungstext
 */
function zeigeErgebnis(titel, nachricht) {
    rundeAktiv = false;
    const overlay = document.getElementById('ergebnis-overlay');
    const titelEl = document.getElementById('ergebnis-titel');
    const textEl = document.getElementById('ergebnis-text');
    const countdownEl = document.getElementById('ergebnis-countdown');

    // Punkte aktualisieren
    if (titel === 'SIEG') {
        eigenePunkte++;
    } else {
        gegnerPunkte++;
    }
    updateScoreAnzeige();

    if (overlay && titelEl && textEl) {
        titelEl.textContent = titel;
        titelEl.className = 'ergebnis-titel ' + (titel === 'SIEG' ? 'sieg' : 'niederlage');
        textEl.textContent = nachricht;
        overlay.style.display = 'flex';

        // Countdown für Neustart
        let countdown = 4;
        countdownEl.textContent = `Neue Runde in ${countdown}...`;

        if (neustartTimer) clearInterval(neustartTimer);

        neustartTimer = setInterval(() => {
            countdown--;
            countdownEl.textContent = `Neue Runde in ${countdown}...`;
            if (countdown <= 0) {
                stoppeNeustartTimer();
                starteNeueRunde();
            }
        }, 1000);
    }
}

/**
 * Aktualisiert die Score-Anzeige im HUD.
 */
function updateScoreAnzeige() {
    const eigenEl = document.getElementById('score-eigen');
    const gegnerEl = document.getElementById('score-gegner');
    if (eigenEl) eigenEl.textContent = eigenePunkte;
    if (gegnerEl) gegnerEl.textContent = gegnerPunkte;
    console.log(`[Score] Stand: ${eigenePunkte} : ${gegnerPunkte}`);
}

/**
 * Stoppt den Neustart-Countdown und blendet das Overlay aus.
 */
function stoppeNeustartTimer() {
    if (neustartTimer) {
        clearInterval(neustartTimer);
        neustartTimer = null;
    }
    const overlay = document.getElementById('ergebnis-overlay');
    if (overlay) overlay.style.display = 'none';
}

/**
 * Startet eine neue Runde mit neuem Labyrinth.
 */
function starteNeueRunde() {
    // Overlay & Timer stoppen
    stoppeNeustartTimer();

    // Renderer/Szene zurücksetzen (Singleton kümmert sich um Cleanup)
    const { scene, kamera } = initRenderer();

    // Kampf-Ziele resetten
    entferneAlleZiele();

    // Pickups säubern
    pickups.forEach(p => {
        scene.remove(p.model);
        entfernePickupModel(p.model);
    });
    pickups = [];

    // Gegner-Mesh wiederherstellen
    if (gegnerMesh) {
        scene.add(gegnerMesh);
        gegnerMesh.visible = false;
        // Wichtig: Gegner wieder als Ziel registrieren!
        registriereZiel(gegnerMesh);
    }

    // Leben & Munition zurücksetzen
    resetLeben();
    resetMunition();
    updateMunitionAnzeige();

    // Radar-Zustand resetten
    gegnerRadarPos = null;
    letzterRadarPingZeit = performance.now() / 1000;

    if (gegnerMesh) {
        gegnerMesh.position.set(0, 0, 0);
        gegnerMesh.visible = false;
    }

    rundeAktiv = true;

    // Neuen Seed generieren (Host) oder empfangen (Guest)
    // Host generiert neuen Seed und verteilt ihn
    if (netzwerk.istHost) {
        spielSeed = generiereZufallsSeed();
        console.log('[Spiel] Host generiert neuen Seed:', spielSeed);
        netzwerk.sendeSeed(spielSeed);
    }

    // WICHTIG: Beide bauen das Labyrinth mit dem (neuen) spielSeed auf
    starteSpielMitSeed(spielSeed, netzwerk.istHost);

    console.log('[Spiel] 🔄 Neue Runde gestartet!');
}

// ═══════════════════════════════════════════════════════════
// GAME LOOP
// ═══════════════════════════════════════════════════════════

/**
 * Der Haupt-Game-Loop. Wird jeden Frame aufgerufen.
 */
function gameLoop() {
    const frameStart = performance.now();
    requestAnimationFrame(gameLoop);

    if (!spielGestartet) {
        // Auch ohne Spielstart rendern (für Hintergrund-Effekte)
        if (getRenderer()) renderFrame();
        return;
    }

    const deltaZeit = uhr.getDelta();
    const aktuelleZeit = uhr.getElapsedTime();
    const kamera = getKamera();
    const scene = getScene();

    // Profiling-Helfer
    const messpunkt = (name, start) => {
        const dauer = performance.now() - start;
        if (dauer > 2.0) { // Nur melden wenn > 2ms (kritische Schwelle)
            console.warn(`[Profile] ${name} dauerte ${dauer.toFixed(2)}ms`);
        }
        return performance.now();
    };

    let p = performance.now();

    // ── 1. Eingabe & Kamera ──────────────────────────────
    const lookDelta = getLookDelta();
    updateKameraRotation(lookDelta);
    p = messpunkt("Eingabe/Rotation", p);

    // ── 2. Spieler bewegen (Kollision) ──────────────────
    bewegeSpieler(kamera, deltaZeit, getGierWinkel(), labyrinth);
    p = messpunkt("Bewegung/Kollision", p);

    // ── Pickups prüfen (Gedrosselt) ──────────────
    if (aktuelleZeit - letztesPickupUpdate > 1 / PICKUP_FPS) {
        updatePickups();
        letztesPickupUpdate = aktuelleZeit;
        p = messpunkt("Pickups", p);
    }

    // ── 3. Schuss prüfen ────────────────────────────────────
    if (rundeAktiv && verbrauchSchuss()) {
        const ergebnis = schiessen(kamera, scene, aktuelleZeit);

        // Schuss ans Netzwerk senden (Visuals für den Gegner)
        if (netzwerk.verbunden && ergebnis.strahlStart && ergebnis.strahlEnde) {
            netzwerk.sendeSchuss(ergebnis.strahlStart, ergebnis.strahlEnde, ergebnis.hitType);
        }

        if (ergebnis.treffer) {
            // Schaden senden, den wir in combat.js berechnet haben (Headshot-Support)
            netzwerk.sendHit(ergebnis.spielerId, ergebnis.schaden, ergebnis.hitType);
        }
        p = messpunkt("Schiessen", p);
    }

    // ── 4. Kampf-System & Effekte ───────────────────────
    updateCombat(deltaZeit, kamera);
    updateFackeln(aktuelleZeit);
    p = messpunkt("Combat/FX-Update", p);

    // ── Munition Respawn (nur Host) ──────────────────────────
    if (netzwerk.istHost && rundeAktiv) {
        if (aktuelleZeit - letzterRespawnZeit > RESPAWN_INTERVAL) {
            letzterRespawnZeit = aktuelleZeit;
            if (pickups.length < MAX_PICKUPS_ON_GROUND) {
                // 80% Munition, 20% Heilung
                const r = Math.random();
                const typ = r < 0.8 ? 'AMMO' : 'HEALTH';
                spawnEinzelnesPickup(typ);
            }
        }
    }

    // ── Netzwerk: Position senden ────────────────────────
    // Wir senden die Bodenposition (Y=0), nicht die Kamerahöhe!
    // Nutze Temp-Objekt um Allokation zu vermeiden
    bodenPosTemp.set(kamera.position.x, 0, kamera.position.z);
    netzwerk.sendPlayerPosition(bodenPosTemp, kamera.rotation);
    p = messpunkt("Netzwerk-Send", p);


    // ── 5. Minimap (Gedrosselt) ─────
    if (aktuelleZeit - letztesMinimapUpdate > 1 / MINIMAP_FPS) {
        zeichneMinimap(kamera);
        letztesMinimapUpdate = aktuelleZeit;
        p = messpunkt("Minimap", p);
    }

    // ── 6. Rendern ──────────────────────────────────────────
    renderFrame();
    p = messpunkt("Rendern", p);

    const frameGesamt = performance.now() - frameStart;
    if (frameGesamt > 16.6) { // Länger als ein 60FPS Frame
        // console.warn(`[Profile] Gesamter Frame dauerte ${frameGesamt.toFixed(2)}ms`);
    }
}

// ═══════════════════════════════════════════════════════════
// MINIMAP
// ═══════════════════════════════════════════════════════════

function initMinimap() {
    minimapCanvas = document.getElementById('minimap');
    if (!minimapCanvas || !labyrinth) return;

    const w = labyrinth[0].length * MINIMAP_ZELLGROESSE;
    const h = labyrinth.length * MINIMAP_ZELLGROESSE;

    minimapCanvas.width = w;
    minimapCanvas.height = h;
    minimapCtx = minimapCanvas.getContext('2d');

    // Hintergrund-Cache erstellen
    minimapBackgroundCanvas = document.createElement('canvas');
    minimapBackgroundCanvas.width = w;
    minimapBackgroundCanvas.height = h;
    minimapBackgroundCtx = minimapBackgroundCanvas.getContext('2d');

    // Einmalig das Labyrinth in den Cache zeichnen
    for (let y = 0; y < labyrinth.length; y++) {
        for (let x = 0; x < labyrinth[y].length; x++) {
            minimapBackgroundCtx.fillStyle = labyrinth[y][x] === 1 ? '#555' : '#222';
            minimapBackgroundCtx.fillRect(x * MINIMAP_ZELLGROESSE, y * MINIMAP_ZELLGROESSE, MINIMAP_ZELLGROESSE, MINIMAP_ZELLGROESSE);
        }
    }
    console.log('[Minimap] Hintergrund-Cache erstellt');
}

function zeichneMinimap(kamera) {
    if (!minimapCtx || !minimapBackgroundCanvas) return;
    const ctx = minimapCtx;
    const z = MINIMAP_ZELLGROESSE;

    // 1. Hintergrund aus Cache kopieren (Konstante Zeit, sehr schnell!)
    ctx.drawImage(minimapBackgroundCanvas, 0, 0);

    // Spieler (grün)
    const sX = (kamera.position.x / WAND_GROESSE + 0.5);
    const sZ = (kamera.position.z / WAND_GROESSE + 0.5);
    ctx.fillStyle = '#44ff44';
    ctx.beginPath();
    ctx.arc(sX * z, sZ * z, 3, 0, Math.PI * 2);
    ctx.fill();

    // Blickrichtung
    const gier = getGierWinkel();
    ctx.strokeStyle = '#44ff44';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sX * z, sZ * z);
    ctx.lineTo((sX - Math.sin(gier) * 2) * z, (sZ - Math.cos(gier) * 2) * z);
    ctx.stroke();

    // Gegner (rot, Radar-Ping System)
    if (gegnerMesh && gegnerMesh.visible) {
        // Zeit prüfen für neuen Ping
        const aktuelleZeit = performance.now() / 1000;

        // Fix: Radar-Ping nur wenn genug Zeit seit letztem Ping vergangen ist
        // Verhindert Sofort-Ping bei !gegnerRadarPos direkt nach Rundenstart
        const zeitSeitLetztemPing = aktuelleZeit - letzterRadarPingZeit;

        if (!gegnerRadarPos || zeitSeitLetztemPing >= RADAR_INTERVALL) {
            // Nur pingen, wenn wir nicht gerade erst die Runde gestartet haben (Sicherheitsmarge 0.5s)
            if (zeitSeitLetztemPing > 0.5) {
                gegnerRadarPos = {
                    x: gegnerMesh.position.x,
                    z: gegnerMesh.position.z
                };
                letzterRadarPingZeit = aktuelleZeit;
            }
        }

        // Radar-Punkt zeichnen (nur wenn bereits ein Ping vorliegt)
        if (gegnerRadarPos) {
            const gX = (gegnerRadarPos.x / WAND_GROESSE + 0.5);
            const gZ = (gegnerRadarPos.z / WAND_GROESSE + 0.5);

            ctx.fillStyle = '#ff4444';
            ctx.beginPath();
            ctx.arc(gX * z, gZ * z, 3, 0, Math.PI * 2);
            ctx.fill();

            // Visueller Ping-Effekt (Aufleuchten direkt nach Update)
            const zeitSeitPing = aktuelleZeit - letzterRadarPingZeit;
            const PING_EFFEKT_DAUER = 1.5; // Wie lange es leuchtet

            if (zeitSeitPing < PING_EFFEKT_DAUER) {
                const fortschritt = zeitSeitPing / PING_EFFEKT_DAUER;
                const radius = 3 + fortschritt * 12; // Ring wird größer
                const opacity = 1.0 - fortschritt;    // Ring verblasst

                ctx.strokeStyle = `rgba(255, 68, 68, ${opacity})`;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(gX * z, gZ * z, radius, 0, Math.PI * 2);
                ctx.stroke();

                // Zusätzlicher Blitz/Leuchten des Kerns
                ctx.fillStyle = `rgba(255, 200, 200, ${opacity * 0.5})`;
                ctx.beginPath();
                ctx.arc(gX * z, gZ * z, 5, 0, Math.PI * 2);
                ctx.fill();
            } else {
                // Normaler feiner Ring im statischen Zustand
                ctx.strokeStyle = 'rgba(255, 68, 68, 0.3)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.arc(gX * z, gZ * z, 5, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
    }
}

/**
 * Erkennt ob das Gerät ein Mobilgerät ist.
 * @returns {boolean}
 */
function istMobileGeraet() {
    return ('ontouchstart' in window) ||
        (navigator.maxTouchPoints > 0) ||
        (window.innerWidth < 768);
}

// ── App starten ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    console.log("%c ═══════════════════════════════════════════", "color: #ffaa44; font-weight: bold;");
    console.log("%c    🎮 RETRO-LABYRINTH v1.3.1 - Spiel wird geladen...", "color: #ffaa44; font-weight: bold;");
    console.log("%c ═══════════════════════════════════════════", "color: #ffaa44; font-weight: bold;");

    initLobby();
    gameLoop();
});
