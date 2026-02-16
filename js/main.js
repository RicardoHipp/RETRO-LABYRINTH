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
    WAND_HOEHE,
    WAND_GROESSE
} from './maze-generator.js';
import { initInput, getLookDelta, bewegeSpieler, verbrauchSchuss, wurdeMinePlatziert, getMovementVector } from './input-handler.js';
import { initRenderer, updateKameraRotation, getGierWinkel, updateSpielerLicht, prepareRenderer, renderFrame, getKamera, getScene, getRenderer, AUGEN_HOEHE, erzeugePickupModel, entfernePickupModel, initPickupPools, erzeugeScharfeMineModel } from './renderer.js';
import { initCombat, warmupCombat, schiessen, updateCombat, registriereZiel, entferneZiel, entferneAlleZiele, empfangeSchaden, healPlayer, updateLebenAnzeige, resetLeben, addMunition, updateMunitionAnzeige, resetMunition, getMunition, MAX_MUNITION, triggereSchussVisuals, getLeben, MAX_LEBEN, addMine, hasMine, nutzeMine, SCHADEN_MINE, setOnTodCallback, getMinen } from './combat.js';
import { NetworkManager } from './network-manager.js';

// ── Spiel-Einstellungen ─────────────────────────────────────
const LABYRINTH_BREITE = 8;   // Zellen (Gesamtraster wird 2*8+1 = 17)
const LABYRINTH_HOEHE = 8;
const MAX_PICKUPS_ON_GROUND = 8; // Maximal 8 Munitionspacks (40 Schuss) auf dem Boden
const MAX_TOTAL_MINES_ON_MAP = 4; // Maximal 4 Minen-Pickups gleichzeitig
const RESPAWN_INTERVAL = 5;      // Alle 5 Sekunden prüfen

// ── Spawn-Wahrscheinlichkeiten (unabhängig voneinander) ──
const SPAWN_CHANCE_MINE = 1;  // 5%  - Selten, strategisch
const SPAWN_CHANCE_HEALTH = 0.15;  // 15% - Gelegentlich
// Wenn keines greift → AMMO (Fallback)

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
let aktiveMinen = []; // Liste der scharfen Minen: {id, pos, model, ownerId}
let neustartTimer = null; // Globaler Timer für Neustart-Countdown
let minenRadarTimer = 0; // Timer für Minen-Hilfe auf Minimap
let gegnerMinenInventar = 0; // Minen im Gegner-Inventar (Host zählt mit)

// Radar-Ping System (Gegner auf Minimap)
let gegnerRadarPos = null;      // Die zuletzt "gepinnte" Position
let letzterRadarPingZeit = 0;   // Zeit des letzten Pings
const RADAR_INTERVALL = 5.0;    // Alle 5 Sekunden ein Update

