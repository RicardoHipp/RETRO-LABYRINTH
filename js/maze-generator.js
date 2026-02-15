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
const WAND_HOEHE = 3.0;       // Höhe der Wände in Einheiten
const WAND_GROESSE = 2.0;     // Breite/Tiefe einer Zelle
const WAND_FARBE = 0x8B7355;  // Braun-grau (Retro-Stein)
const BODEN_FARBE = 0x4a4a4a; // Dunkelgrau
const DECKEN_FARBE = 0x3a3a3a;// Etwas dunkler

// ── Seed-basierter Zufallsgenerator (Mulberry32) ────────────
// Ermöglicht deterministische Labyrinth-Erzeugung:
// gleicher Seed = gleiches Labyrinth bei allen Spielern.
let _seedState = 0;
export let wallGroup = null; // Enthält alle Wände für optimiertes Raycasting

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
 * Erzeugt einen Pool von verschiedenen Wand-Materialien für mehr Varianz.
 * @param {number} anzahl - Wie viele Varianten erstellt werden sollen
 * @returns {THREE.MeshPhongMaterial[]}
 */
function generiereWandMaterialPool(anzahl = 4) {
    const pool = [];
    const res = 256;
    for (let p = 0; p < anzahl; p++) {
        const canvas = document.createElement('canvas');
        canvas.width = res;
        canvas.height = res;
        const ctx = canvas.getContext('2d');

        // Grundfarbe – einheitlicher, dunkler Backstein (Fix für harten Übergängen)
        ctx.fillStyle = '#4a1a1a';
        ctx.fillRect(0, 0, res, res);

        // Ziegelstein-Muster (Backstein-Optik - verkleinert)
        ctx.strokeStyle = '#1a0d0d';
        ctx.lineWidth = 1.5;

        const reihen = 16;
        const steineProReihe = 8;
        const zH = res / reihen;
        const sB = res / steineProReihe; // Tatsächliche Breite eines Steins

        // Horizontale Fugen
        for (let y = 0; y <= res; y += zH) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(res, y);
            ctx.stroke();
        }

        // Vertikale Fugen mit korrektem Versatz
        for (let r = 0; r < reihen; r++) {
            const y = r * zH;
            const versatz = (r % 2) * (sB / 2);
            for (let s = 0; s < steineProReihe; s++) {
                const x = s * sB + versatz;

                // Leichte Farbvariation für einzelne Steine
                if (seededRandom() < 0.25) {
                    ctx.fillStyle = 'rgba(0,0,0,0.12)';
                    ctx.fillRect(x % res, y, sB, zH);
                }
                if (seededRandom() < 0.08) {
                    ctx.fillStyle = 'rgba(255,255,255,0.04)';
                    ctx.fillRect(x % res, y, sB, zH);
                }

                ctx.beginPath();
                ctx.moveTo(x % res, y);
                ctx.lineTo(x % res, y + zH);
                ctx.stroke();
            }
        }

        // ── Dreck und Verfall ──
        for (let i = 0; i < 2000; i++) {
            const x = Math.random() * res;
            const y = Math.random() * res;
            const rand = Math.random();
            if (rand < 0.8) {
                const h = Math.floor(Math.random() * 30);
                ctx.fillStyle = `rgba(${h}, ${h - 5}, ${h - 10}, 0.3)`;
                ctx.fillRect(x, y, 1, 1);
            } else if (rand < 0.82) {
                const bloodStrength = (p % 2 === 0) ? 0.5 : 0.1;
                ctx.fillStyle = `rgba(${Math.floor(Math.random() * 100 + 50)}, 0, 0, ${bloodStrength})`;
                ctx.fillRect(x, y, 1 + Math.random() * 3, 1 + Math.random() * 3);
            } else if (rand < 0.85) {
                ctx.fillStyle = `rgba(20, ${Math.floor(Math.random() * 40 + 20)}, 10, 0.3)`;
                ctx.fillRect(x, y, 2, 2);
            }
        }

        // Risse
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1;
        for (let i = 0; i < (p + 2); i++) {
            let lx = Math.random() * res;
            let ly = Math.random() * res;
            ctx.beginPath();
            ctx.moveTo(lx, ly);
            for (let j = 0; j < 5; j++) {
                lx += (Math.random() - 0.5) * 40;
                ly += (Math.random() - 0.5) * 40;
                ctx.lineTo(lx, ly);
            }
            ctx.stroke();
        }

        const textur = new THREE.CanvasTexture(canvas);
        textur.wrapS = THREE.RepeatWrapping;
        textur.wrapT = THREE.RepeatWrapping;
        textur.magFilter = THREE.NearestFilter;
        textur.minFilter = THREE.NearestFilter;
        pool.push(new THREE.MeshPhongMaterial({
            map: textur,
            shininess: 5 // Ganz leichtes Glänzen für Stein-Optik
        }));
    }
    return pool;
}


