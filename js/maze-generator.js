/**
 * ============================================================
 * LABYRINTH-GENERATOR (maze-generator.js)
 * ============================================================
 * Erzeugt ein prozedurales Labyrinth mittels Recursive Backtracking
 * und baut die 3D-Geometrie für Three.js auf.
 * 
 * Das Labyrinth wird als 2D-Array dargestellt:
 *   1 = Wand
 *   0 = begehbarer Gang
 * ============================================================
 */

// ── Konstanten ──────────────────────────────────────────────
const WAND_HOEHE = 2.0;       // Höhe der Wände in Einheiten
const WAND_GROESSE = 2.0;     // Breite/Tiefe einer Zelle
const WAND_FARBE = 0x8B7355;  // Braun-grau (Retro-Stein)
const BODEN_FARBE = 0x4a4a4a; // Dunkelgrau
const DECKEN_FARBE = 0x3a3a3a;// Etwas dunkler

// ── Seed-basierter Zufallsgenerator (Mulberry32) ────────────
// Ermöglicht deterministische Labyrinth-Erzeugung:
// gleicher Seed = gleiches Labyrinth bei allen Spielern.
let _seedState = 0;

/**
 * Mulberry32 PRNG – erzeugt reproduzierbare Zufallszahlen.
 * @returns {number} Pseudozufallszahl zwischen 0 und 1
 */
function seededRandom() {
    _seedState |= 0;
    _seedState = (_seedState + 0x6D2B79F5) | 0;
    let t = Math.imul(_seedState ^ (_seedState >>> 15), 1 | _seedState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Setzt den Seed für den Zufallsgenerator.
 * @param {number} seed - Der Seed-Wert
 */
function setSeed(seed) {
    _seedState = seed;
}

/**
 * Generiert einen zufälligen Seed.
 * @returns {number}
 */
export function generiereZufallsSeed() {
    return Math.floor(Math.random() * 2147483647);
}

/**
 * Erzeugt eine prozedurale Steinmauer-Textur auf einem Canvas.
 * @returns {THREE.CanvasTexture} Die generierte Textur
 */
function erstelleWandTextur() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    // Grundfarbe – dunkler Stein
    ctx.fillStyle = '#6B5B45';
    ctx.fillRect(0, 0, 64, 64);

    // Ziegelstein-Muster zeichnen
    ctx.strokeStyle = '#4A3B2A';
    ctx.lineWidth = 2;

    // Horizontale Fugen
    for (let y = 0; y < 64; y += 16) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(64, y);
        ctx.stroke();
    }

    // Vertikale Fugen (versetzt wie echte Ziegel)
    for (let y = 0; y < 64; y += 16) {
        const versatz = (Math.floor(y / 16) % 2) * 16;
        for (let x = versatz; x < 64; x += 32) {
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x, y + 16);
            ctx.stroke();
        }
    }

    // Zufälliges Rauschen für Retro-Effekt
    for (let i = 0; i < 300; i++) {
        const x = Math.random() * 64;
        const y = Math.random() * 64;
        const helligkeit = Math.floor(Math.random() * 40) + 60;
        ctx.fillStyle = `rgba(${helligkeit}, ${helligkeit - 10}, ${helligkeit - 20}, 0.3)`;
        ctx.fillRect(x, y, 1, 1);
    }

    const textur = new THREE.CanvasTexture(canvas);
    textur.wrapS = THREE.RepeatWrapping;
    textur.wrapT = THREE.RepeatWrapping;
    textur.magFilter = THREE.NearestFilter; // Pixeliger Retro-Look
    textur.minFilter = THREE.NearestFilter;
    return textur;
}

/**
 * Erzeugt eine prozedurale Boden-Textur.
 * @returns {THREE.CanvasTexture}
 */
function erstelleBodenTextur() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    // Grundfarbe – dunkler Steinboden
    ctx.fillStyle = '#3D3D3D';
    ctx.fillRect(0, 0, 64, 64);

    // Fliesen-Muster
    ctx.strokeStyle = '#2A2A2A';
    ctx.lineWidth = 1;
    for (let x = 0; x < 64; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 64);
        ctx.stroke();
    }
    for (let y = 0; y < 64; y += 32) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(64, y);
        ctx.stroke();
    }

    // Rauschen
    for (let i = 0; i < 200; i++) {
        const x = Math.random() * 64;
        const y = Math.random() * 64;
        const h = Math.floor(Math.random() * 30) + 40;
        ctx.fillStyle = `rgba(${h}, ${h}, ${h}, 0.3)`;
        ctx.fillRect(x, y, 1, 1);
    }

    const textur = new THREE.CanvasTexture(canvas);
    textur.wrapS = THREE.RepeatWrapping;
    textur.wrapT = THREE.RepeatWrapping;
    textur.magFilter = THREE.NearestFilter;
    textur.minFilter = THREE.NearestFilter;
    return textur;
}

