/**
 * ============================================================
 * NETZWERK-MANAGER (network-manager.js)
 * ============================================================
 * PeerJS-basierte P2P-Verbindung für Multiplayer.
 * Kein Server nötig – Spieler verbinden sich direkt via WebRTC.
 * 
 * Ablauf:
 *   1. Host erstellt Raum → bekommt 4-Buchstaben-Code
 *   2. Guest gibt Code ein → verbindet sich direkt
 *   3. Datenkanal für Positionen, Treffer etc.
 * ============================================================
 */

// ── Konstanten ──────────────────────────────────────────────
const CODE_LAENGE = 4;          // Länge des Raum-Codes
const POSITIONS_INTERVALL = 66; // ms zwischen Positions-Updates (~15/s)

/**
 * NetworkManager – Verwaltet die P2P-Multiplayer-Kommunikation via PeerJS.
 */
export class NetworkManager {
    constructor() {
        /** @type {Peer|null} PeerJS Peer-Instanz */
        this.peer = null;

        /** @type {DataConnection|null} Aktive Datenverbindung zum anderen Spieler */
        this.verbindung = null;

        /** @type {boolean} Verbindungsstatus */
        this.verbunden = false;

        /** @type {boolean} Ist dieser Spieler der Host? */
        this.istHost = false;

        /** @type {string} Raum-Code */
        this.raumCode = '';

        /** @type {string} Eigene Spieler-ID */
        this.spielerId = '';

        // ── Callbacks ───────────────────────────────────────
        /** @type {function|null} Callback für Gegner-Positions-Updates */
        this.onGegnerUpdate = null;

        /** @type {function|null} Callback für eingehende Treffer */
        this.onTrefferEmpfangen = null;

        /** @type {function|null} Callback wenn Gegner verbunden */
        this.onSpielerVerbunden = null;

        /** @type {function|null} Callback wenn Gegner getrennt */
        this.onSpielerGetrennt = null;

        /** @type {function|null} Callback wenn Seed empfangen (Guest) */
        this.onSeedEmpfangen = null;

        /** @type {function|null} Callback für Statusänderungen */
        this.onStatusAenderung = null;

        /** @type {function|null} Callback wenn Gegner besiegt wurde */
        this.onBesiegtEmpfangen = null;

        /** @type {function|null} Callback wenn ein Pickup eingesammelt wurde */
        this.onPickupCollected = null;

        /** @type {function|null} Callback für neue Pickups (Gast) */
        this.onNewPickup = null;

        // Timer für regelmäßige Positions-Updates
        this._positionsTimer = null;
        this._letztePosition = null;

        console.log('[Netzwerk] PeerJS NetworkManager erstellt');
    }

    /**
     * Generiert einen zufälligen 4-Buchstaben Raum-Code.
     * @returns {string} z.B. "XKDF"
     * @private
     */
    _generiereCode() {
        const buchstaben = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // Ohne I und O (Verwechslungsgefahr)
        let code = '';
        for (let i = 0; i < CODE_LAENGE; i++) {
            code += buchstaben[Math.floor(Math.random() * buchstaben.length)];
        }
        return code;
    }

    /**
     * Setzt die Status-Anzeige im UI.
     * @param {string} text - Statustext
     * @param {boolean} online - Online-Status
     * @private
     */
    _setzeStatus(text, online = false) {
        const statusDot = document.querySelector('.status-dot');
        const statusText = document.querySelector('#verbindung-status span');
        if (statusDot) {
            statusDot.classList.toggle('online', online);
        }
        if (statusText) {
            statusText.textContent = text;
        }
        if (this.onStatusAenderung) {
            this.onStatusAenderung(text, online);
        }
    }

    /**
     * Richtet die Datenverbindung ein (Event-Handler).
     * Wird sowohl von Host als auch Guest aufgerufen.
     * 
     * @param {DataConnection} conn - PeerJS Datenverbindung
     * @private
     */
    _richteVerbindungEin(conn) {
        this.verbindung = conn;

        conn.on('open', () => {
            this.verbunden = true;
            this._setzeStatus('VERBUNDEN', true);
            console.log('[Netzwerk] ✅ P2P-Verbindung hergestellt!');

            if (this.onSpielerVerbunden) {
                this.onSpielerVerbunden(conn.peer);
            }
        });

        conn.on('data', (nachricht) => {
            this._verarbeiteNachricht(nachricht);
        });

        conn.on('close', () => {
            this.verbunden = false;
            this._setzeStatus('GETRENNT', false);
            console.log('[Netzwerk] ❌ Verbindung getrennt');

            if (this.onSpielerGetrennt) {
                this.onSpielerGetrennt();
            }
        });

        conn.on('error', (err) => {
            console.error('[Netzwerk] Verbindungsfehler:', err);
            this._setzeStatus('FEHLER', false);
        });
    }

