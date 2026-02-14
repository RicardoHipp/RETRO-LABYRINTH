/**
 * ============================================================
 * EINGABE-STEUERUNG (input-handler.js)
 * ============================================================
 * Verwaltet alle Eingaben:
 *   - PC: WASD + Maus (PointerLock)
 *   - Mobile: Virtueller Joystick + Floating Fire Zone
 * 
 * Exportiert Zustandsobjekte, die vom Game-Loop abgefragt werden.
 * ============================================================
 */

import { istWand, WAND_GROESSE } from './maze-generator.js';

// ── Eingabe-Zustand ─────────────────────────────────────────
const tasten = {
    vorwaerts: false,   // W
    zurueck: false,     // S
    links: false,       // A
    rechts: false       // D
};

// Mausbewegung (wird pro Frame gelesen und zurückgesetzt)
let mausDeltaX = 0;
let mausDeltaY = 0;

// Touch-Joystick-Zustand (Bewegung)
let joystickAktiv = false;
let joystickStartX = 0;
let joystickStartY = 0;
let joystickDeltaX = 0;
let joystickDeltaY = 0;

// Touch-Look (rechte Seite - Floating Fire)
let touchLookAktiv = false;
let touchLookStartX = 0;
let touchLookStartY = 0;
let touchLookId = -1;
let touchLookTimer = null; // Timer für Feuer-Erkennung (Tap & Hold)
let touchFireAktiv = false;
let touchLookOriginX = 0; // Für Bewegungs-Sperre (Threshold)
let touchLookOriginY = 0;
let touchLookLastTime = 0; // Für Flick-Acceleration (Geschwindigkeitsmessung)
let touchDriftX = 0; // Kontinuierliche Drehung am Rand
let touchDriftY = 0;

// Schuss-Status
let schussAngefordert = false;

// Spieler-Kollisionsradius
const SPIELER_RADIUS = 0.4;

// Bewegungsgeschwindigkeit
const BEWEGUNGS_SPEED = 5.0; // Einheiten pro Sekunde

/**
 * Initialisiert alle Eingabe-Event-Listener.
 * @param {HTMLElement} canvas - Das Render-Canvas für PointerLock
 */
