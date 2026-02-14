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

import { generateMaze, buildMazeGeometry, findeFreiePosition, generiereZufallsSeed, WAND_GROESSE } from './maze-generator.js';
import { initInput, getLookDelta, bewegeSpieler, verbrauchSchuss } from './input-handler.js';
import { initRenderer, updateKameraRotation, getGierWinkel, updateSpielerLicht, renderFrame, getKamera, getScene, getRenderer, AUGEN_HOEHE, erzeugeMunitionModel, entfernePickupModel } from './renderer.js';
import { initCombat, schiessen, updateCombat, registriereZiel, entferneZiel, entferneAlleZiele, empfangeSchaden, updateLebenAnzeige, resetLeben, addMunition, updateMunitionAnzeige, resetMunition, getMunition, MAX_MUNITION } from './combat.js';
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
let munitionPickups = []; // Liste der verfügbaren Munitionspacks
let neustartTimer = null; // Globaler Timer für Neustart-Countdown

// Radar-Ping System (Gegner auf Minimap)
let gegnerRadarPos = null;      // Die zuletzt "gepinnte" Position
let letzterRadarPingZeit = 0;   // Zeit des letzten Pings
const RADAR_INTERVALL = 5.0;    // Alle 5 Sekunden ein Update

// ── Minimap ─────────────────────────────────────────────────
let minimapCanvas = null;
let minimapCtx = null;
const MINIMAP_ZELLGROESSE = 4;

/**
 * Initialisiert die Grundsysteme (Three.js etc.) OHNE Labyrinth.
 */
function initSzene() {
    const { renderer, kamera, scene } = initRenderer();
    initInput(renderer.domElement);
    initCombat(scene, kamera);
    updateLebenAnzeige();
    uhr = new THREE.Clock();
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
    for (let p of munitionPickups) {
        scene.remove(p.model);
        entfernePickupModel(p.model);
    }
    munitionPickups = [];

    // Labyrinth generieren (gleicher Seed = gleiches Labyrinth)
    labyrinth = generateMaze(LABYRINTH_BREITE, LABYRINTH_HOEHE, seed);
    buildMazeGeometry(scene, labyrinth);

    // Munition spawnen
    spawnMunitionPacks(seed);

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

    // Lobby ausblenden, Spiel einblenden
    document.getElementById('lobby-screen').style.display = 'none';

    // Touch-Steuerung auf Mobile anzeigen
    if (istMobileGeraet()) {
        document.getElementById('touch-controls').style.display = 'block';
    }

    // Hinweis: PointerLock wird erst durch User-Interaktion (Klick) aktiviert
    // um WrongDocumentError zu vermeiden.

    // Positions-Updates starten
    netzwerk.startePositionsUpdates();

    spielGestartet = true;
    console.log('[Spiel] ✅ Spiel gestartet!');
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

    // Startposition (wird durch Netzwerk sofort überschrieben)
    gegnerMesh.position.set(0, 0.8, 0);
    gegnerMesh.visible = false; // Erst sichtbar wenn Position empfangen

    // Als Ziel für Raycasting registrieren
    gegnerMesh.userData.spielerId = 'gegner'; // Wichtig für Trefferauswertung!
    registriereZiel(gegnerMesh);
    scene.add(gegnerMesh);

    console.log('[Spiel] Gegner-Mesh erstellt');
}

/**
 * Spawnt Munitionspacks im Labyrinth basierend auf dem Seed.
 * @param {number} seed 
 */
function spawnMunitionPacks(seed) {
    // Einfacher Zufallsgenerator basierend auf Seed
    let random = seed;
    const seededRandom = () => {
        random = (random * 16807) % 2147483647;
        return (random - 1) / 2147483646;
    };

    const anzahl = 6; // Starten mit 6 Packs
    for (let i = 0; i < anzahl; i++) {
        spawnEinzelnesPickup(seededRandom);
    }
    console.log(`[Spiel] ${anzahl} Munitionspacks zum Start gespawnt`);
}

/**
 * Spawnt ein einzelnes Munitionspack an einer zufälligen freien Stelle.
 * @param {function} randomFunc - Optionale Zufallsfunktion
 */