/**
 * Generiert ein Labyrinth mit Recursive Backtracking.
 * Das resultierende Array hat die Dimensionen (2*breite+1) x (2*hoehe+1),
 * da zwischen jeder Zelle Wände liegen.
 * 
 * @param {number} breite - Anzahl der Zellen in X-Richtung
 * @param {number} hoehe - Anzahl der Zellen in Y-Richtung
 * @param {number} seed - Seed für reproduzierbares Labyrinth
 * @returns {number[][]} 2D-Array: 1 = Wand, 0 = Gang
 */
export function generateMaze(breite = 20, hoehe = 20, seed = 12345) {
    // Seed setzen für deterministische Erzeugung
    setSeed(seed);
    console.log(`[Labyrinth] Verwende Seed: ${seed}`);

    // Gesamtgröße des Arrays (mit Wänden zwischen Zellen)
    const rasterBreite = 2 * breite + 1;
    const rasterHoehe = 2 * hoehe + 1;

    // Alles mit Wänden füllen
    const labyrinth = [];
    for (let y = 0; y < rasterHoehe; y++) {
        labyrinth[y] = [];
        for (let x = 0; x < rasterBreite; x++) {
            labyrinth[y][x] = 1;
        }
    }

    // Besuchte Zellen tracken
    const besucht = [];
    for (let y = 0; y < hoehe; y++) {
        besucht[y] = [];
        for (let x = 0; x < breite; x++) {
            besucht[y][x] = false;
        }
    }

    // Richtungen: oben, rechts, unten, links
    const richtungen = [
        { dx: 0, dy: -1 }, // oben
        { dx: 1, dy: 0 },  // rechts
        { dx: 0, dy: 1 },  // unten
        { dx: -1, dy: 0 }  // links
    ];

    /**
     * Hilfsfunktion: Mischt ein Array mit dem seeded PRNG (Fisher-Yates).
     */
    function mischen(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(seededRandom() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    /**
     * Recursive Backtracking: Besucht Zellen und entfernt Wände.
     */
    function graben(zx, zy) {
        besucht[zy][zx] = true;
        // Zelle im Raster freiräumen
        labyrinth[2 * zy + 1][2 * zx + 1] = 0;

        // Nachbarn in zufälliger Reihenfolge besuchen
        const gemischt = mischen([...richtungen]);
        for (const richtung of gemischt) {
            const nx = zx + richtung.dx;
            const ny = zy + richtung.dy;

            // Prüfe ob Nachbar innerhalb der Grenzen und unbesucht
            if (nx >= 0 && nx < breite && ny >= 0 && ny < hoehe && !besucht[ny][nx]) {
                // Wand zwischen aktueller Zelle und Nachbar entfernen
                labyrinth[2 * zy + 1 + richtung.dy][2 * zx + 1 + richtung.dx] = 0;
                graben(nx, ny);
            }
        }
    }

    // Starte in der oberen linken Ecke
    graben(0, 0);

    // ── Extra-Durchbrüche für offeneres Labyrinth ──────────
    // Entfernt zufällig ~20% der inneren Wände für Abkürzungen
    const durchbruchRate = 0.2;
    for (let y = 1; y < rasterHoehe - 1; y++) {
        for (let x = 1; x < rasterBreite - 1; x++) {
            if (labyrinth[y][x] === 1 && seededRandom() < durchbruchRate) {
                // Nur entfernen wenn mindestens 2 angrenzende Gänge existieren
                let nachbarGaenge = 0;
                if (y > 0 && labyrinth[y - 1][x] === 0) nachbarGaenge++;
                if (y < rasterHoehe - 1 && labyrinth[y + 1][x] === 0) nachbarGaenge++;
                if (x > 0 && labyrinth[y][x - 1] === 0) nachbarGaenge++;
                if (x < rasterBreite - 1 && labyrinth[y][x + 1] === 0) nachbarGaenge++;
                if (nachbarGaenge >= 2) {
                    labyrinth[y][x] = 0;
                }
            }
        }
    }

    console.log(`[Labyrinth] Generiert: ${rasterBreite}x${rasterHoehe} Raster (${breite}x${hoehe} Zellen) + Durchbrüche`);
    return labyrinth;
}

/**
 * Findet eine zufällige freie Position (Gang) im Labyrinth.
 * @param {number[][]} labyrinth - Das Labyrinth-Array
 * @returns {{x: number, z: number}} Weltkoordinaten der freien Position
 */
export function findeFreiePosition(labyrinth, index = -1) {
    const freiePositionen = [];
    for (let y = 0; y < labyrinth.length; y++) {
        for (let x = 0; x < labyrinth[y].length; x++) {
            if (labyrinth[y][x] === 0) {
                freiePositionen.push({
                    x: x * WAND_GROESSE,
                    z: y * WAND_GROESSE
                });
            }
        }
    }
    // Index-basiert oder zufällig auswählen
    if (index >= 0) {
        return freiePositionen[index % freiePositionen.length];
    }
    return freiePositionen[Math.floor(Math.random() * freiePositionen.length)];
}

/**
 * Prüft ob eine Weltposition eine Wand im Labyrinth ist.
 * Wird für Kollisionserkennung verwendet.
 * 
 * @param {number[][]} labyrinth - Das Labyrinth-Array
 * @param {number} weltX - X-Position in der Welt
 * @param {number} weltZ - Z-Position in der Welt
 * @returns {boolean} true wenn Position eine Wand ist
 */
export function istWand(labyrinth, weltX, weltZ) {
    const rasterX = Math.floor(weltX / WAND_GROESSE + 0.5);
    const rasterZ = Math.floor(weltZ / WAND_GROESSE + 0.5);

    // Außerhalb des Labyrinths = Wand
    if (rasterZ < 0 || rasterZ >= labyrinth.length ||
        rasterX < 0 || rasterX >= labyrinth[0].length) {
        return true;
    }

    return labyrinth[rasterZ][rasterX] === 1;
}

/**
 * Baut die 3D-Geometrie des Labyrinths in die Scene.
 * Verwendet InstancedMesh für Performance bei vielen Wänden.
 * 
 * @param {THREE.Scene} scene - Die Three.js Scene
 * @param {number[][]} labyrinth - Das Labyrinth-Array
 */
export function buildMazeGeometry(scene, labyrinth) {
    const wandTextur = erstelleWandTextur();
    const bodenTextur = erstelleBodenTextur();

    // ── Wände zählen für InstancedMesh ──
    let wandAnzahl = 0;
    for (let y = 0; y < labyrinth.length; y++) {
        for (let x = 0; x < labyrinth[y].length; x++) {
            if (labyrinth[y][x] === 1) wandAnzahl++;
        }
    }

    // ── Wand-Geometrie als InstancedMesh (Performance!) ──
    const wandGeometrie = new THREE.BoxGeometry(WAND_GROESSE, WAND_HOEHE, WAND_GROESSE);
    const wandMaterial = new THREE.MeshPhongMaterial({ map: wandTextur });
    const wandInstanzen = new THREE.InstancedMesh(wandGeometrie, wandMaterial, wandAnzahl);
    wandInstanzen.castShadow = true;
    wandInstanzen.receiveShadow = true;

    const matrix = new THREE.Matrix4();
    let index = 0;

    for (let y = 0; y < labyrinth.length; y++) {
        for (let x = 0; x < labyrinth[y].length; x++) {
            if (labyrinth[y][x] === 1) {
                matrix.setPosition(
                    x * WAND_GROESSE,
                    WAND_HOEHE / 2,
                    y * WAND_GROESSE
                );
                wandInstanzen.setMatrixAt(index, matrix);
                index++;
            }
        }
    }
    wandInstanzen.instanceMatrix.needsUpdate = true;
    scene.add(wandInstanzen);

    // ── Boden ──
    const bodenBreite = labyrinth[0].length * WAND_GROESSE;
    const bodenTiefe = labyrinth.length * WAND_GROESSE;
    const bodenGeometrie = new THREE.PlaneGeometry(bodenBreite, bodenTiefe);
    bodenTextur.repeat.set(labyrinth[0].length / 2, labyrinth.length / 2);
    const bodenMaterial = new THREE.MeshPhongMaterial({ map: bodenTextur });
    const boden = new THREE.Mesh(bodenGeometrie, bodenMaterial);
    boden.rotation.x = -Math.PI / 2;
    boden.position.set(bodenBreite / 2 - WAND_GROESSE / 2, 0, bodenTiefe / 2 - WAND_GROESSE / 2);
    boden.receiveShadow = true;
    scene.add(boden);

    // ── Decke ──
    const deckenMaterial = new THREE.MeshPhongMaterial({ color: DECKEN_FARBE });
    const decke = new THREE.Mesh(bodenGeometrie.clone(), deckenMaterial);
    decke.rotation.x = Math.PI / 2;
    decke.position.set(bodenBreite / 2 - WAND_GROESSE / 2, WAND_HOEHE, bodenTiefe / 2 - WAND_GROESSE / 2);
    scene.add(decke);

    console.log(`[Labyrinth] ${wandAnzahl} Wände als InstancedMesh erstellt`);
}

// Exportiere Konstanten für andere Module
export { WAND_GROESSE, WAND_HOEHE };