    /**
     * Verarbeitet eingehende Nachrichten vom Peer.
     * @param {object} nachricht - {typ: string, daten: object}
     * @private
     */
    _verarbeiteNachricht(nachricht) {
        switch (nachricht.typ) {
            case 'position':
                if (this.onGegnerUpdate) {
                    this.onGegnerUpdate(nachricht.daten);
                }
                break;

            case 'treffer':
                if (this.onTrefferEmpfangen) {
                    this.onTrefferEmpfangen(nachricht.daten);
                }
                break;

            case 'seed':
                // Guest empfängt den Labyrinth-Seed vom Host
                if (this.onSeedEmpfangen) {
                    this.onSeedEmpfangen(nachricht.daten.seed);
                }
                console.log(`[Netzwerk] Seed empfangen: ${nachricht.daten.seed}`);
                break;

            case 'start':
                console.log('[Netzwerk] Spiel startet!');
                break;

            case 'besiegt':
                console.log('[Netzwerk] Gegner wurde besiegt!');
                if (this.onBesiegtEmpfangen) {
                    this.onBesiegtEmpfangen();
                }
                break;

            case 'pickup_collected':
                if (this.onPickupCollected) {
                    this.onPickupCollected(nachricht.daten.id);
                }
                break;

            case 'new_pickup':
                if (this.onNewPickup) {
                    this.onNewPickup(nachricht.daten.id, nachricht.daten.pos);
                }
                break;

            default:
                console.warn('[Netzwerk] Unbekannter Nachrichtentyp:', nachricht.typ);
        }
    }

    /**
     * ERSTELLT EINEN RAUM (Host-Modus).
     * Erzeugt einen PeerJS Peer mit einem Code als ID und wartet auf Verbindungen.
     * 
     * @returns {Promise<string>} Der generierte Raum-Code
     */
    erstelleRaum() {
        return new Promise((resolve, reject) => {
            this.istHost = true;
            this.raumCode = this._generiereCode();
            const peerId = 'retrolabyrinth_' + this.raumCode;

            this._setzeStatus('ERSTELLE RAUM...', false);

            this.peer = new Peer(peerId, {
                debug: 1 // Nur Fehler loggen
            });

            this.peer.on('open', (id) => {
                this.spielerId = id;
                this._setzeStatus('WARTE AUF SPIELER...', false);
                console.log(`[Netzwerk] Raum erstellt: ${this.raumCode} (Peer-ID: ${id})`);
                resolve(this.raumCode);
            });

            // Warte auf eingehende Verbindung
            this.peer.on('connection', (conn) => {
                console.log('[Netzwerk] Spieler verbindet sich...');
                this._richteVerbindungEin(conn);
            });

            this.peer.on('error', (err) => {
                console.error('[Netzwerk] Peer-Fehler:', err);
                if (err.type === 'unavailable-id') {
                    // Code schon vergeben, neuen generieren
                    this.peer.destroy();
                    this.raumCode = this._generiereCode();
                    console.log(`[Netzwerk] Code vergeben, neuer Code: ${this.raumCode}`);
                    this.erstelleRaum().then(resolve).catch(reject);
                } else {
                    this._setzeStatus('FEHLER: ' + err.type, false);
                    reject(err);
                }
            });
        });
    }