export function initInput(canvas) {
    // ── Tastatur-Events ─────────────────────────────────────
    document.addEventListener('keydown', (e) => {
        switch (e.code) {
            case 'KeyW': case 'ArrowUp': tasten.vorwaerts = true; break;
            case 'KeyS': case 'ArrowDown': tasten.zurueck = true; break;
            case 'KeyA': case 'ArrowLeft': tasten.links = true; break;
            case 'KeyD': case 'ArrowRight': tasten.rechts = true; break;
        }
    });

    document.addEventListener('keyup', (e) => {
        switch (e.code) {
            case 'KeyW': case 'ArrowUp': tasten.vorwaerts = false; break;
            case 'KeyS': case 'ArrowDown': tasten.zurueck = false; break;
            case 'KeyA': case 'ArrowLeft': tasten.links = false; break;
            case 'KeyD': case 'ArrowRight': tasten.rechts = false; break;
        }
    });

    // ── Maus-Events (PointerLock) ───────────────────────────
    canvas.addEventListener('click', () => {
        if (!document.pointerLockElement) {
            canvas.requestPointerLock();
        } else {
            // Wenn PointerLock aktiv → Schuss auslösen
            schussAngefordert = true;
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (document.pointerLockElement === canvas) {
            mausDeltaX += e.movementX;
            mausDeltaY += e.movementY;
        }
    });

    // ── Touch-Events (Mobile) ───────────────────────────────
    initTouchSteuerung();

    console.log('[Input] Eingabe-Handler initialisiert');
}

/**
 * Richtet die Touch-Steuerung für Mobile ein.
 * - Linke Bildschirmhälfte: Joystick (Bewegung)
 * - Rechte Bildschirmhälfte: Floating Fire Zone (Zielen & Feuer)
 */
function initTouchSteuerung() {
    const joystickZone = document.getElementById('joystick-zone');
    const joystickKnob = document.getElementById('joystick-knob');
    const lookZone = document.getElementById('look-zone');

    if (!joystickZone || !lookZone) return;

    // ── Linker Joystick (Bewegung) ──────────────────────────
    joystickZone.addEventListener('touchstart', (e) => {
        e.preventDefault();
        joystickAktiv = true;
        const rect = joystickZone.getBoundingClientRect();
        joystickStartX = rect.left + rect.width / 2;
        joystickStartY = rect.top + rect.height / 2;
    }, { passive: false });

    joystickZone.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (!joystickAktiv) return;
        const touch = e.changedTouches[0];
        const maxRadius = 40;

        let dx = touch.clientX - joystickStartX;
        let dy = touch.clientY - joystickStartY;

        const dist = Math.sqrt(dx * dx + dy * dy);

        // Sanity-Check: Wenn der Finger schlagartig zu weit weg ist (z.B. 150px)
        // dann ist es wahrscheinlich ein "Übersprechen" vom anderen Finger.
        if (dist > 150) {
            joystickAktiv = false;
            joystickDeltaX = 0;
            joystickDeltaY = 0;
            if (joystickKnob) joystickKnob.style.transform = 'translate(0, 0)';
            return;
        }

        if (dist > maxRadius) {
            dx = (dx / dist) * maxRadius;
            dy = (dy / dist) * maxRadius;
        }

        joystickDeltaX = dx / maxRadius;
        joystickDeltaY = dy / maxRadius;

        if (joystickKnob) joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    }, { passive: false });

    const joystickEnde = () => {
        joystickAktiv = false;
        joystickDeltaX = 0;
        joystickDeltaY = 0;
        if (joystickKnob) joystickKnob.style.transform = 'translate(0, 0)';
    };
    joystickZone.addEventListener('touchend', joystickEnde);
    joystickZone.addEventListener('touchcancel', joystickEnde);

    // ── Rechte Seite (Look & Floating Fire) ─────────────────
    lookZone.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const touch = e.changedTouches[0];
        touchLookAktiv = true;
        touchLookId = touch.identifier;
        touchLookStartX = touch.clientX;
        touchLookStartY = touch.clientY;
        touchLookOriginX = touch.clientX;
        touchLookOriginY = touch.clientY;
        touchLookLastTime = performance.now();

        // Timer starten: Wenn nach 150ms noch gedrückt UND kaum bewegt → Feuer frei!
        if (touchLookTimer) clearTimeout(touchLookTimer);
        touchLookTimer = setTimeout(() => {
            if (touchLookAktiv) {
                touchFireAktiv = true;
                lookZone.classList.add('fire');
            }
        }, 150);
    }, { passive: false });

    lookZone.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (!touchLookAktiv) return;

        for (const touch of e.changedTouches) {
            if (touch.identifier === touchLookId) {
                const jetzt = performance.now();
                const dt = Math.max(1, jetzt - touchLookLastTime);
                touchLookLastTime = jetzt;

                // Kamera-Bewegung berechnen (Delta)
                const rawDx = (touch.clientX - touchLookStartX);
                const rawDy = (touch.clientY - touchLookStartY);

                // Geschwindigkeit in Pixel/ms berechnen
                const speed = Math.sqrt(rawDx * rawDx + rawDy * rawDy) / dt;

                // Dynamische Sensitivität (Flick-Acceleration):
                // Langsam (< 0.5px/ms) = 4.0x Basis-Sensitivität
                // Schnell (> 0.5px/ms) = Skalierung bis zu ca. 14x
                let accel = 4.0;
                if (speed > 0.5) {
                    accel = 4.0 + Math.min(speed * 15, 10.0);
                }

                const dx = rawDx * accel;
                const dy = rawDy * accel;

                // Bewegungs-Sperre: Wenn wir uns während der Wartezeit zu viel bewegen, 
                // brechen wir den Feuer-Timer ab (User will nur zielen).
                if (!touchFireAktiv && touchLookTimer) {
                    const dist = Math.sqrt(
                        Math.pow(touch.clientX - touchLookOriginX, 2) +
                        Math.pow(touch.clientY - touchLookOriginY, 2)
                    );
                    if (dist > 10) { // Threshold: 10 Pixel
                        clearTimeout(touchLookTimer);
                        touchLookTimer = null;
                    }
                }

                // --- Relativer Look-Stick (Virtuelle Grenze) ---
                // Wir nehmen den Aufsetzpunkt als Zentrum.
                const distVomUrsprungX = touch.clientX - touchLookOriginX;
                const distVomUrsprungY = touch.clientY - touchLookOriginY;
                const gesamtDist = Math.sqrt(distVomUrsprungX * distVomUrsprungX + distVomUrsprungY * distVomUrsprungY);

                const VIRTUELLER_RADIUS = 70; // 70 Pixel Radius für präzises Zielen

                touchDriftX = 0;
                touchDriftY = 0;

                if (gesamtDist > VIRTUELLER_RADIUS) {
                    // Wir sind außerhalb der präzisen Zone -> Drift einleiten
                    // Wir berechnen, wie weit wir "über" dem Radius sind (Intensität)
                    const ueberfluss = gesamtDist - VIRTUELLER_RADIUS;
                    // Skalierung: 1:1 nach dem Radius, aber gedeckelt für Spielbarkeit
                    const intensitæt = Math.min(ueberfluss / 50, 2.0);

                    // Richtung beibehalten und mit Intensität multiplizieren
                    // (Normalisierter Vektor * Intensität * Basis-Drift-Speed)
                    touchDriftX = (distVomUrsprungX / gesamtDist) * intensitæt * 15;
                    touchDriftY = (distVomUrsprungY / gesamtDist) * intensitæt * 15;
                }

                mausDeltaX += dx;
                mausDeltaY += dy;

                touchLookStartX = touch.clientX;
                touchLookStartY = touch.clientY;

                // Visuelles Feedback (Radial-Gradient folgt dem Finger relativ zur Zone)
                const rect = lookZone.getBoundingClientRect();
                lookZone.style.setProperty('--touch-x', `${((touch.clientX - rect.left) / rect.width) * 100}%`);
                lookZone.style.setProperty('--touch-y', `${((touch.clientY - rect.top) / rect.height) * 100}%`);
            }
        }
    }, { passive: false });

    const lookEnde = (e) => {
        for (const touch of e.changedTouches) {
            if (touch.identifier === touchLookId) {
                touchLookAktiv = false;
                touchLookId = -1;
                touchFireAktiv = false;
                touchDriftX = 0;
                touchDriftY = 0;
                if (touchLookTimer) {
                    clearTimeout(touchLookTimer);
                    touchLookTimer = null;
                }
                lookZone.classList.remove('fire');
            }
        }
    };
    lookZone.addEventListener('touchend', lookEnde);
    lookZone.addEventListener('touchcancel', lookEnde);
}