/**
 * Erzeugt einen Pool von verschiedenen Boden-Materialien (Große Steinplatten).
 * @param {number} anzahl - Wie viele Varianten
 * @returns {THREE.MeshPhongMaterial[]}
 */
function generiereBodenMaterialPool(anzahl = 4) {
    const pool = [];
    const res = 512; // Höhere Auflösung für Details
    for (let p = 0; p < anzahl; p++) {
        const canvas = document.createElement('canvas');
        canvas.width = res;
        canvas.height = res;
        const ctx = canvas.getContext('2d');

        // Dunkler Untergrund (Fugenfarbe)
        ctx.fillStyle = '#111111';
        ctx.fillRect(0, 0, res, res);

        // Steine zeichnen (Großes, versetztes Muster)
        const rows = 4;
        const cols = 4;
        const tileH = res / rows;
        const tileW = res / cols;

        for (let y = 0; y < rows; y++) {
            // Versatz in jeder zweiten Reihe für Mauerwerk-Optik
            const offsetX = (y % 2 === 0) ? 0 : tileW / 2;

            for (let x = -1; x <= cols; x++) {
                // Zufällige Variation der Steinfarbe
                const baseGray = 30 + Math.random() * 20; // 30-50
                ctx.fillStyle = `rgb(${baseGray}, ${baseGray}, ${baseGray})`;

                // Fugen-Abstand
                const gap = 4 + Math.random() * 3; // Unregelmäßige Fugenbreite

                const drawX = x * tileW + offsetX + gap;
                const drawY = y * tileH + gap;
                const drawW = tileW - gap * 2;
                const drawH = tileH - gap * 2;

                if (drawX + drawW > 0 && drawX < res) {
                    // Rechtecke zeichnen
                    ctx.fillRect(drawX, drawY, drawW, drawH);

                    // Highlights auf den Steinen (Struktur)
                    for (let i = 0; i < 40; i++) {
                        ctx.fillStyle = `rgba(255,255,255, ${0.05 + Math.random() * 0.05})`;
                        const sx = drawX + Math.random() * drawW;
                        const sy = drawY + Math.random() * drawH;
                        const sw = Math.random() * (drawW / 2);
                        const sh = Math.random() * (drawH / 5);
                        ctx.fillRect(sx, sy, sw, sh);
                    }
                }
            }
        }

        // Globales Rauschen für "Grit" (Sand/Dreck)
        for (let i = 0; i < 8000; i++) {
            const x = Math.random() * res;
            const y = Math.random() * res;
            const noise = Math.random();
            if (noise < 0.5) {
                // Helle Pünktchen
                ctx.fillStyle = 'rgba(100, 100, 100, 0.3)';
            } else {
                // Dunkle Pünktchen
                ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            }
            ctx.fillRect(x, y, 2, 2);
        }

        const textur = new THREE.CanvasTexture(canvas);
        textur.wrapS = THREE.RepeatWrapping;
        textur.wrapT = THREE.RepeatWrapping;
        textur.repeat.set(4, 4);
        textur.magFilter = THREE.NearestFilter;
        textur.minFilter = THREE.LinearMipmapLinearFilter; // Besseres Mipmapping für Boden

        pool.push(new THREE.MeshPhongMaterial({
            map: textur,
            shininess: 15, // Etwas feucht
            bumpMap: textur, // Textur auch als Bump-Map nutzen für Tiefe
            bumpScale: 0.05
        }));
    }
    return pool;
}

