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

// ── Kampf-Einstellungen ─────────────────────────────────────
const SCHUSS_COOLDOWN = 0.2;    // Sekunden zwischen Schüssen
const SCHUSS_REICHWEITE = 50;   // Maximale Trefferdistanz
const MUZZLE_FLASH_DAUER = 0.08; // Dauer des Mündungsfeuers in Sekunden
const STRAHL_DAUER = 0.15;       // Dauer des Laserstrahls in Sekunden
const MAX_LEBEN = 100;           // Maximale Lebenspunkte
const SCHADEN_PRO_TREFFER = 25;  // Schaden pro Treffer

// ── Zustand ─────────────────────────────────────────────────
let letzterSchussZeit = 0;
let muzzleFlashAktiv = false;
let muzzleFlashTimer = 0;
let muzzleFlashLicht = null;
let leben = MAX_LEBEN;

// Laserstrahl-Zustand
let aktuellerStrahl = null;      // Aktuelles THREE.Line Objekt
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

/**
 * Erzeugt einen prozeduralen Retro-Schuss-Sound via Web Audio API.
 * Frequenz-Sweep von hoch nach tief + kurzer Rausch-Burst.
 */
function spieleSchussSound() {
    // AudioContext beim ersten Aufruf erstellen (Browser-Policy)
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    const zeit = audioCtx.currentTime;

    // ── Oszillator: Frequenz-Sweep (800Hz → 150Hz) ──────────
    const oszillator = audioCtx.createOscillator();
    oszillator.type = 'sawtooth'; // Sägezahn für aggressiven Retro-Sound
    oszillator.frequency.setValueAtTime(800, zeit);
    oszillator.frequency.exponentialRampToValueAtTime(150, zeit + 0.15);

    // Lautstärke-Hüllkurve: schnell laut, schnell leise
    const oszGain = audioCtx.createGain();
    oszGain.gain.setValueAtTime(0.3, zeit);
    oszGain.gain.exponentialRampToValueAtTime(0.01, zeit + 0.15);

    oszillator.connect(oszGain);
    oszGain.connect(audioCtx.destination);
    oszillator.start(zeit);
    oszillator.stop(zeit + 0.15);

    // ── Rausch-Burst ("Knall"-Effekt) ───────────────────────
    const bufferGroesse = audioCtx.sampleRate * 0.08; // 80ms Rauschen
    const rauschenBuffer = audioCtx.createBuffer(1, bufferGroesse, audioCtx.sampleRate);
    const daten = rauschenBuffer.getChannelData(0);
    for (let i = 0; i < bufferGroesse; i++) {
        daten[i] = (Math.random() * 2 - 1) * (1 - i / bufferGroesse); // Abklingend
    }

    const rauschQuelle = audioCtx.createBufferSource();
    rauschQuelle.buffer = rauschenBuffer;

    const rauschGain = audioCtx.createGain();
    rauschGain.gain.setValueAtTime(0.2, zeit);
    rauschGain.gain.exponentialRampToValueAtTime(0.01, zeit + 0.08);

    // Hochpass-Filter für knackigeren Sound
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 1000;

    rauschQuelle.connect(filter);
    filter.connect(rauschGain);
    rauschGain.connect(audioCtx.destination);
    rauschQuelle.start(zeit);
    rauschQuelle.stop(zeit + 0.08);
}

/**
 * Initialisiert das Kampfsystem.
 * @param {THREE.Scene} scene - Die Spielszene
 * @param {THREE.Camera} kamera - Die Spieler-Kamera
 */
export function initCombat(scene, kamera) {
    // Muzzle-Flash-Licht erstellen (anfangs unsichtbar)
    muzzleFlashLicht = new THREE.PointLight(0xffff00, 0, 8);
    muzzleFlashLicht.position.copy(kamera.position);
    scene.add(muzzleFlashLicht);

    console.log('[Kampf] Kampfsystem initialisiert');
}

