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
import { initRenderer, updateKameraRotation, getGierWinkel, updateSpielerLicht, renderFrame, getKamera, getScene, getRenderer, AUGEN_HOEHE } from './renderer.js';
import { initCombat, schiessen, updateCombat, registriereZiel, entferneZiel, empfangeSchaden, updateLebenAnzeige, resetLeben, SCHADEN_PRO_TREFFER } from './combat.js';
import { NetworkManager } from './network-manager.js';

// ── Spiel-Einstellungen ─────────────────────────────────────
const LABYRINTH_BREITE = 8;   // Zellen (Gesamtraster wird 2*8+1 = 17)
const LABYRINTH_HOEHE = 8;

// ── Globaler Spielzustand ───────────────────────────────────
let labyrinth = null;
let netzwerk = null;
let gegnerMesh = null;
let uhr = null; // THREE.Clock für DeltaZeit
let spielGestartet = false;
let spielSeed = 0;
let rundeAktiv = true; // false wenn jemand besiegt wurde

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

    // Labyrinth generieren (gleicher Seed = gleiches Labyrinth)
    labyrinth = generateMaze(LABYRINTH_BREITE, LABYRINTH_HOEHE, seed);
    buildMazeGeometry(scene, labyrinth);

    // Spieler spawnen – Host an Position 0, Guest an Position weit entfernt
    const spawnIndex = istHost ? 0 : Math.floor(LABYRINTH_BREITE * LABYRINTH_HOEHE * 0.8);
    const spawnPos = findeFreiePosition(labyrinth, spawnIndex);
    kamera.position.set(spawnPos.x, AUGEN_HOEHE, spawnPos.z);
    console.log(`[Spiel] Spieler gespawnt bei: (${spawnPos.x.toFixed(1)}, ${spawnPos.z.toFixed(1)})`);

    // Minimap initialisieren
    initMinimap();

    // Lobby ausblenden, Spiel einblenden
    document.getElementById('lobby-screen').style.display = 'none';

    // Touch-Steuerung auf Mobile anzeigen
    if (istMobileGeraet()) {
        document.getElementById('touch-controls').style.display = 'block';
    }

    // PointerLock auf Desktop
    if (!istMobileGeraet()) {
        getRenderer().domElement.requestPointerLock();
    }

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
    const koerperMaterial = new THREE.MeshLambertMaterial({ color: 0xff3333 });
    gegnerMesh = new THREE.Mesh(koerperGeometrie, koerperMaterial);

    // Kopf
    const kopfGeometrie = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    const kopfMaterial = new THREE.MeshLambertMaterial({ color: 0xffcc88 });
    const kopf = new THREE.Mesh(kopfGeometrie, kopfMaterial);
    kopf.position.y = 1.0;
    gegnerMesh.add(kopf);

    // Startposition (wird durch Netzwerk sofort überschrieben)
    gegnerMesh.position.set(0, 0.8, 0);
    gegnerMesh.visible = false; // Erst sichtbar wenn Position empfangen

    // Als Ziel für Raycasting registrieren
    registriereZiel(gegnerMesh, 'gegner');
    scene.add(gegnerMesh);

    console.log('[Spiel] Gegner-Mesh erstellt');
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

            // Netzwerk-Initialisierung täuschen
            netzwerk.istHost = true;
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

    // Gegner wurde besiegt → Ich habe gewonnen!
    netzwerk.onBesiegtEmpfangen = () => {
        zeigeErgebnis('SIEG', '🏆 Du hast gewonnen!');
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
        const timer = setInterval(() => {
            countdown--;
            countdownEl.textContent = `Neue Runde in ${countdown}...`;
            if (countdown <= 0) {
                clearInterval(timer);
                starteNeueRunde();
            }
        }, 1000);
    }
}

/**
 * Startet eine neue Runde mit neuem Labyrinth.
 */
function starteNeueRunde() {
    // Overlay ausblenden
    const overlay = document.getElementById('ergebnis-overlay');
    if (overlay) overlay.style.display = 'none';

    // Altes Labyrinth aus Scene entfernen
    const scene = getScene();
    const kamera = getKamera();
    const zuEntfernen = [];
    scene.traverse((obj) => {
        if (obj.isMesh && obj !== gegnerMesh && !gegnerMesh?.children.includes(obj)) {
            zuEntfernen.push(obj);
        }
    });
    zuEntfernen.forEach(obj => {
        scene.remove(obj);
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
    });

    // Leben zurücksetzen
    resetLeben();
    rundeAktiv = true;

    // Neuen Seed generieren (Host) oder empfangen (Guest)
    if (netzwerk.istHost) {
        spielSeed = generiereZufallsSeed();
        netzwerk.sendeSeed(spielSeed);
        // Labyrinth neu aufbauen
        labyrinth = generateMaze(LABYRINTH_BREITE, LABYRINTH_HOEHE, spielSeed);
        buildMazeGeometry(scene, labyrinth);
        const spawnPos = findeFreiePosition(labyrinth, 0);
        kamera.position.set(spawnPos.x, AUGEN_HOEHE, spawnPos.z);
        initMinimap();
    }

    // Guest: Seed-Callback für neues Labyrinth
    netzwerk.onSeedEmpfangen = (seed) => {
        spielSeed = seed;
        labyrinth = generateMaze(LABYRINTH_BREITE, LABYRINTH_HOEHE, seed);
        buildMazeGeometry(scene, labyrinth);
        const spawnPos = findeFreiePosition(labyrinth, Math.floor(LABYRINTH_BREITE * LABYRINTH_HOEHE * 0.8));
        kamera.position.set(spawnPos.x, AUGEN_HOEHE, spawnPos.z);
        initMinimap();
    };

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

    // ── 3. Schuss prüfen ────────────────────────────────────
    if (rundeAktiv && verbrauchSchuss()) {
        const ergebnis = schiessen(kamera, scene, aktuelleZeit);
        if (ergebnis.treffer) {
            netzwerk.sendHit(ergebnis.spielerId, SCHADEN_PRO_TREFFER);
        }
    }

    // ── 4. Kampf-System aktualisieren ───────────────────────
    updateCombat(deltaZeit, kamera);

    // ── 5. Netzwerk: Position senden ────────────────────────
    netzwerk.sendPlayerPosition(kamera.position, kamera.rotation);

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

    // Gegner (rot)
    if (gegnerMesh && gegnerMesh.visible) {
        const gX = (gegnerMesh.position.x / WAND_GROESSE + 0.5);
        const gZ = (gegnerMesh.position.z / WAND_GROESSE + 0.5);
        ctx.fillStyle = '#ff4444';
        ctx.beginPath();
        ctx.arc(gX * z, gZ * z, 3, 0, Math.PI * 2);
        ctx.fill();
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