/**
 * Liest die akkumulierte Mausbewegung und setzt sie zurück.
 * @returns {{x: number, y: number}} Delta in Pixeln
 */
export function getLookDelta() {
    let deltaX = mausDeltaX + touchDriftX;
    let deltaY = mausDeltaY + touchDriftY;

    // Reset Maus/Touch-Delta
    mausDeltaX = 0;
    mausDeltaY = 0;

    // Wenn Feuer aktiv ist (Tap & Hold), automatisch Schuss anfordern
    if (touchFireAktiv) {
        schussAngefordert = true;
    }

    return { x: deltaX, y: deltaY };
}

/**
 * Berechnet den Bewegungsvektor basierend auf Tasten/Joystick.
 * Der Vektor ist relativ zur Blickrichtung.
 * 
 * @returns {{vorwaerts: number, seitwaerts: number}} 
 *          Normalisierte Bewegung (-1 bis 1)
 */
export function getMovementVector() {
    let vorwaerts = 0;
    let seitwaerts = 0;

    // Tastatur
    if (tasten.vorwaerts) vorwaerts += 1;
    if (tasten.zurueck) vorwaerts -= 1;
    if (tasten.links) seitwaerts -= 1;
    if (tasten.rechts) seitwaerts += 1;

    // Joystick (überschreibt Tastatur wenn aktiv)
    if (joystickAktiv) {
        seitwaerts = joystickDeltaX;
        vorwaerts = -joystickDeltaY; // Y invertiert (oben = vorwärts)
    }

    return { vorwaerts, seitwaerts };
}