/**
 * Registriert ein Mesh als treffbares Ziel.
 * @param {THREE.Mesh} mesh - Das Gegner-Mesh
 * @param {string} spielerId - ID des Gegners
 */
export function registriereZiel(mesh, spielerId) {
    mesh.userData.spielerId = spielerId;
    mesh.userData.istGegner = true;
    ziele.push(mesh);
    console.log(`[Kampf] Ziel registriert: ${spielerId}`);
}

/**
 * Entfernt ein Ziel aus der Liste.
 * @param {string} spielerId - ID des zu entfernenden Gegners
 */
export function entferneZiel(spielerId) {
    const index = ziele.findIndex(z => z.userData.spielerId === spielerId);
    if (index !== -1) {
        ziele.splice(index, 1);
        console.log(`[Kampf] Ziel entfernt: ${spielerId}`);
    }
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
export function schiessen(kamera, scene, aktuelleZeit) {
    // Cooldown prüfen
    if (aktuelleZeit - letzterSchussZeit < SCHUSS_COOLDOWN) {
        return { treffer: false, spielerId: null, punkt: null };
    }

    letzterSchussZeit = aktuelleZeit;

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
    const treffer = raycaster.intersectObjects(ziele, false);

    // Endpunkt des Strahls bestimmen (Wand oder max. Reichweite)
    wandRaycaster.setFromCamera(new THREE.Vector2(0, 0), kamera);
    const alleTreffer = wandRaycaster.intersectObjects(scene.children, true);

    // Startpunkt: leicht vor der Kamera
    const strahlStart = kamera.position.clone();
    const richtung = new THREE.Vector3();
    kamera.getWorldDirection(richtung);
    strahlStart.add(richtung.clone().multiplyScalar(0.3)); // Leicht vor der Kamera

    // Endpunkt: erster Treffer oder maximale Reichweite
    let strahlEnde;
    if (alleTreffer.length > 0) {
        strahlEnde = alleTreffer[0].point.clone();
    } else {
        strahlEnde = strahlStart.clone().add(richtung.multiplyScalar(SCHUSS_REICHWEITE));
    }

    // Laserstrahl erzeugen
    erzeugeStrahl(scene, strahlStart, strahlEnde);

    // Einschlag am Endpunkt erzeugen
    if (alleTreffer.length > 0) {
        erzeugeEinschlag(scene, alleTreffer[0].point);
    }

    if (treffer.length > 0) {
        const erstesZiel = treffer[0];
        const spielerId = erstesZiel.object.userData.spielerId;
        console.log(`[Kampf] TREFFER! Spieler: ${spielerId}, Distanz: ${erstesZiel.distance.toFixed(1)}m`);

        return {
            treffer: true,
            spielerId: spielerId,
            punkt: erstesZiel.point
        };
    }

    console.log('[Kampf] Kein Treffer');
    return { treffer: false, spielerId: null, punkt: null };
}

/**
 * Erzeugt einen leuchtenden Laserstrahl zwischen zwei Punkten.
 * @param {THREE.Scene} scene - Die Spielszene
 * @param {THREE.Vector3} start - Startpunkt (Spielerposition)
 * @param {THREE.Vector3} ende - Endpunkt (Wand/Gegner)
 */
function erzeugeStrahl(scene, start, ende) {
    // Vorherigen Strahl entfernen falls vorhanden
    entferneStrahl();

    // Geometrie: Linie von Start bis Ende
    const punkte = [start, ende];
    const geometrie = new THREE.BufferGeometry().setFromPoints(punkte);

    // Leuchtender Strahl mit Farbverlauf (gelb → rot)
    const material = new THREE.LineBasicMaterial({
        color: 0xffaa00,
        linewidth: 2,  // Hinweis: Nur bei manchen GPUs >1 möglich
        transparent: true,
        opacity: 1.0
    });

    aktuellerStrahl = new THREE.Line(geometrie, material);
    strahlTimer = STRAHL_DAUER;
    strahlScene = scene;
    scene.add(aktuellerStrahl);
}

/**
 * Entfernt den aktuellen Laserstrahl aus der Scene.
 */
function entferneStrahl() {
    if (aktuellerStrahl && strahlScene) {
        strahlScene.remove(aktuellerStrahl);
        aktuellerStrahl.geometry.dispose();
        aktuellerStrahl.material.dispose();
        aktuellerStrahl = null;
    }
}

/**
 * Erzeugt einen visuellen Einschlag-Effekt am Trefferpunkt.
 * @param {THREE.Scene} scene - Die Spielszene
 * @param {THREE.Vector3} punkt - Trefferpunkt in der Welt
 */
function erzeugeEinschlag(scene, punkt) {
    // Leuchtender Punkt am Trefferpunkt
    const geometrie = new THREE.SphereGeometry(0.08, 6, 6);
    const material = new THREE.MeshBasicMaterial({ color: 0xffcc00 });
    const einschlag = new THREE.Mesh(geometrie, material);
    einschlag.position.copy(punkt);
    scene.add(einschlag);

    // Einschlag-Licht (kurzer heller Blitz am Auftreffpunkt)
    const licht = new THREE.PointLight(0xffaa00, 2, 5);
    licht.position.copy(punkt);
    scene.add(licht);

    // Nach kurzer Zeit entfernen
    setTimeout(() => {
        scene.remove(einschlag);
        scene.remove(licht);
        geometrie.dispose();
        material.dispose();
        licht.dispose();
    }, 300);
}

/**
 * Aktualisiert den Kampfzustand (Muzzle-Flash, Laserstrahl).
 * @param {number} deltaZeit - Vergangene Zeit seit letztem Frame
 * @param {THREE.Camera} kamera - Die Spieler-Kamera
 */
export function updateCombat(deltaZeit, kamera) {
    // Muzzle-Flash abklingen lassen
    if (muzzleFlashAktiv) {
        muzzleFlashTimer -= deltaZeit;
        if (muzzleFlashTimer <= 0) {
            muzzleFlashAktiv = false;
            muzzleFlashLicht.intensity = 0;
        }
    }

    // Laserstrahl verblassen lassen
    if (aktuellerStrahl) {
        strahlTimer -= deltaZeit;
        if (strahlTimer <= 0) {
            entferneStrahl();
        } else {
            // Opacity linear verringern
            const fortschritt = strahlTimer / STRAHL_DAUER;
            aktuellerStrahl.material.opacity = fortschritt;
        }
    }
}

/**
 * Wendet Schaden auf den lokalen Spieler an.
 * @param {number} schaden - Schadenspunkte
 * @returns {number} Verbleibende Lebenspunkte
 */
export function empfangeSchaden(schaden) {
    leben = Math.max(0, leben - schaden);

    // Bildschirm rot blinken lassen (Schadens-Feedback)
    const overlay = document.getElementById('schaden-overlay');
    if (overlay) {
        overlay.style.opacity = '0.5';
        setTimeout(() => { overlay.style.opacity = '0'; }, 200);
    }

    // HUD aktualisieren
    updateLebenAnzeige();

    console.log(`[Kampf] Schaden erhalten: ${schaden}, Leben: ${leben}`);

    if (leben <= 0) {
        console.log('[Kampf] SPIELER BESIEGT!');
        // Hier könnte ein Respawn ausgelöst werden
    }

    return leben;
}

/**
 * Aktualisiert die Lebenspunkte-Anzeige im HUD.
 */
export function updateLebenAnzeige() {
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
export function resetLeben() {
    leben = MAX_LEBEN;
    updateLebenAnzeige();
}

/**
 * Gibt die aktuellen Lebenspunkte zurück.
 * @returns {number}
 */
export function getLeben() {
    return leben;
}

export { SCHADEN_PRO_TREFFER };