    /**
     * TRITT EINEM RAUM BEI (Guest-Modus).
     * Verbindet sich mit dem Host über den Raum-Code.
     * 
     * @param {string} code - Der 4-Buchstaben Raum-Code
     * @returns {Promise<void>}
     */
    treteRaumBei(code) {
        return new Promise((resolve, reject) => {
            this.istHost = false;
            this.raumCode = code.toUpperCase();
            const zielPeerId = 'retrolabyrinth_' + this.raumCode;

            this._setzeStatus('VERBINDE...', false);

            // Eigene Peer-ID erstellen (zufällig)
            this.peer = new Peer(undefined, {
                debug: 1
            });

            this.peer.on('open', (id) => {
                this.spielerId = id;
                console.log(`[Netzwerk] Eigene Peer-ID: ${id}`);
                console.log(`[Netzwerk] Verbinde mit Raum: ${this.raumCode}`);

                // Zum Host verbinden
                const conn = this.peer.connect(zielPeerId, {
                    reliable: true
                });

                this._richteVerbindungEin(conn);
                resolve();
            });

            this.peer.on('error', (err) => {
                console.error('[Netzwerk] Peer-Fehler:', err);
                if (err.type === 'peer-unavailable') {
                    this._setzeStatus('RAUM NICHT GEFUNDEN', false);
                } else {
                    this._setzeStatus('FEHLER: ' + err.type, false);
                }
                reject(err);
            });
        });
    }

    /**
     * Sendet den Labyrinth-Seed an den Guest (nur Host).
     * @param {number} seed - Der Labyrinth-Seed
     */
    sendeSeed(seed) {
        this.sende('seed', { seed: seed });
    }

    /**
     * Sendet eine Nachricht an den verbundenen Peer.
     * @param {string} typ - Nachrichtentyp
     * @param {object} daten - Nachrichtendaten
     */
    sende(typ, daten) {
        if (this.verbindung && this.verbindung.open) {
            this.verbindung.send({ typ, daten });
        }
    }

    /**
     * Sendet die eigene Spielerposition an den Peer.
     * Wird regelmäßig aufgerufen (nicht jeden Frame, um Bandbreite zu sparen).
     * 
     * @param {THREE.Vector3} position - Aktuelle Position
     * @param {{y: number, x: number}} rotation - Aktuelle Rotation (Yaw/Pitch)
     */
    sendPlayerPosition(position, rotation) {
        if (!this.verbunden) return;

        this._letztePosition = {
            x: Math.round(position.x * 100) / 100,
            y: Math.round(position.y * 100) / 100,
            z: Math.round(position.z * 100) / 100,
            rotY: Math.round(rotation.y * 1000) / 1000,
            rotX: Math.round(rotation.x * 1000) / 1000
        };
    }

    /**
     * Startet den Timer für regelmäßige Positions-Updates.
     */
    startePositionsUpdates() {
        if (this._positionsTimer) return;

        this._positionsTimer = setInterval(() => {
            if (this._letztePosition && this.verbunden) {
                this.sende('position', this._letztePosition);
            }
        }, POSITIONS_INTERVALL);

        console.log(`[Netzwerk] Positions-Updates gestartet (${POSITIONS_INTERVALL}ms Intervall)`);
    }

    /**
     * Registriert einen Callback für eingehende Gegner-Positionsupdates.
     * @param {function} callback - Wird aufgerufen mit {x, y, z, rotY, rotX}
     */
    onUpdateEnemyPosition(callback) {
        this.onGegnerUpdate = callback;
    }

    /**
     * Sendet eine Treffer-Meldung an den Peer.
     * @param {string} zielId - ID des getroffenen Spielers (wird ignoriert bei P2P)
     * @param {number} schaden - Verursachter Schaden
     */
    sendHit(zielId, schaden) {
        this.sende('treffer', { schaden: schaden });
        console.log(`[Netzwerk] Treffer gesendet (${schaden} Schaden)`);
    }

    /**
     * Sendet eine Nachricht, dass ein Pickup eingesammelt wurde.
     * @param {string} id - ID des Munitionspacks
     */
    sendePickupEingesammelt(id) {
        this.sende('pickup_collected', { id: id });
    }

    /**
     * Registriert einen Callback für eingehende Treffer.
     * @param {function} callback - Wird aufgerufen mit {schaden}
     */
    onReceiveHit(callback) {
        this.onTrefferEmpfangen = callback;
    }

    /**
     * Trennt die Verbindung und räumt auf.
     */
    disconnect() {
        if (this._positionsTimer) {
            clearInterval(this._positionsTimer);
            this._positionsTimer = null;
        }
        if (this.verbindung) {
            this.verbindung.close();
        }
        if (this.peer) {
            this.peer.destroy();
        }
        this.verbunden = false;
        this._setzeStatus('OFFLINE', false);
        console.log('[Netzwerk] Verbindung getrennt und aufgeräumt');
    }

    /**
     * Gibt den Verbindungsstatus zurück.
     * @returns {boolean}
     */
    istVerbunden() {
        return this.verbunden;
    }
}