function spawnEinzelnesPickup(randomFunc = Math.random) {
    const scene = getScene();
    if (!scene) return null;

    const randIdx = Math.floor(randomFunc() * LABYRINTH_BREITE * LABYRINTH_HOEHE);
    const pos = findeFreiePosition(labyrinth, randIdx);

    // Eindeutige ID generieren
    const id = `ammo_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const model = erzeugeMunitionModel();
    model.position.set(pos.x, 0.5, pos.z);
    scene.add(model);

    munitionPickups.push({
        id: id,
        pos: pos,
        model: model
    });

    // Wenn Host: Gast informieren
    if (netzwerk && netzwerk.istHost && netzwerk.verbunden) {
        netzwerk.sende('new_pickup', { id, pos });
    }

    return id;
}

/**
 * Spawnt ein Pickup an einer im Netzwerk empfangenen Position (nur Gast).
 * @param {string} id 
 * @param {object} pos 
 */
export function spawnNetzwerkPickup(id, pos) {
    const scene = getScene();
    if (!scene) return;

    const model = erzeugeMunitionModel();
    model.position.set(pos.x, 0.5, pos.z);
    scene.add(model);

    munitionPickups.push({
        id: id,
        pos: pos,
        model: model
    });
    console.log(`[Netzwerk] Neues Munitionspack empfangen: ${id}`);
}

/**
 * Prüft auf Kollisionen mit Munitionspacks.
 */
function updatePickups() {
    if (!spielGestartet || !rundeAktiv) return;

    const kamera = getKamera();
    const spielerPos = kamera.position;

    for (let i = munitionPickups.length - 1; i >= 0; i--) {
        const p = munitionPickups[i];
        const dx = spielerPos.x - p.pos.x;
        const dz = spielerPos.z - p.pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        // Einsammel-Radius: 0.6 Einheiten
        if (dist < 0.6) {
            // Nur einsammeln, wenn das Limit (20) noch nicht erreicht ist
            if (getMunition() < MAX_MUNITION) {
                console.log(`[Spiel] Munition eingesammelt: ${p.id}`);
                addMunition(5); // +5 Schuss

                // Vom Netzwerk benachrichtigen
                netzwerk.sende('pickup_collected', { id: p.id });

                entfernePickup(p.id);
            }
        }
    }
}

/**
 * Entfernt ein Munitionspack aus der Szene.
 * @param {string} id 
 */
export function entfernePickup(id) {
    const idx = munitionPickups.findIndex(p => p.id === id);
    if (idx !== -1) {
        const p = munitionPickups[idx];
        const scene = getScene();
        if (scene) scene.remove(p.model);
        entfernePickupModel(p.model);
        munitionPickups.splice(idx, 1);
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
 * Initialisiert die gesamte Lobby-UI und Event-Handler.
 */
function initLobby() {
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
            lobbyStatus.textContent = 'Warte auf Mitspieler...';
            lobbyStatus.className = 'lobby-status warten';

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
            // Sanfte Interpolation
            gegnerMesh.position.lerp(
                new THREE.Vector3(daten.x, daten.y, daten.z),
                0.3
            );
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
    netzwerk.onNewPickup = (id, pos) => {
        spawnNetzwerkPickup(id, pos);
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
    letzterRadarPingZeit = 0;

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

    // ── 1. Eingabe verarbeiten ──────────────────────────────
    const lookDelta = getLookDelta();
    updateKameraRotation(lookDelta);

    // ── 2. Spieler bewegen (mit Kollision) ──────────────────
    bewegeSpieler(kamera, deltaZeit, getGierWinkel(), labyrinth);

    // ── Pickups prüfen ──────────────────────────────────────
    updatePickups();

    // ── 3. Schuss prüfen ────────────────────────────────────
    if (rundeAktiv && verbrauchSchuss()) {
        const ergebnis = schiessen(kamera, scene, aktuelleZeit);
        if (ergebnis.treffer) {
            // Schaden senden, den wir in combat.js berechnet haben (Headshot-Support)
            netzwerk.sendHit(ergebnis.spielerId, ergebnis.schaden);
        }
    }

    // ── 4. Kampf-System aktualisieren ───────────────────────
    updateCombat(deltaZeit, kamera);

    // ── Munition Respawn (nur Host) ──────────────────────────
    if (netzwerk.istHost && rundeAktiv) {
        if (aktuelleZeit - letzterRespawnZeit > RESPAWN_INTERVAL) {
            letzterRespawnZeit = aktuelleZeit;
            if (munitionPickups.length < MAX_PICKUPS_ON_GROUND) {
                spawnEinzelnesPickup();
                console.log('[Spiel] Munition-Respawn getriggert');
            }
        }
    }

    // ── 5. Netzwerk: Position senden ────────────────────────
    // Wir senden die Bodenposition (Y=0), nicht die Kamerahöhe!
    const bodenPos = new THREE.Vector3(kamera.position.x, 0, kamera.position.z);
    netzwerk.sendPlayerPosition(bodenPos, kamera.rotation);

    // ── 6. Spieler-Licht aktualisieren ──────────────────────
    updateSpielerLicht();

    // ── 7. Minimap aktualisieren ────────────────────────────
    zeichneMinimap(kamera);

    // ── 8. Rendern ──────────────────────────────────────────
    renderFrame();
}

// ═══════════════════════════════════════════════════════════
// MINIMAP
// ═══════════════════════════════════════════════════════════

function initMinimap() {
    minimapCanvas = document.getElementById('minimap');
    if (!minimapCanvas || !labyrinth) return;
    minimapCanvas.width = labyrinth[0].length * MINIMAP_ZELLGROESSE;
    minimapCanvas.height = labyrinth.length * MINIMAP_ZELLGROESSE;
    minimapCtx = minimapCanvas.getContext('2d');
}

function zeichneMinimap(kamera) {
    if (!minimapCtx || !labyrinth) return;
    const ctx = minimapCtx;
    const z = MINIMAP_ZELLGROESSE;

    ctx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);

    for (let y = 0; y < labyrinth.length; y++) {
        for (let x = 0; x < labyrinth[y].length; x++) {
            ctx.fillStyle = labyrinth[y][x] === 1 ? '#555' : '#222';
            ctx.fillRect(x * z, y * z, z, z);
        }
    }

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
        if (!gegnerRadarPos || aktuelleZeit - letzterRadarPingZeit >= RADAR_INTERVALL) {
            gegnerRadarPos = {
                x: gegnerMesh.position.x,
                z: gegnerMesh.position.z
            };
            letzterRadarPingZeit = aktuelleZeit;
            console.log('[Radar] 📡 Ping! Gegnerposition aktualisiert.');
        }

        // Radar-Punkt zeichnen
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
    console.log('═══════════════════════════════════════════');
    console.log('  🎮 RETRO-SHOOTER – Spiel wird geladen...');
    console.log('═══════════════════════════════════════════');

    initLobby();
    gameLoop();
});