/**
 * Erzeugt einen Pool von verschiedenen Decken-Materialien.
 * @param {number} anzahl - Wie viele Varianten
 * @returns {THREE.MeshPhongMaterial[]}
 */
function generiereDeckenMaterialPool(anzahl = 4) {
    const pool = [];
    const res = 256;
    for (let p = 0; p < anzahl; p++) {
        const canvas = document.createElement('canvas');
        canvas.width = res;
        canvas.height = res;
        const ctx = canvas.getContext('2d');

        // Grundfarbe – einheitlicher, dunkler Stein (Decke)
        ctx.fillStyle = '#333333';
        ctx.fillRect(0, 0, res, res);

        // Raster/Platten (Versetztes Steinmuster statt Fliesen)
        ctx.strokeStyle = '#1a1a1a';
        ctx.lineWidth = 1;
        const reihen = 4;
        const gS = res / reihen;

        for (let y = 0; y <= res; y += gS) {
            ctx.beginPath();
            ctx.moveTo(0, y); ctx.lineTo(res, y); ctx.stroke();

            // Vertikale Linien versetzt zeichnen
            const versatz = (Math.floor(y / gS) % 2) * (gS / 2);
            for (let x = versatz; x < res + gS; x += gS) {
                ctx.beginPath();
                ctx.moveTo(x % res, y);
                ctx.lineTo(x % res, y + gS);
                ctx.stroke();
            }
        }

        // Schmutz/Feuchtigkeit
        for (let i = 0; i < 1500; i++) {
            const x = Math.random() * res;
            const y = Math.random() * res;
            const h = Math.floor(Math.random() * 10);
            ctx.fillStyle = `rgba(${h}, ${h}, ${h}, 0.4)`;
            ctx.fillRect(x, y, 1, 1);

            if (Math.random() < 0.03) {
                ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
                ctx.beginPath();
                ctx.arc(x, y, Math.random() * 8, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        const textur = new THREE.CanvasTexture(canvas);
        textur.wrapS = THREE.RepeatWrapping;
        textur.wrapT = THREE.RepeatWrapping;
        textur.repeat.set(4, 4);
        textur.magFilter = THREE.NearestFilter;
        textur.minFilter = THREE.NearestFilter;
        pool.push(new THREE.MeshPhongMaterial({
            map: textur,
            shininess: 2
        }));
    }
    return pool;
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
    const wandPool = generiereWandMaterialPool(4);
    const bodenPool = generiereBodenMaterialPool(4);

    // Wand-Materialien für Gewölbe clonen (BackSide nötig, da wir von innen schauen)
    const gewoelbePool = wandPool.map(mat => {
        const m = mat.clone();
        m.side = THREE.BackSide;
        return m;
    });

    // Alte wallGroup entfernen falls vorhanden
    if (wallGroup) {
        scene.remove(wallGroup);
    }
    wallGroup = new THREE.Group();
    wallGroup.name = "wallGroup";
    scene.add(wallGroup);

    // ── 1. Wand-Positionen nach Material gruppieren ──
    const wandGruppen = Array.from({ length: wandPool.length }, () => []);

    for (let y = 0; y < labyrinth.length; y++) {
        for (let x = 0; x < labyrinth[y].length; x++) {
            if (labyrinth[y][x] === 1) {
                const matIdx = Math.floor(seededRandom() * wandPool.length);
                const rotation = Math.floor(seededRandom() * 4) * (Math.PI / 2);
                wandGruppen[matIdx].push({
                    x: x * WAND_GROESSE,
                    y: WAND_HOEHE / 2,
                    z: y * WAND_GROESSE,
                    rotY: rotation
                });
            }
        }
    }

    // ── 2. InstancedMesh für jede Wand-Material-Gruppe erstellen ──
    const wandGeometrie = new THREE.BoxGeometry(WAND_GROESSE, WAND_HOEHE, WAND_GROESSE);
    let gesamtWandAnzahl = 0;

    wandGruppen.forEach((posListe, idx) => {
        if (posListe.length === 0) return;

        const instMesh = new THREE.InstancedMesh(wandGeometrie, wandPool[idx], posListe.length);
        const matrix = new THREE.Matrix4();
        const dummy = new THREE.Object3D();

        posListe.forEach((p, i) => {
            dummy.position.set(p.x, p.y, p.z);
            dummy.rotation.y = p.rotY;
            dummy.updateMatrix();
            instMesh.setMatrixAt(i, dummy.matrix);
        });

        instMesh.instanceMatrix.needsUpdate = true;
        wallGroup.add(instMesh);
        gesamtWandAnzahl += posListe.length;
    });

    // ── 3. BODEN (Große Steinplatten) ──
    const segmentGroesse = 4;
    const bodenGeometrie = new THREE.PlaneGeometry(WAND_GROESSE * segmentGroesse, WAND_GROESSE * segmentGroesse);
    // Boden-Loop bleibt (aber ohne Decke!)
    for (let y = 0; y < labyrinth.length; y += segmentGroesse) {
        for (let x = 0; x < labyrinth[0].length; x += segmentGroesse) {
            const bodenIdx = Math.floor(seededRandom() * bodenPool.length);
            const bodenTeil = new THREE.Mesh(bodenGeometrie, bodenPool[bodenIdx]);
            bodenTeil.rotation.x = -Math.PI / 2;
            bodenTeil.rotation.z = Math.floor(seededRandom() * 4) * (Math.PI / 2);
            bodenTeil.position.set(
                (x + segmentGroesse / 2 - 0.5) * WAND_GROESSE,
                0,
                (y + segmentGroesse / 2 - 0.5) * WAND_GROESSE
            );
            bodenTeil.updateMatrix();
            wallGroup.add(bodenTeil);
        }
    }

    // ── 4. DECKE (Modulares adaptives System - Schritt 3: Kurven-Integration) ──
    const r = WAND_GROESSE / 2; // 1.0m
    const deckenHoehe = WAND_HOEHE + r; // 4.0m
    const qG = WAND_GROESSE / 2; // Quadrant-Größe = 1.0m

    const plateGeo = new THREE.PlaneGeometry(qG, qG);
    const edgeGeo = createQuarterCylinderGeometry(r, qG);

    const platePosGruppen = Array.from({ length: gewoelbePool.length }, () => []);
    const edgePosGruppen = Array.from({ length: gewoelbePool.length }, () => []);
    const cornerPosGruppen = Array.from({ length: gewoelbePool.length }, () => []);
    const outerCornerPosGruppen = Array.from({ length: gewoelbePool.length }, () => []);

    const cornerGeo = createGroinCornerGeometry(r);
    const outerCornerGeo = createOuterCornerGeometry(r);
    for (let y = 0; y < labyrinth.length; y++) {
        for (let x = 0; x < labyrinth[y].length; x++) {
            if (labyrinth[y][x] === 0) {
                const matIdx = Math.floor(seededRandom() * gewoelbePool.length);
                const wx = x * WAND_GROESSE;
                const wz = y * WAND_GROESSE;
                const offset = qG / 2; // 0.5m

                // Nachbarn (Array-Index: y=z, x=x)
                const nN = (y === 0 || labyrinth[y - 1][x] === 1);
                const nS = (y === labyrinth.length - 1 || labyrinth[y + 1][x] === 1);
                const nW = (x === 0 || labyrinth[y][x - 1] === 1);
                const nO = (x === labyrinth[0].length - 1 || labyrinth[y][x + 1] === 1);

                // Diagonal-Check für Außenecken (Pfeiler)
                const nNW = (y > 0 && x > 0 && labyrinth[y - 1][x - 1] === 1);
                const nNO = (y > 0 && x < labyrinth[0].length - 1 && labyrinth[y - 1][x + 1] === 1);
                const nSW = (y < labyrinth.length - 1 && x > 0 && labyrinth[y + 1][x - 1] === 1);
                const nSO = (y < labyrinth.length - 1 && x < labyrinth[0].length - 1 && labyrinth[y + 1][x + 1] === 1);

                // Quadranten-Logik [NW, NO, SW, SO]
                const quadrants = [
                    { dx: -offset, dz: -offset, w1: nN, w2: nW, diag: nNW, t1: "N", t2: "W" }, // NW
                    { dx: offset, dz: -offset, w1: nN, w2: nO, diag: nNO, t1: "N", t2: "O" }, // NO
                    { dx: -offset, dz: offset, w1: nS, w2: nW, diag: nSW, t1: "S", t2: "W" }, // SW
                    { dx: offset, dz: offset, w1: nS, w2: nO, diag: nSO, t1: "S", t2: "O" }  // SO
                ];

                quadrants.forEach(q => {
                    const px = wx + q.dx;
                    const pz = wz + q.dz;

                    if (q.w1 && q.w2) {
                        // Innenecke (Zimmer-Ecke)
                        let ry = 0;
                        if (q.t1 === "N" && q.t2 === "W") ry = Math.PI;       // NW (180°)
                        if (q.t1 === "N" && q.t2 === "O") ry = 0.5 * Math.PI; // NO (90°)
                        if (q.t1 === "S" && q.t2 === "W") ry = 1.5 * Math.PI; // SW (270°)
                        if (q.t1 === "S" && q.t2 === "O") ry = 0;             // SO (0°)

                        cornerPosGruppen[matIdx].push({ x: wx, y: 3.0, z: wz, rx: 0, ry, rz: 0 });
                    }
                    else if (!q.w1 && !q.w2 && q.diag) {
                        // Außenecke (Pfeiler-Ecke) - KONVEX
                        let ry = 0;
                        if (q.t1 === "N" && q.t2 === "W") ry = Math.PI;       // NW (180°)
                        if (q.t1 === "N" && q.t2 === "O") ry = 0.5 * Math.PI; // NO (90°)
                        if (q.t1 === "S" && q.t2 === "W") ry = 1.5 * Math.PI; // SW (270°)
                        if (q.t1 === "S" && q.t2 === "O") ry = 0;             // SO (0°)

                        outerCornerPosGruppen[matIdx].push({ x: wx, y: 3.0, z: wz, rx: 0, ry, rz: 0 });
                    }
                    else if (q.w1 && !q.w2) {
                        // Nord/Süd Rundung (Achse X)
                        let rx = 0, ry = (q.t1 === "N" ? Math.PI : 0), rz = Math.PI / 2;
                        edgePosGruppen[matIdx].push({ x: px, y: 3.0, z: wz, rx, ry, rz });
                    }
                    else if (q.w2 && !q.w1) {
                        // West/Ost Rundung (Achse Z)
                        let rx = Math.PI / 2, ry = (q.t2 === "W" ? Math.PI : 0.5 * Math.PI), rz = 0;
                        edgePosGruppen[matIdx].push({ x: wx, y: 3.0, z: pz, rx, ry, rz });
                    }
                    else {
                        // Flach (Mitte oder Diagonale)
                        platePosGruppen[matIdx].push({ x: px, y: deckenHoehe, z: pz, rx: -Math.PI / 2, ry: 0, rz: 0 });
                    }
                });
            }
        }
    }

    // Instancing Platten
    platePosGruppen.forEach((liste, idx) => {
        if (liste.length === 0) return;
        const mesh = new THREE.InstancedMesh(plateGeo, gewoelbePool[idx], liste.length);
        const dummy = new THREE.Object3D();
        liste.forEach((p, i) => {
            dummy.position.set(p.x, p.y, p.z);
            dummy.rotation.set(p.rx, p.ry, p.rz);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        wallGroup.add(mesh);
    });

    // Instancing Wölbungen
    edgePosGruppen.forEach((liste, idx) => {
        if (liste.length === 0) return;
        const mesh = new THREE.InstancedMesh(edgeGeo, gewoelbePool[idx], liste.length);
        const dummy = new THREE.Object3D();
        liste.forEach((p, i) => {
            dummy.position.set(p.x, p.y, p.z);
            dummy.rotation.set(p.rx, p.ry, p.rz);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        wallGroup.add(mesh);
    });

    // Instancing Ecken (NEU Schritt 4)
    cornerPosGruppen.forEach((liste, idx) => {
        if (liste.length === 0) return;
        const mesh = new THREE.InstancedMesh(cornerGeo, gewoelbePool[idx], liste.length);
        const dummy = new THREE.Object3D();
        liste.forEach((p, i) => {
            dummy.position.set(p.x, p.y, p.z);
            dummy.rotation.set(p.rx, p.ry, p.rz);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        wallGroup.add(mesh);
    });

    // Instancing Außenecken (NEU Schritt 5)
    outerCornerPosGruppen.forEach((liste, idx) => {
        if (liste.length === 0) return;
        const mesh = new THREE.InstancedMesh(outerCornerGeo, gewoelbePool[idx], liste.length);
        const dummy = new THREE.Object3D();
        liste.forEach((p, i) => {
            dummy.position.set(p.x, p.y, p.z);
            dummy.rotation.set(p.rx, p.ry, p.rz);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        wallGroup.add(mesh);
    });

    console.log(`[Labyrinth] Quadranten-Deckensystem mit Außenecken (Schritt 5) installiert.`);
}

/**
 * Erstellt einen Viertel-Zylinder (90° Bogen) für die Deckenkanten.
 * radius: Wölbungsradius (WAND_GROESSE / 2 = 1.0m)
 * height: Länge des Segments (WAND_GROESSE / 2 = 1.0m für Quadranten)
 */
function createQuarterCylinderGeometry(radius, height) {
    const segments = 16;
    const geometry = new THREE.CylinderGeometry(radius, radius, height, segments, 1, true, 0, Math.PI / 2);
    return geometry;
}

/**
 * Erstellt eine Kreuzgewölbe-Eck-Geometrie (Groin Corner).
 * Basiert auf dem Schnitt zweier Zylinder für nahtlose Übergänge.
 */
function createGroinCornerGeometry(radius) {
    const segments = 16;
    const geometry = new THREE.BufferGeometry();
    const vertices = [];
    const uvs = [];
    const indices = [];

    for (let i = 0; i <= segments; i++) {
        const angleZ = (i / segments) * (Math.PI / 2);
        const z = radius * Math.sin(angleZ);
        for (let j = 0; j <= segments; j++) {
            const angleX = (j / segments) * (Math.PI / 2);
            const x = radius * Math.sin(angleX);

            const rxVal = Math.max(0, radius * radius - x * x);
            const rzVal = Math.max(0, radius * radius - z * z);
            const y = Math.min(Math.sqrt(rxVal), Math.sqrt(rzVal));

            vertices.push(x, y, z);
            uvs.push(j / segments, i / segments);
        }
    }

    for (let i = 0; i < segments; i++) {
        for (let j = 0; j < segments; j++) {
            const a = i * (segments + 1) + j;
            const b = i * (segments + 1) + (j + 1);
            const c = (i + 1) * (segments + 1) + j;
            const d = (i + 1) * (segments + 1) + (j + 1);
            indices.push(a, c, b);
            indices.push(b, c, d);
        }
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

/**
 * Erstellt eine konvexe Außeneck-Geometrie (Klostergewölbe-Stil) für Pfeiler.
 */
function createOuterCornerGeometry(radius) {
    const segments = 16;
    const geometry = new THREE.BufferGeometry();
    const vertices = [];
    const uvs = [];
    const indices = [];

    for (let i = 0; i <= segments; i++) {
        const angleZ = (i / segments) * (Math.PI / 2);
        const z = radius * Math.sin(angleZ);
        for (let j = 0; j <= segments; j++) {
            const angleX = (j / segments) * (Math.PI / 2);
            const x = radius * Math.sin(angleX);

            const rxVal = Math.max(0, radius * radius - x * x);
            const rzVal = Math.max(0, radius * radius - z * z);
            // Math.max erzeugt die konvexe Form (Klostergewölbe)
            const y = Math.max(Math.sqrt(rxVal), Math.sqrt(rzVal));

            vertices.push(x, y, z);
            uvs.push(j / segments, i / segments);
        }
    }

    for (let i = 0; i < segments; i++) {
        for (let j = 0; j < segments; j++) {
            const a = i * (segments + 1) + j;
            const b = i * (segments + 1) + (j + 1);
            const c = (i + 1) * (segments + 1) + j;
            const d = (i + 1) * (segments + 1) + (j + 1);
            indices.push(a, c, b);
            indices.push(b, c, d);
        }
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

/**
 * Erstellt eine Kreuzgewölbe-Geometrie (Groin Vault).
 * y = max(sqrt(r²-x²), sqrt(r²-z²))
 */
function createGroinVaultGeometry(radius, size) {
    const segments = 20;
    const geometry = new THREE.BufferGeometry();
    const vertices = [];
    const uvs = [];
    const indices = [];

    const halfSize = size / 2;

    for (let i = 0; i <= segments; i++) {
        const z = (i / segments - 0.5) * size;
        for (let j = 0; j <= segments; j++) {
            const x = (j / segments - 0.5) * size;

            // Höhe berechnen (Schnitt zweier Zylinder)
            const rxVal = Math.max(0, radius * radius - x * x);
            const rzVal = Math.max(0, radius * radius - z * z);
            const y = Math.max(Math.sqrt(rxVal), Math.sqrt(rzVal));

            vertices.push(x, y, z);

            // UVs: Mapping für Brick-Textur
            uvs.push(j / segments, i / segments);
        }
    }

    // Indices (Quads -> Triangles)
    // WICHTIG: Winding Order muss CCW für UP-facing Normals sein (damit BackSide beim Draufschauen von unten funktioniert)
    // a(00) b(01)
    // c(10) d(11)
    // Wir brauchen Normals nach OBEN (y+).
    // Vector a->c (+z), a->b (+x). Z cross X = +Y.
    // Also Index Order: a, c, b !
    // Indices (Quads -> Triangles)
    // WICHTIG: Standard CCW für korrekte Face-Normals.
    // Faces pointing UP/OUT.
    // Indices (Quads -> Triangles)
    // WICHTIG: a,c,b Order für korrekte Sichtbarkeit mit BackSide.
    // Indices (Quads -> Triangles)
    // STANDARD Order (CCW) -> Normals pointing OUT/UP.
    // BackSide material will render the inside faces correctly.
    // Indices (Quads -> Triangles)
    // WICHTIG: a,c,b Order für korrekte Sichtbarkeit mit BackSide.
    for (let i = 0; i < segments; i++) {
        for (let j = 0; j < segments; j++) {
            const a = i * (segments + 1) + j;
            const b = i * (segments + 1) + (j + 1);
            const c = (i + 1) * (segments + 1) + j;
            const d = (i + 1) * (segments + 1) + (j + 1);

            // Triangle 1: a, c, b
            indices.push(a, c, b);
            // Triangle 2: b, c, d
            indices.push(b, c, d);
        }
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

/**
 * Erstellt eine halbkreisförmige Wand (Lunette) zum Verschließen von Gewölbe-Enden.
 */
function createLunetteGeometry(radius) {
    const segments = 32;
    const geometry = new THREE.CircleGeometry(radius, segments, 0, Math.PI);

    // Custom UVs für CircleGeometry fixen (damit Bricks gerade laufen)
    const uvAttribute = geometry.attributes.uv;
    for (let i = 0; i < uvAttribute.count; i++) {
        const x = geometry.attributes.position.getX(i);
        const y = geometry.attributes.position.getY(i);
        const u = (x / radius + 1) / 2;
        const v = (y / radius) / 2;
        uvAttribute.setXY(i, u, v);
    }
    return geometry;
}

// Zustand für Fackeln
const aktiveFackeln = [];
const BASIS_INTENSITAET = 2.0;

/**
 * Platziert statische Lichtquellen (Fackeln) an den Wänden des Labyrinths.
 * @param {THREE.Scene} scene - Die Spielszene
 * @param {number[][]} labyrinth - Das Labyrinth-Array
 */
export function addWallLights(scene, labyrinth) {
    aktiveFackeln.length = 0;
    const fackelPositionen = []; // Speichert {x, y} für Distanzcheck
    const minDist = 3; // Reduziert von 5 auf 3 für doppelt so viele Fackeln

    for (let y = 1; y < labyrinth.length - 1; y++) {
        for (let x = 1; x < labyrinth[y].length - 1; x++) {
            if (labyrinth[y][x] === 0) {
                // Prüfen, ob eine Fackel in der Nähe ist
                let zuNah = false;
                for (const pos of fackelPositionen) {
                    const dx = pos.x - x;
                    const dy = pos.y - y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < minDist) {
                        zuNah = true;
                        break;
                    }
                }

                if (!zuNah) {
                    // Mögliche Wand-Nachbarn (Norden, Süden, Westen, Osten)
                    const nachbarn = [
                        { dx: 0, dz: -1 }, { dx: 0, dz: 1 },
                        { dx: -1, dz: 0 }, { dx: 1, dz: 0 }
                    ];

                    // Prüfen, ob wir an einer Wand stehen
                    for (const n of nachbarn) {
                        if (labyrinth[y + n.dz][x + n.dx] === 1) {
                            platziereFackel(scene, x, y, n);
                            fackelPositionen.push({ x, y });
                            break; // Nur eine Fackel pro Zelle
                        }
                    }
                }
            }
        }
    }
    console.log(`[Labyrinth] ${fackelPositionen.length} Fackeln erfolgreich platziert (minDist: ${minDist})`);
}

// Shared Resources für Fackeln (Vermeidet Hitches beim Laden)
const halterGeo = new THREE.BoxGeometry(0.1, 0.2, 0.1);
const halterMat = new THREE.MeshPhongMaterial({ color: 0x333333, shininess: 20 });
const kernGeo = new THREE.SphereGeometry(0.08, 8, 8);
const kernMat = new THREE.MeshBasicMaterial({ color: 0xffaa44 });

/**
 * Hilfsfunktion zum Platzieren einer einzelnen Fackel.
 */
function platziereFackel(scene, rx, ry, nachbar) {
    const x = rx * WAND_GROESSE;
    const z = ry * WAND_GROESSE;
    const h = WAND_HOEHE * 0.6; // Auf Augenhöhe

    // 1. Fackel-Halterung
    const halter = new THREE.Mesh(halterGeo, halterMat);


    // Position an die Wand schieben (0.42 statt 0.45 für mehr Wand-Abstand)
    halter.position.set(
        x + nachbar.dx * (WAND_GROESSE * 0.42),
        h,
        z + nachbar.dz * (WAND_GROESSE * 0.42)
    );
    scene.add(halter);

    // 2. Glühender Kern (emissive)
    const kern = new THREE.Mesh(kernGeo, kernMat);
    kern.position.copy(halter.position);
    kern.position.y += 0.15;
    scene.add(kern);

    // 3. Das eigentliche Licht
    const licht = new THREE.PointLight(0xffaa44, 4.5, 5.5); // Intensität hoch, Reichweite halbiert gegen Bleeding
    licht.decay = 3; // Steilerer physikalischer Abfall
    licht.position.copy(kern.position);
    // Ein Stück weiter von der Wand wegziehen, damit sie schön beleuchtet wird
    licht.position.x += nachbar.dx * -0.2;
    licht.position.z += nachbar.dz * -0.2;
    scene.add(licht);

    // Licht und Modell für Animation registrieren
    aktiveFackeln.push({ licht, kern });
}

/**
 * Animiert das Flackern der Fackeln.
 * @param {number} zeit - Aktuelle Spielzeit
 */
export function updateFackeln(zeit) {
    for (let i = 0; i < aktiveFackeln.length; i++) {
        const fackel = aktiveFackeln[i];

        // Stärkeres Flackern mit hoher Dynamik
        const flackern =
            Math.sin(zeit * 7 + i) * 0.6 +
            Math.sin(zeit * 23 + i * 2) * 0.3 +
            Math.sin(zeit * 45 + i * 3) * 0.1;

        // 1. Licht flackert
        fackel.licht.intensity = BASIS_INTENSITAET + flackern;

        // 2. Fackel-Kern flackert mit (Skalierung)
        // Die Flamme wird größer/kleiner synchron zum Licht
        const skale = 1.0 + flackern * 0.4;
        fackel.kern.scale.set(skale, skale, skale);
    }
}

// Exportiere Konstanten für andere Module
export { WAND_GROESSE, WAND_HOEHE };