// Drosselung von unkritischen Systemen (Performance)
let letztesMinimapUpdate = 0;
const MINIMAP_FPS = 5; // 20 Updates pro Sekunde reichen völlig
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

    // Alte Pickups aufräumen (Pool-Modelle bleiben in der Szene!)
    for (let p of pickups) {
        entfernePickupModel(p.model);
    }
    pickups = [];

    const useLambert = document.getElementById('high-perf-mode')?.checked || false;
    labyrinth = generateMaze(LABYRINTH_BREITE, LABYRINTH_HOEHE, seed);
    buildMazeGeometry(scene, labyrinth, useLambert);

    // Wandbeleuchtung hinzufügen
    addWallLights(scene, labyrinth);

    // Munitionspacks spawnen
    spawnInitialPickups(seed);

    // Shader Pre-compilation (verhindert Ruckler beim Loslaufen)
    prepareRenderer(scene, kamera);

    // Spieler spawnen – Dynamisch basierend auf Seed
    const startShift = seed % 1000;
    const hostIndex = startShift;
    const guestIndex = startShift + Math.floor(LABYRINTH_BREITE * LABYRINTH_HOEHE * 0.4);

    const spawnIndex = istHost ? hostIndex : guestIndex;
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

    // Grafik-Status im HUD aktualisieren (Echte Prüfung!)
    updateGrafikStatus();

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

    const anzahl = 8;
    for (let i = 0; i < anzahl; i++) {
        // Mix aus Items für den Start: 5x Ammo, 2x Health, 1x Mine
        let typ = 'AMMO';
        if (i === 5 || i === 6) typ = 'HEALTH';
        if (i === 7) typ = 'MINE';

        spawnEinzelnesPickup(typ, seededRandom, `pickup_init_${i}`, false);
    }
    console.log(`[Spiel] ${anzahl} Initial-Pickups gespawnt. Array-Länge: ${pickups.length}`);
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

    // DEBUG: Modell-Status prüfen
    console.log(`[DEBUG Spawn] typ=${typ}, pos=(${pos.x.toFixed(1)}, ${pos.z.toFixed(1)}), visible=${model.visible}, inScene=${!!model.parent}, active=${model.userData.active}`);

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
        case 'MINE':
            return addMine(1); // Gibt true zurück wenn Inventar nicht voll
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
        // NICHT scene.remove()! Das Modell bleibt in der Szene (Pool),
        // wird aber durch entfernePickupModel versteckt (visible=false)
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

    // ── Fullscreen-Toggle Logik ─────────────────────────────
    const fsToggle = document.getElementById('fullscreen-toggle');
    if (fsToggle) {
        // 1. Klick auf Toggle schaltet direkt um
        fsToggle.addEventListener('change', () => {
            if (fsToggle.checked) {
                requestFullscreen();
            } else {
                exitFullscreen();
            }
        });

        // 2. Synchronisation bei externen Änderungen (z.B. ESC)
        document.addEventListener('fullscreenchange', () => {
            fsToggle.checked = !!document.fullscreenElement;
        });
        // Webkit Fallback
        document.addEventListener('webkitfullscreenchange', () => {
            fsToggle.checked = !!document.webkitFullscreenElement;
        });
    }

    // ── Startbildschirm → Lobby ─────────────────────────────
    startButton.addEventListener('click', () => {
        startScreen.style.display = 'none';
        lobbyScreen.style.display = 'flex';
        // Falls Toggle aktiviert, Fullscreen anfordern (falls nicht schon aktiv)
        if (document.getElementById('fullscreen-toggle').checked) {
            requestFullscreen();
        }
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
            // Falls Toggle aktiviert, Fullscreen anfordern
            if (document.getElementById('fullscreen-toggle').checked) {
                requestFullscreen();
            }

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

    // Minen-Aktionen empfangen
    netzwerk.onMineEvent((typ, daten) => {
        if (typ === 'mine_placed') {
            const { id, pos } = daten;
            // Gegner hat Mine gelegt -> bei uns spawnen (als 'gegner'-Mine)
            // pos ist ein einfaches Objekt {x,y,z}, wir brauchen Vector3
            const vecPos = new THREE.Vector3(pos.x, pos.y, pos.z);
            platziereMine(id, vecPos, 'gegner');
            gegnerMinenInventar = Math.max(0, gegnerMinenInventar - 1);
            console.log(`[Netzwerk] Gegner-Mine platziert: ${id}. Gegner-Inventar: ${gegnerMinenInventar}`);
        } else if (typ === 'mine_exploded') {
            entferneMine(daten.id, true); // Mit Effekt
            console.log('[Netzwerk] Mine explodiert:', daten.id);
        }
    });

    // Zentraler Tod-Callback: Wird bei JEDEM Schaden automatisch ausgelöst,
    // egal ob durch Schuss, Mine oder zukünftige Items
    setOnTodCallback(() => {
        netzwerk.sende('besiegt', {});
        zeigeErgebnis('NIEDERLAGE', '💀 Du wurdest besiegt!');
    });

    // Treffer empfangen
    netzwerk.onReceiveHit((daten) => {
        empfangeSchaden(daten.schaden);
        // Tod wird automatisch durch setOnTodCallback behandelt!
    });

    netzwerk.onBesiegtEmpfangen = () => {
        zeigeErgebnis('SIEG', '🏆 Du hast gewonnen!');
    };

    // Munition-Pickup Synchronisation
    netzwerk.onPickupCollected = (pickupId) => {
        console.log(`[Netzwerk] Pickup eingesammelt durch Gegner: ${pickupId}`);
        // Wenn Gegner eine Mine einsammelt -> mitzählen
        const pickup = pickups.find(p => p.id === pickupId);
        if (pickup && pickup.typ === 'MINE') {
            gegnerMinenInventar++;
            console.log(`[Minen] Gegner hat Mine eingesammelt. Gegner-Inventar: ${gegnerMinenInventar}`);
        }
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
    const useLambert = document.getElementById('high-perf-mode')?.checked || false;

    // Kampf-Ziele resetten
    entferneAlleZiele();

    // Pickups säubern (Pool-Modelle bleiben in der Szene!)
    pickups.forEach(p => {
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

    // Grafik-Status aktualisieren
    updateGrafikStatus();

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

    // Radar-Timer aktualisieren
    if (minenRadarTimer > 0) {
        minenRadarTimer -= deltaZeit;
    }

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

    // ── 4b. Minen-Logik (Platzieren & Auslösen) ──────────
    // A) Platzieren oder Radar aktivieren
    if (wurdeMinePlatziert() && rundeAktiv) {
        if (hasMine()) {
            const moveVec = getMovementVector();
            const lookDir = new THREE.Vector3();
            kamera.getWorldDirection(lookDir);
            lookDir.y = 0;
            lookDir.normalize();

            const offset = new THREE.Vector3();

            // Logik: 
            // Bewegung -> Entgegen der Bewegung
            // Stand -> In Blickrichtung (Vorne)
            if (moveVec.vorwaerts !== 0 || moveVec.seitwaerts !== 0) {
                // Wir bewegen uns -> Offset entgegen der Bewegung berechnen
                // Bewegung ist relativ zur Kamera!
                const gier = getGierWinkel();
                const dx = (-Math.sin(gier) * moveVec.vorwaerts + Math.cos(gier) * moveVec.seitwaerts);
                const dz = (-Math.cos(gier) * moveVec.vorwaerts - Math.sin(gier) * moveVec.seitwaerts);

                // Entgegen: Negieren
                offset.set(-dx, 0, -dz).normalize();
            } else {
                // Stillstand -> Vorne
                offset.copy(lookDir);
            }

            const dropPos = kamera.position.clone().add(offset.multiplyScalar(1.5));
            dropPos.y = 0.1; // Bodenhöhe

            // Check: Nicht in Wand platzieren
            if (!istWand(labyrinth, dropPos.x, dropPos.z)) {
                const mineId = `mine_${netzwerk.spielerId}_${Date.now()}`;
                platziereMine(mineId, dropPos, netzwerk.spielerId);
                nutzeMine();
                netzwerk.sende('mine_placed', { id: mineId, pos: dropPos });
                console.log('[Spiel] Mine platziert!');
            } else {
                console.log('[Spiel] Platzieren fehlgeschlagen: Wand im Weg');
            }
        } else {
            // Keine Mine im Inventar -> Radar aktivieren
            minenRadarTimer = 3.0; // 3 Sekunden anzeigen
            const count = pickups.filter(p => p.typ === 'MINE').length;
            console.log(`[Gameplay] Radar aktiviert! Minen auf Map: ${count}`);
        }
    }

    // B) Auslösen & Animation
    // Rückwärts schleifen für sicheres Entfernen
    const spielerPos = kamera.position;
    for (let i = aktiveMinen.length - 1; i >= 0; i--) {
        const mine = aktiveMinen[i];

        // Blink-Animation des Lichts
        if (mine.model) {
            const blinkLight = mine.model.getObjectByName('blinkLight');
            if (blinkLight) {
                // 5 Hz Blinken
                const s = Math.sin(aktuelleZeit * 10);
                blinkLight.material.color.setHex(s > 0 ? 0xff0000 : 0x550000);
            }
        }

        // Trigger-Check (nur wenn Runde aktiv)
        if (rundeAktiv) {
            // Nur X/Z Distanz prüfen (Höhe ignorieren!)
            const dx = spielerPos.x - mine.pos.x;
            const dz = spielerPos.z - mine.pos.z;
            const distSq2D = dx * dx + dz * dz;

            // 0.8 Radius -> 0.64 squared
            if (distSq2D < 0.64) {
                console.log(`[Spiel] BOOM! Mine ${mine.id} ausgelöst! Dist: ${Math.sqrt(distSq2D).toFixed(2)}`);

                // Schaden an Spieler (Tod wird automatisch durch setOnTodCallback behandelt)
                empfangeSchaden(SCHADEN_MINE);

                // Entfernen & Effekt
                entferneMine(mine.id, true);
                netzwerk.sende('mine_exploded', { id: mine.id });
            }
        }
    }

    // ── Munition Respawn (nur Host) ──────────────────────────
    // DEBUG: Minen-Status (immer sichtbar)
    if (aktuelleZeit - letzterRespawnZeit > RESPAWN_INTERVAL - 0.1) {
        const _mp = pickups.filter(p => p.typ === 'MINE').length;
        const _mi = getMinen();
        const _ma = aktiveMinen.length;
        console.log(`[DEBUG Minen] Pickups=${_mp}, Inventar=${_mi}, Ausgelegt=${_ma}, GESAMT=${_mp + _mi + _ma}/${MAX_TOTAL_MINES_ON_MAP} | istHost=${netzwerk?.istHost}, rundeAktiv=${rundeAktiv}`);
    }
    if (netzwerk.istHost && rundeAktiv) {
        if (aktuelleZeit - letzterRespawnZeit > RESPAWN_INTERVAL) {
            letzterRespawnZeit = aktuelleZeit;
            if (pickups.length < MAX_PICKUPS_ON_GROUND) {
                // Pickup-Typ nach Wahrscheinlichkeit wählen
                let typ = 'AMMO';

                // Gesamtanzahl aller Minen im Spiel:
                // Pickups auf dem Boden + eigenes Inventar + ausgelegte aktive Minen
                const minenPickups = pickups.filter(p => p.typ === 'MINE').length;
                const minenInventar = getMinen();
                const minenAusgelegt = aktiveMinen.length;
                const minenGesamt = minenPickups + minenInventar + minenAusgelegt + gegnerMinenInventar;

                console.log(`[Spawn] Minen-Check: Pickups=${minenPickups}, Inventar=${minenInventar}, Gegner=${gegnerMinenInventar}, Ausgelegt=${minenAusgelegt}, GESAMT=${minenGesamt}/${MAX_TOTAL_MINES_ON_MAP}`);

                // Jedes Item hat einen eigenen, unabhängigen Würfel
                if (Math.random() < SPAWN_CHANCE_MINE && minenGesamt < MAX_TOTAL_MINES_ON_MAP) {
                    typ = 'MINE';
                } else if (Math.random() < SPAWN_CHANCE_HEALTH) {
                    typ = 'HEALTH';
                }
                // Sonst bleibt typ = 'AMMO' (Fallback)

                console.log(`[Spawn] → ${typ} gespawnt`);
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
    // --- Minen-Radar: Zeige Minen-Pickups auf der Map ---
    if (minenRadarTimer > 0) {
        pickups.forEach(p => {
            if (p.typ === 'MINE') {
                const pX = (p.pos.x / WAND_GROESSE + 0.5);
                const pZ = (p.pos.z / WAND_GROESSE + 0.5);

                const alpha = Math.min(1.0, minenRadarTimer);
                ctx.fillStyle = `rgba(255, 0, 0, ${alpha})`;

                ctx.beginPath();
                ctx.arc(pX * z, pZ * z, 4, 0, Math.PI * 2);
                ctx.fill();
            }
        });
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
/**
 * Prüft das tatsächlich verwendete Material im Renderer und aktualisiert das HUD.
 * Dient zur Verifikation des Performance-Modus.
 */
function updateGrafikStatus() {
    const statusEl = document.getElementById('grafik-status');
    const scene = getScene();
    if (!statusEl || !scene) return;

    // Wir suchen das "wallGroup" Objekt
    const wallGroup = scene.getObjectByName('wallGroup');
    let modus = 'UNKNOWN';
    let farbe = '#aaa';

    if (wallGroup && wallGroup.children.length > 0) {
        // Wir nehmen das erste Mesh (Wand) und prüfen das Material
        const mesh = wallGroup.children[0];
        if (mesh.material) {
            // Bei InstancedMesh kann material auch ein Array sein, wir prüfen den Typ
            const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;

            if (mat.type === 'MeshLambertMaterial') {
                modus = 'GFX: PERF'; // Performance (Lambert)
                farbe = '#44ff44';   // Grün
            } else if (mat.type === 'MeshPhongMaterial') {
                modus = 'GFX: HIGH'; // High Quality (Phong)
                farbe = '#ffaa44';   // Orange
            } else {
                modus = `GFX: ${mat.type}`;
            }
        }
    }

    statusEl.textContent = modus;
    statusEl.style.color = farbe;
    console.log(`[Grafik] Aktiver Modus verifiziert: ${modus}`);
}

/**
 * Platziert eine Mine in der Welt.
 */
function platziereMine(id, pos, ownerId) {
    const scene = getScene();
    if (!scene) return;

    const model = erzeugeScharfeMineModel();
    model.position.copy(pos);
    model.userData.id = id;
    model.userData.ownerId = ownerId;
    scene.add(model);

    aktiveMinen.push({
        id: id,
        pos: pos,
        model: model,
        ownerId: ownerId
    });
}

/**
 * Entfernt eine Mine (mit optionalem Effekt).
 */
function entferneMine(id, visualEffect = false) {
    const idx = aktiveMinen.findIndex(m => m.id === id);
    if (idx !== -1) {
        const mine = aktiveMinen[idx];
        const scene = getScene();

        if (scene) scene.remove(mine.model);

        // Cleanup Geometry/Material nicht zwingend nötig bei wenigen Objekten, aber sauberer
        // Hier lassen wir es erstmal, da Three.js das bei Mesh-Removal nicht automatisch macht

        if (visualEffect) {
            triggereExplosionseffekt(mine.pos);
        }

        aktiveMinen.splice(idx, 1);
        console.log(`[Spiel] Mine ${id} entfernt.`);
    }
}

/**
 * Erzeugt einen Explosionseffekt.
 */
function triggereExplosionseffekt(pos) {
    const scene = getScene();
    if (!scene) return;

    // Wir nutzen das existierende Partikel-System-Pooling von Combat via "triggereSchussVisuals"?
    // Nein, das ist für Vector-Start-Ende gedacht.
    // Wir bauen einen einfachen eigenen Effekt oder nutzen erzeugeEinschlag mehrfach.

    // Einfacher Hack: Mehrere Funken-Einschläge simulieren
    for (let i = 0; i < 5; i++) {
        const offset = new THREE.Vector3(
            (Math.random() - 0.5) * 0.5,
            (Math.random()) * 0.5,
            (Math.random() - 0.5) * 0.5
        );
        // Wir tricksen und rufen die Combat-Funktion via eines "virtuellen" Schusses auf, 
        // oder besser: Wir brauchen Zugriff auf erzeugeEinschlag in Combat, aber das ist privat.
        // Alternative: Wir nutzen einen Sound und lassen es gut sein :D 

        // Doch, triggereSchussVisuals ist exportiert!
        // Wir faken einen Schuss von oben nach unten auf die Mine
        const start = pos.clone().add(offset).add(new THREE.Vector3(0, 1, 0));
        triggereSchussVisuals(scene, start, pos.clone().add(offset), 'BLOOD'); // BLOOD = Rot/Groß
    }
}

/**
 * Versucht die Anwendung in den Fullscreen-Modus zu versetzen.
 * Muss durch ein User-Event (Click) getriggert werden.
 */
function requestFullscreen() {
    try {
        const de = document.documentElement;
        if (de.requestFullscreen) {
            de.requestFullscreen();
        } else if (de.webkitRequestFullscreen) {
            de.webkitRequestFullscreen(); // Safari / iOS Chrome
        } else if (de.msRequestFullscreen) {
            de.msRequestFullscreen(); // IE/Edge
        }
    } catch (err) {
        console.warn("[Fullscreen] Fehlgeschlagen oder nicht unterstützt:", err);
    }
}

/**
 * Verlässt den Fullscreen-Modus.
 */
function exitFullscreen() {
    try {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
    } catch (err) {
        console.warn("[Fullscreen] Exit fehlgeschlagen:", err);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log("%c ═══════════════════════════════════════════", "color: #ffaa44; font-weight: bold;");
    console.log("%c    🎮 RETRO-LABYRINTH v1.3.1 - Spiel wird geladen...", "color: #ffaa44; font-weight: bold;");
    console.log("%c ═══════════════════════════════════════════", "color: #ffaa44; font-weight: bold;");

    initLobby();
    gameLoop();

    // PWA Service Worker registrieren
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('[PWA] Service Worker registriert', reg))
            .catch(err => console.warn('[PWA] SW Fehler', err));
    }
});