/**
 * Prüft ob ein Schuss angefordert wurde und setzt den Status zurück.
 * @returns {boolean}
 */
export function verbrauchSchuss() {
    const schuss = schussAngefordert;
    schussAngefordert = false;
    return schuss;
}

/**
 * Prüft ob eine Position mit dem Spieler-Radius kollidiert.
 * Testet alle 4 Ecken des Spieler-Bounding-Quadrats.
 * 
 * @param {number[][]} labyrinth - Das Labyrinth-Array
 * @param {number} x - X-Position des Spielers
 * @param {number} z - Z-Position des Spielers
 * @returns {boolean} true wenn Kollision vorliegt
 */
function pruefeKollision(labyrinth, x, z) {
    // Alle 4 Ecken des Spieler-Radius prüfen
    return istWand(labyrinth, x + SPIELER_RADIUS, z + SPIELER_RADIUS) ||
        istWand(labyrinth, x + SPIELER_RADIUS, z - SPIELER_RADIUS) ||
        istWand(labyrinth, x - SPIELER_RADIUS, z + SPIELER_RADIUS) ||
        istWand(labyrinth, x - SPIELER_RADIUS, z - SPIELER_RADIUS);
}

/**
 * Bewegt den Spieler mit Kollisionserkennung gegen Wände.
 * Verwendet "Slide Along Walls" – der Spieler gleitet an Wänden entlang.
 * Prüft alle 4 Ecken des Spieler-Radius für robuste Kollision.
 * 
 * @param {THREE.Camera} kamera - Die Spieler-Kamera
 * @param {number} deltaZeit - Vergangene Zeit seit letztem Frame (Sekunden)
 * @param {number} gierWinkel - Horizontaler Blickwinkel (Yaw) in Radians
 * @param {number[][]} labyrinth - Das Labyrinth-Array
 */
export function bewegeSpieler(kamera, deltaZeit, gierWinkel, labyrinth) {
    const bewegung = getMovementVector();

    if (bewegung.vorwaerts === 0 && bewegung.seitwaerts === 0) return;

    const geschwindigkeit = BEWEGUNGS_SPEED * deltaZeit;

    // Bewegungsrichtung relativ zur Blickrichtung berechnen
    const dx = (-Math.sin(gierWinkel) * bewegung.vorwaerts +
        Math.cos(gierWinkel) * bewegung.seitwaerts) * geschwindigkeit;
    const dz = (-Math.cos(gierWinkel) * bewegung.vorwaerts -
        Math.sin(gierWinkel) * bewegung.seitwaerts) * geschwindigkeit;

    // Kollisionserkennung: X und Z getrennt prüfen (ermöglicht Gleiten an Wänden)
    const aktX = kamera.position.x;
    const aktZ = kamera.position.z;

    // X-Achse prüfen (mit allen 4 Ecken)
    if (!pruefeKollision(labyrinth, aktX + dx, aktZ)) {
        kamera.position.x = aktX + dx;
    }

    // Z-Achse prüfen (mit aktualisiertem X, falls bewegt)
    if (!pruefeKollision(labyrinth, kamera.position.x, aktZ + dz)) {
        kamera.position.z = aktZ + dz;
    }
}

export { BEWEGUNGS_SPEED };
