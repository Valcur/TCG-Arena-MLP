#!/usr/bin/env node
/**
 * Mise à jour de la BDD My Little Pony TCG pour TCG Arena.
 *
 *  1. Télécharge l'export ponyrec (everything.json)
 *  2. Télécharge UNIQUEMENT les images absentes du dossier images/<SET>/
 *     (plusieurs variantes d'URL testées, celle qui marche est mémorisée)
 *  3. Rogne la bordure (sets BP01 / SD01) et tourne les images paysage
 *  4. Génère cards.json au même format que l'ancien
 *  5. Écrit un rapport détaillé des erreurs (script/update-report.md + résumé GitHub Actions)
 *
 * Emplacement : script/update-cards.js. Les fichiers internes (rapport, manifest des images,
 * anciens IDs non résolus) restent dans ce dossier script/ ; seuls cards.json et images/ sont des fichiers du jeu.
 *
 * Usage : node script/update-cards.js        (depuis la racine du repo)
 * Dépendance : sharp  (npm install sharp)
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

// ─────────────────────────────── Configuration ───────────────────────────────

const CONFIG = {
    exportUrl: process.env.EXPORT_URL || 'https://ponyrec.net/cards/export/everything.json',
    imageHost: trimSlash(process.env.IMAGE_HOST || 'https://fls-a2841c3f-fe05-483e-b40d-dfcab0102e85.laravel.cloud'),
    pagesBaseUrl: trimSlash(process.env.PAGES_BASE_URL || 'https://valcur.github.io/TCG-Arena-MLP'),
    repoRoot: path.resolve(process.env.REPO_ROOT || path.join(__dirname, '..')),

    // fichiers du jeu, relatifs à la racine du repo
    cardsFile: 'cards.json',
    imagesDir: 'images',                   // images/<SET>/<ID>.webp

    // fichiers internes, dans le dossier du script
    manifestPath: path.join(__dirname, 'manifest.json'),            // source / rotation de chaque image
    reportPath: path.join(__dirname, 'update-report.md'),
    unresolvedPath: path.join(__dirname, 'unresolved-old-ids.json'), // anciens IDs sans alias, retentés à chaque run
    legacyManifestFile: 'images/manifest.json',                      // ancien emplacement, migré automatiquement

    cropSets: ['BP01', 'SD01'],            // préfixes de set dont on retire la bordure (SD01 couvre aussi SD01A..F)
    cropPx: 20,                            // bordure retirée de chaque côté
    excludedSets: [],                      // ex: ['BP03'] pour ignorer un set
    includeCardsWithoutImage: true,        // garder dans cards.json les cartes sans image (sinon decks cassés)

    concurrency: 4,
    timeoutMs: 30_000,
    retries: 3,
    webpQuality: 90,
    minRatioVsPrevious: 0.8,               // sécurité : refuse d'écrire si l'export a perdu >20% des cartes (FORCE=1 pour forcer)
    userAgent: 'TCG-Arena-MLP-updater (+https://valcur.github.io/TCG-Arena-MLP)',
};

const SUBTYPE_NAMES = {
    'character': 'Character',
    'main-character': 'Main Character',
    'story': 'Story',
    'event': 'Event',
    'item': 'Item',
    'scene': 'Scene',
    'token': 'Token',        // + isToken: true à la racine de l'entrée
};
// set et rarity sont écrits tels quels avec leur code (set: "BP01", rarity: "※CR") ;
// les noms affichés sont gérés dans le fichier de traduction de TCG Arena.

/**
 * Alias pour les anciens IDs (moteur : `if (card.aliasOf) card = gameCards[card.aliasOf]`).
 * Un ID présent dans l'ancien cards.json mais absent de l'export devient { id, aliasOf: <nouvel id> }.
 *
 * ALIAS_OVERRIDES : correspondances forcées à la main, prioritaires sur tout le reste.
 *   ex: '※PR07-S': '※PR07P2'
 * LEGACY_SUFFIX_RULES : anciens suffixes de variante → suffixes possibles dans la nouvelle BDD, testés dans l'ordre.
 *   ex: ※BP02-CR01-TOS → ※BP02-CR01P2 (signed promo), ※BP02-CR01-TO → ※BP02-CR01P (promo)
 */
const ALIAS_OVERRIDES = {
};
const LEGACY_SUFFIX_RULES = {
    TOS: ['P2', 'TOS', 'S'],
    TO: ['P', 'TO'],
    S: ['S', 'P2', 'P'],
};

// ─────────────────────────────── Rapport d'erreurs ───────────────────────────────

const issues = []; // { level: 'error' | 'warning', category, id, message, details? }

function report(level, category, id, message, details) {
    issues.push({ level, category, id, message, details });
}

class FatalError extends Error { }

// ─────────────────────────────── Utilitaires ───────────────────────────────

function trimSlash(s) { return s.replace(/\/+$/, ''); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rel(...p) { return path.join(CONFIG.repoRoot, ...p); }
function safeFileName(s) { return s.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_'); }

function dedupeBy(list, keyFn) {
    const seen = new Set();
    return list.filter(x => {
        const k = keyFn(x);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

async function readJsonIfExists(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') report('warning', 'Fichiers locaux', path.basename(file), `Lecture impossible (${e.message}), fichier ignoré`);
        return fallback;
    }
}

async function writeFileAtomic(file, content) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, file);
}

async function runPool(items, limit, worker) {
    let i = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            const item = items[i++];
            await worker(item);
        }
    });
    await Promise.all(runners);
}

/**
 * GET avec retries sur erreurs réseau / 429 / 5xx.
 * Retourne { ok, status, buffer, contentType } ou { notFound } ou { error }.
 */
async function httpGet(url) {
    let lastError = 'erreur inconnue';
    for (let attempt = 1; attempt <= CONFIG.retries; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': CONFIG.userAgent },
                signal: AbortSignal.timeout(CONFIG.timeoutMs),
            });
            // 403 : les stockages type S3/R2 renvoient souvent 403 pour un fichier inexistant
            if ([403, 404, 410].includes(res.status)) return { notFound: true, status: res.status };
            if (res.status === 429 || res.status >= 500) {
                lastError = `HTTP ${res.status}`;
            } else if (!res.ok) {
                return { error: `HTTP ${res.status}`, status: res.status };
            } else {
                const buffer = Buffer.from(await res.arrayBuffer());
                return { ok: true, status: res.status, buffer, contentType: res.headers.get('content-type') || '' };
            }
        } catch (e) {
            lastError = e.name === 'TimeoutError' ? `timeout après ${CONFIG.timeoutMs / 1000}s` : (e.cause?.code || e.message);
        }
        if (attempt < CONFIG.retries) await sleep(1000 * 2 ** (attempt - 1));
    }
    return { error: lastError };
}

// ─────────────────────────────── Identifiants & URLs d'images ───────────────────────────────

/** "※BP01-CR04P" → { alt: true, bare: "BP01-CR04P", base: "BP01", letters: "CR", digits: "04", tail: "P" } */
function parseCardNumber(cardNumber) {
    const alt = cardNumber.startsWith('※');
    const bare = alt ? cardNumber.slice(1) : cardNumber;
    const dash = bare.lastIndexOf('-');
    const base = dash >= 0 ? bare.slice(0, dash) : '';
    const rest = dash >= 0 ? bare.slice(dash + 1) : bare;
    const m = rest.match(/^([A-Za-z]+)(\d+)(.*)$/);
    return { alt, bare, base, letters: m?.[1], digits: m?.[2], tail: m?.[3] ?? '' };
}

/**
 * Variantes du nom de fichier distant.
 *   BP01-C02    → BP01-C-002 (tiret-0), BP01-C02 (exact)...
 *   ※BP01-RR01  → BP01-xRR-001 : le ※ devient un "x" collé à la rareté
 */
function candidateFileNames(p, setCode) {
    const x = p.alt ? 'x' : '';
    const out = [];
    if (p.letters) {
        // préfixe du nom : celui de l'ID, puis le code du set qui contient la carte
        // (SD01-ER08 rangée dans BP01 → BP01/BP01-ER-008.webp)
        const heads = [{ k: '', head: p.base ? `${p.base}-` : '' }];
        if (p.base && setCode && setCode !== p.base) heads.push({ k: 'set-', head: `${setCode}-` });
        const L = x + p.letters;
        for (const { k, head } of heads) {
            out.push({ key: `${k}tiret-0`, name: `${head}${L}-0${p.digits}${p.tail}` });
            out.push({ key: `${k}exact`, name: `${head}${L}${p.digits}${p.tail}` });
            out.push({ key: `${k}tiret-3chiffres`, name: `${head}${L}-${p.digits.padStart(3, '0')}${p.tail}` });
            out.push({ key: `${k}tiret`, name: `${head}${L}-${p.digits}${p.tail}` });
            if (p.tail) out.push({ key: `${k}tiret-0-suffixe`, name: `${head}${L}-0${p.digits}-${p.tail}` }); // ※BP02-CR01P2 → BP02-xCR-001-P2
        }
    } else {
        out.push({ key: 'exact', name: x + p.bare });
    }
    return dedupeBy(out, o => o.name);
}

/** Nom du fichier local, sans ※ (même convention que le serveur) : ※BP01-RR01 → BP01-xRR01.webp */
function localFileName(cardNumber) {
    const p = parseCardNumber(cardNumber);
    let name = cardNumber;
    if (p.alt) name = p.base ? `${p.base}-x${p.bare.slice(p.base.length + 1)}` : `x${p.bare}`;
    return safeFileName(name) + '.webp';
}

/** Variantes du dossier distant : set de l'export, préfixe de l'ID (ex SD01 pour une carte SD01 rangée dans BP01), préfixe sans lettre (SD01A → SD01) */
function candidateFolders(setCode, p) {
    const out = [{ key: 'set', folder: setCode }];
    if (p.base) {
        out.push({ key: 'prefixe', folder: p.base });
        const stripped = p.base.replace(/[A-Za-z]+$/, '');
        if (/\d$/.test(stripped)) out.push({ key: 'prefixe-sans-lettre', folder: stripped });
    } else if (p.letters) {
        out.push({ key: 'prefixe', folder: p.letters }); // PR07 → PR
    }
    return dedupeBy(out.filter(x => x.folder), x => x.folder);
}

const patternStats = {}; // "set/tiret-0" → nb de succès (pour essayer d'abord ce qui marche)

function candidateUrls(card) {
    const p = parseCardNumber(card.id);
    const combos = [];
    for (const f of candidateFolders(card.setCode, p)) {
        for (const n of candidateFileNames(p, card.setCode)) {
            combos.push({
                key: `${f.key}/${n.key}`,
                url: `${CONFIG.imageHost}/${encodeURIComponent(f.folder)}/${encodeURIComponent(n.name)}.webp`,
            });
        }
    }
    // tri stable : les motifs qui ont déjà fonctionné passent en premier
    return combos
        .map((c, i) => ({ ...c, i }))
        .sort((a, b) => (patternStats[b.key] || 0) - (patternStats[a.key] || 0) || a.i - b.i);
}

// ─────────────────────────────── Images ───────────────────────────────

function shouldCrop(card) {
    const prefix = parseCardNumber(card.id).base;
    return CONFIG.cropSets.some(c => card.setCode.startsWith(c) || prefix.startsWith(c));
}

async function processImage(buffer, card, outFile) {
    const meta = await sharp(buffer).metadata();
    const { width, height } = meta;
    if (!width || !height) throw new Error('dimensions illisibles');

    let pipeline = sharp(buffer);
    let cropped = false;
    if (shouldCrop(card)) {
        const px = CONFIG.cropPx;
        if (width > px * 2 + 10 && height > px * 2 + 10) {
            // extract appelé AVANT rotate → découpe sur l'image d'origine (comme l'ancien script)
            pipeline = pipeline.extract({ left: px, top: px, width: width - px * 2, height: height - px * 2 });
            cropped = true;
        } else {
            report('warning', 'Image trop petite pour être rognée', card.id, `${width}x${height}px, bordure conservée`);
        }
    }
    const rotated = width > height;
    if (rotated) pipeline = pipeline.rotate(-90);

    await fsp.mkdir(path.dirname(outFile), { recursive: true });
    const tmp = outFile + '.tmp';
    await pipeline.webp({ quality: CONFIG.webpQuality }).toFile(tmp);
    await fsp.rename(tmp, outFile);
    return { width, height, cropped, rotated };
}

async function downloadImage(card, manifest, stats) {
    const candidates = candidateUrls(card);
    const transientErrors = [];

    for (const c of candidates) {
        const res = await httpGet(c.url);
        if (res.notFound) continue;
        if (res.error) { transientErrors.push(`${c.url} → ${res.error}`); continue; }

        if (!res.buffer.length) { transientErrors.push(`${c.url} → réponse vide`); continue; }
        if (res.contentType && !res.contentType.startsWith('image/') && !res.contentType.includes('octet-stream')) {
            // page HTML "soft 404" par ex.
            transientErrors.push(`${c.url} → contenu "${res.contentType}" au lieu d'une image`);
            continue;
        }

        try {
            const info = await processImage(res.buffer, card, card.localPath);
            patternStats[c.key] = (patternStats[c.key] || 0) + 1;
            manifest[card.id] = {
                file: card.relImagePath,
                source: c.url,
                pattern: c.key,
                rotated: info.rotated,
                cropped: info.cropped,
                originalSize: `${info.width}x${info.height}`,
                downloadedAt: new Date().toISOString(),
            };
            if (info.rotated && card.subtype !== 'story') {
                report('warning', 'Carte non-Story en paysage (tournée, marquée isHorizontal)', card.id, `${info.width}x${info.height}px`);
            }
            if (!info.rotated && card.subtype === 'story') {
                report('warning', 'Carte Story en portrait (non tournée)', card.id, `${info.width}x${info.height}px — vérifier l'affichage`);
            }
            stats.downloaded++;
            console.log(`  ✅ ${card.id}  ←  ${c.key}${info.cropped ? ' · rognée' : ''}${info.rotated ? ' · tournée' : ''}`);
            return true;
        } catch (e) {
            report('error', 'Image téléchargée mais illisible / traitement échoué', card.id, e.message, [c.url]);
            console.log(`  ❌ ${card.id}  traitement échoué : ${e.message}`);
            return false;
        }
    }

    if (transientErrors.length) {
        report('error', 'Échec de téléchargement (réseau / serveur)', card.id, `${transientErrors.length} erreur(s)`, transientErrors);
    } else {
        report('error', 'Image introuvable sur le serveur', card.id, `${candidates.length} URLs testées (set ${card.setCode})`, candidates.map(c => c.url));
    }
    console.log(`  ❌ ${card.id}  aucune image trouvée`);
    return false;
}

// ─────────────────────────────── Lecture de l'export ───────────────────────────────

async function fetchExport() {
    console.log(`📥 Téléchargement de l'export : ${CONFIG.exportUrl}`);
    const res = await httpGet(CONFIG.exportUrl);
    if (!res.ok) throw new FatalError(`Export inaccessible (${res.error || 'HTTP ' + res.status})`);
    let data;
    try {
        data = JSON.parse(res.buffer.toString('utf8'));
    } catch (e) {
        throw new FatalError(`Export illisible, JSON invalide (${e.message})`);
    }
    if (!data || !Array.isArray(data.sets)) {
        throw new FatalError(`Structure de l'export inattendue : pas de tableau "sets" (clés trouvées : ${Object.keys(data || {}).join(', ') || 'aucune'})`);
    }
    console.log(`   exporté le ${data.exportedAt || '?'} · ${data.sets.length} set(s)`);
    return data;
}

/** Aplatis les sets en liste de cartes validées, sans doublons */
function collectCards(data) {
    const cards = [];
    const seen = new Map(); // id → setCode
    const unknownSubtypes = new Map(); // subtype → [ids]

    for (const set of data.sets) {
        const setCode = set.setCode || set.id || 'UNKNOWN';
        const setName = set.metadata?.officialName || set.seriesName || '?';

        if (set.product && set.product !== 'mlp' || set.cardGameType && set.cardGameType !== 'tcg') {
            report('warning', 'Sets ignorés (pas MLP TCG)', setCode, `product=${set.product}, cardGameType=${set.cardGameType}`);
            continue;
        }
        if (CONFIG.excludedSets.includes(setCode)) {
            report('warning', 'Sets ignorés (exclus dans la config)', setCode, setName);
            continue;
        }
        if (!set.setCode) report('error', 'Données de set invalides', setCode, 'setCode manquant, utilisation de l\'id du set');
        if (!Array.isArray(set.cards)) {
            report('error', 'Données de set invalides', setCode, 'pas de tableau "cards"');
            continue;
        }
        const announced = set.metadata?.totalCards;
        if (announced && announced !== set.cards.length) {
            report('warning', 'Nombre de cartes différent du total annoncé', setCode, `${set.cards.length} dans l'export, ${announced} annoncées`);
        }

        for (const raw of set.cards) {
            const id = typeof raw?.cardNumber === 'string' ? raw.cardNumber.trim() : '';
            if (!id) {
                report('error', 'Carte invalide (ignorée)', setCode, `cardNumber manquant : ${JSON.stringify(raw).slice(0, 120)}`);
                continue;
            }
            if (seen.has(id)) {
                report('warning', 'Doublons (première occurrence gardée)', id, `présent dans ${seen.get(id)} et ${setCode}`);
                continue;
            }
            seen.set(id, setCode);

            const t = raw.tcgData || {};
            if (!raw.tcgData) report('error', 'Données de carte incomplètes', id, 'tcgData manquant');
            if (!raw.name) report('error', 'Données de carte incomplètes', id, 'nom manquant');

            const subtype = t.cardSubtype || '';
            if (!SUBTYPE_NAMES[subtype]) addTo(unknownSubtypes, subtype, id);
            if (subtype === 'story' && !t.storyStage) report('warning', 'Données de carte incomplètes', id, 'Story sans storyStage');
            if (['character', 'event', 'item'].includes(subtype) && t.harmonyCost == null) report('warning', 'Données de carte incomplètes', id, 'harmonyCost manquant (coût mis à 0)');
            if (subtype === 'character' && t.inspiration == null) report('warning', 'Données de carte incomplètes', id, 'inspiration manquante (power mis à 0)');

            const rarity = String(raw.rarity || '').trim();
            if (!rarity) report('warning', 'Données de carte incomplètes', id, 'rarity manquante');

            const folder = safeFileName(setCode);
            const file = localFileName(id);
            if (/[<>:"/\\|?*\x00-\x1F]/.test(id)) report('warning', 'Caractères interdits remplacés dans le nom de fichier', id, file);

            cards.push({
                id,
                raw,
                subtype,
                setCode,
                setName, // utilisé seulement dans le rapport
                rarity,
                relImagePath: `${folder}/${file}`,
                localPath: rel(CONFIG.imagesDir, folder, file),
                legacyLocalPath: rel(CONFIG.imagesDir, folder, safeFileName(id) + '.webp'), // ancien nom avec ※
                imageUrl: `${CONFIG.pagesBaseUrl}/${CONFIG.imagesDir}/${folder}/${file}`,
            });
        }
    }

    // signalés une fois par valeur, pas une fois par carte
    const sample = ids => `${ids.length} carte(s) : ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? '…' : ''}`;
    for (const [subtype, ids] of unknownSubtypes) {
        report('warning', 'Type de carte inconnu (ajouté tel quel, à ajouter dans SUBTYPE_NAMES)', `cardSubtype="${subtype}"`, `→ "${typeName(subtype)}" · ${sample(ids)}`);
    }
    return cards;
}

function addTo(map, key, id) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(id);
}

// ─────────────────────────────── Format cards.json ───────────────────────────────

function typeName(subtype) {
    return SUBTYPE_NAMES[subtype] || subtype.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'Unknown';
}

function buildCardEntry(card, image, isHorizontal) {
    const t = card.raw.tcgData || {};
    const baseType = typeName(card.subtype);
    const type = card.subtype === 'story' && t.storyStage ? `${baseType} ${t.storyStage}` : baseType;
    const name = `${card.raw.name || t.mainTitle || '?'} ${card.id.replace('※', '')}`;
    const cost = t.harmonyCost ?? 0;

    const entry = {
        id: card.id,
        face: {
            front: { name, type: baseType, cost, image, isHorizontal },
        },
        name,
        type,
        cost,
        set: card.setCode,
        rarity: card.rarity,
        isHorizontal,
        power: t.inspiration ?? 0,
    };
    if (card.subtype === 'token') entry.isToken = true;
    return entry;
}

/** URL GitHub Pages → chemin local (pour vérifier qu'une ancienne image existe encore) */
function localPathFromPagesUrl(url) {
    if (typeof url !== 'string' || !url.startsWith(CONFIG.pagesBaseUrl + '/')) return null;
    return rel(decodeURIComponent(url.slice(CONFIG.pagesBaseUrl.length + 1)));
}

// ─────────────────────────────── Alias des anciens IDs ───────────────────────────────

/** "BP01-C-002" et "BP01-C02" → même clé ; le ※ est conservé (illustration différente) */
function normalizeId(id) {
    return id.toUpperCase().replace(/-/g, '').replace(/(\D)0+(\d)/g, '$1$2');
}

/** "※BP02-CR01-TOS" → { base: "※BP02-CR01", suffix: "TOS" } (suffixe en lettres après le numéro) */
function splitLegacySuffix(id) {
    const m = id.match(/^(.*\d)-([A-Za-z]+)$/);
    return m ? { base: m[1], suffix: m[2].toUpperCase() } : null;
}

/** Devine la nouvelle carte correspondant à un ancien ID. Retourne { target, how, approx } ou null. */
function guessAliasTarget(oldId, realIds, normIndex) {
    const legacy = splitLegacySuffix(oldId);

    // 1. ancien suffixe de variante → nouveau suffixe
    if (legacy) {
        for (const s of LEGACY_SUFFIX_RULES[legacy.suffix] || [legacy.suffix]) {
            if (realIds.has(legacy.base + s)) return { target: legacy.base + s, how: `suffixe -${legacy.suffix} → ${s}`, approx: true };
        }
    }
    // 2. même ID à la mise en forme près (tirets, zéros)
    const same = normIndex.get(normalizeId(oldId)) || [];
    if (same.length === 1) return { target: same[0], how: 'ID équivalent', approx: false };

    // 3. replis approximatifs : même carte, autre illustration
    //    base de variante : "※BP02-CR01-TO" / "※BP02-CR01P2" / "※SD01-ER01D" → "※BP02-CR01" / "※SD01-ER01"
    const variantBase = legacy?.base || oldId.match(/^(.*?[A-Za-z]+\d+)[A-Za-z]+\d*$/)?.[1];
    if (variantBase && realIds.has(variantBase)) return { target: variantBase, how: 'carte de base (variante introuvable)', approx: true };
    if (oldId.startsWith('※')) {
        for (const t of [oldId.slice(1), variantBase?.slice(1)]) {
            if (t && realIds.has(t)) return { target: t, how: 'version non-※ (variante introuvable)', approx: true };
        }
    }
    return null;
}

/**
 * Calcule les alias : anciens IDs (ancien cards.json + ALIAS_OVERRIDES) qui ne sont plus de vraies cartes.
 * Les alias des runs précédents sont conservés ; les chaînes A→B→C sont aplaties (le moteur ne suit qu'un niveau).
 */
function computeAliases(previousCards, out, pendingOld) {
    const realIds = new Set(Object.keys(out));
    const normIndex = new Map();
    for (const id of realIds) {
        const k = normalizeId(id);
        normIndex.set(k, [...(normIndex.get(k) || []), id]);
    }

    const raw = {}; // oldId → { target, how, approx, carried }
    const unresolved = {}; // oldId → ancien nom
    const oldIds = new Set([...Object.keys(previousCards), ...Object.keys(pendingOld), ...Object.keys(ALIAS_OVERRIDES)]);
    for (const oldId of oldIds) {
        if (realIds.has(oldId)) continue; // redevenue (ou toujours) une vraie carte
        const prev = previousCards[oldId] || { name: pendingOld[oldId] };

        if (ALIAS_OVERRIDES[oldId]) {
            raw[oldId] = { target: ALIAS_OVERRIDES[oldId], how: 'manuel', approx: false };
        } else if (prev?.aliasOf) {
            raw[oldId] = { target: prev.aliasOf, how: 'alias existant', approx: false, carried: true };
        } else {
            const guess = guessAliasTarget(oldId, realIds, normIndex);
            if (guess) raw[oldId] = guess;
            else {
                unresolved[oldId] = prev?.name || '';
                report('warning', 'Anciens IDs sans correspondance (decks contenant ces cartes cassés)', oldId,
                    `${prev?.name || ''} — ajoute-le dans ALIAS_OVERRIDES si tu connais la nouvelle carte`);
            }
        }
    }

    const resolved = {};
    for (const [oldId, a] of Object.entries(raw)) {
        let target = a.target;
        const seen = new Set([oldId]);
        while (!realIds.has(target) && raw[target] && !seen.has(target)) {
            seen.add(target);
            target = raw[target].target;
        }
        if (!realIds.has(target)) {
            unresolved[oldId] = previousCards[oldId]?.name || pendingOld[oldId] || '';
            report('warning', 'Alias impossible : la carte cible n\'existe plus', oldId, `cible "${a.target}" (${a.how})`);
            continue;
        }
        resolved[oldId] = { ...a, target };
        if (!a.carried && a.approx) {
            report('warning', 'Alias créés par approximation (vérifie que c\'est la bonne carte / illustration)', oldId, `→ ${target} (${a.how})`);
        }
    }
    return { aliases: resolved, unresolved };
}

// ─────────────────────────────── Tokens ───────────────────────────────

/** Parcourt toutes les valeurs texte d'un objet : cb("tcgData.effects[0].text", "…") */
function walkStrings(obj, cb, p = '') {
    if (typeof obj === 'string') return cb(p, obj);
    if (Array.isArray(obj)) return obj.forEach((v, i) => walkStrings(v, cb, `${p}[${i}]`));
    if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) walkStrings(v, cb, p ? `${p}.${k}` : k);
}

/**
 * Cherche dans l'export ce qui relie les tokens aux cartes qui les créent :
 *  - lien "structurel" : un champ d'une carte contient le cardNumber d'un token
 *  - lien "texte" : un texte d'effet mentionne le nom du token
 *  - toute carte dont un texte contient le mot "token"
 */
function analyzeTokens(cards) {
    const tokens = cards.filter(c => c.subtype === 'token');
    if (!tokens.length) return null;
    const others = cards.filter(c => c.subtype !== 'token');
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const snippet = (v, i) => (i > 40 ? '…' : '') + v.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, ' ') + (i + 80 < v.length ? '…' : '');

    const perToken = tokens.map(tk => {
        const idRe = new RegExp(`(^|[^A-Za-z0-9])${esc(tk.id)}($|[^A-Za-z0-9])`);
        const name = (tk.raw.name || '').trim();
        const nameRe = name.length > 2 ? new RegExp(`\\b${esc(name)}\\b`, 'i') : null;
        const structural = [], textual = [];
        for (const c of others) {
            walkStrings(c.raw, (p, v) => {
                let m;
                if ((m = idRe.exec(v))) structural.push({ id: c.id, field: p, text: snippet(v, m.index) });
                else if (nameRe && !/^(name|cardNumber|tcgData\.mainTitle)$/.test(p) && (m = nameRe.exec(v))) {
                    textual.push({ id: c.id, field: p, text: snippet(v, m.index) });
                }
            });
        }
        return { id: tk.id, name, raw: tk.raw, structural, textual };
    });

    const mentions = [];
    for (const c of others) {
        walkStrings(c.raw, (p, v) => {
            const m = /\btokens?\b/i.exec(v);
            if (m) mentions.push({ id: c.id, field: p, text: snippet(v, m.index) });
        });
    }
    return { perToken, mentions };
}

function tokenReportLines(t) {
    const lines = ['## 🪙 Tokens : lien avec les cartes qui les créent', ''];
    const nStruct = t.perToken.reduce((n, x) => n + x.structural.length, 0);
    lines.push(nStruct
        ? `**Lien structurel trouvé** : ${nStruct} champ(s) de cartes contiennent un numéro de token (détail ci-dessous).`
        : '**Aucun lien structurel** : aucun champ d\'une carte ne contient le numéro d\'un token. Le seul lien possible est le texte d\'effet.', '');
    lines.push(`Cartes dont un texte contient le mot "token" : ${t.mentions.length}`, '');
    t.mentions.slice(0, 40).forEach(m => lines.push(`- \`${m.id}\` (${m.field}) : ${m.text}`));
    if (t.mentions.length > 40) lines.push(`- … et ${t.mentions.length - 40} autre(s)`);
    lines.push('');
    for (const tk of t.perToken) {
        lines.push(`### \`${tk.id}\` — ${tk.name || '(sans nom)'}`, '');
        lines.push('```json', JSON.stringify(tk.raw), '```', '');
        if (tk.structural.length) {
            lines.push('Champs qui référencent ce token :');
            tk.structural.forEach(s => lines.push(`- \`${s.id}\` → \`${s.field}\` : ${s.text}`));
            lines.push('');
        }
        if (tk.textual.length) {
            lines.push(`Textes qui mentionnent "${tk.name}" (${tk.textual.length}) :`);
            tk.textual.slice(0, 15).forEach(s => lines.push(`- \`${s.id}\` (${s.field}) : ${s.text}`));
            if (tk.textual.length > 15) lines.push(`- … et ${tk.textual.length - 15} autre(s)`);
        }
        if (!tk.structural.length && !tk.textual.length) lines.push('_Aucune carte ne le référence ni ne mentionne son nom._');
        lines.push('');
    }
    return lines;
}

// ─────────────────────────────── Rapport ───────────────────────────────

function buildReport(summary) {
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    const lines = [];
    lines.push(`# Mise à jour des cartes MLP — ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`, '');
    lines.push(`Export ponyrec du ${summary.exportedAt || '?'}`, '');
    lines.push('| | |', '|---|---|');
    lines.push(`| Sets traités | ${summary.sets.join(', ') || '—'} |`);
    lines.push(`| Cartes dans cards.json | ${summary.cardCount} (avant : ${summary.previousCount}) |`);
    lines.push(`| Nouvelles cartes | ${summary.added.length} |`);
    lines.push(`| Alias (anciens IDs) | ${summary.aliasCount} dont ${summary.newAliases.length} créés ce run |`);
    lines.push(`| 🌐 Nouveaux codes à traduire | ${summary.newCodes.length} |`);
    lines.push(`| Images téléchargées | ${summary.downloaded} |`);
    lines.push(`| Images déjà présentes | ${summary.alreadyPresent} |`);
    lines.push(`| Cartes sans image | ${summary.withoutImage} |`);
    lines.push(`| ❌ Erreurs | ${errors.length} |`);
    lines.push(`| ⚠️ Avertissements | ${warnings.length} |`, '');

    if (summary.fatal) lines.push(`## 💥 Erreur bloquante`, '', summary.fatal, '', 'cards.json n\'a PAS été modifié.', '');
    if (summary.newCodes.length) lines.push(...translationLines(summary.newCodes), '');

    const section = (title, list) => {
        if (!list.length) return;
        lines.push(`## ${title} (${list.length})`, '');
        const byCat = new Map();
        for (const i of list) {
            if (!byCat.has(i.category)) byCat.set(i.category, []);
            byCat.get(i.category).push(i);
        }
        for (const [cat, items] of byCat) {
            lines.push(`### ${cat} — ${items.length}`, '');
            items.forEach((i, idx) => {
                lines.push(`- \`${i.id}\` — ${i.message}`);
                // URLs testées : détaillées pour les 5 premières cartes de la catégorie seulement
                if (i.details?.length && idx < 5) i.details.forEach(d => lines.push(`  - ${d}`));
            });
            if (items.some((i, idx) => i.details?.length && idx >= 5)) lines.push('', '_(URLs détaillées uniquement pour les 5 premières cartes)_');
            lines.push('');
        }
    };
    section('❌ Erreurs', errors);
    section('⚠️ Avertissements', warnings);

    const patterns = Object.entries(patternStats).sort((a, b) => b[1] - a[1]);
    if (patterns.length) {
        lines.push('## ℹ️ Motifs d\'URL qui ont fonctionné (ce run)', '');
        lines.push('`dossier/nom` — dossier : set = setCode de l\'export, prefixe = début de l\'ID · nom : tiret-0 = `BP01-C-002`, exact = `BP01-C02`', '');
        patterns.forEach(([k, n]) => lines.push(`- \`${k}\` : ${n}`));
        lines.push('');
    }
    if (summary.tokens) lines.push(...tokenReportLines(summary.tokens));
    if (summary.newAliases.length) {
        lines.push(`## 🔗 Alias créés ce run (${summary.newAliases.length})`, '');
        summary.newAliases.forEach(a => lines.push(`- \`${a.oldId}\` → \`${a.target}\` (${a.how})`));
        lines.push('');
    }
    if (summary.added.length) {
        lines.push(`## ➕ Nouvelles cartes (${summary.added.length})`, '');
        lines.push(summary.added.map(id => `\`${id}\``).join(', '), '');
    }
    return lines.join('\n');
}

/** Bloc prêt à coller dans translations.json (objet "en") */
function translationSnippet(newCodes) {
    return newCodes.map(c => `        ${JSON.stringify(c.code)}: ${JSON.stringify(c.suggestion)},`).join('\n');
}

function translationLines(newCodes) {
    return [
        `## 🌐 Nouveaux codes à traduire (${newCodes.length})`, '',
        'À coller au début de l\'objet `"en"` de translations.json (les sets sont pré-remplis avec le nom officiel de l\'export, les raretés sont à compléter) :', '',
        '```json', translationSnippet(newCodes), '```', '',
        ...newCodes.map(c => `- ${c.field === 'set' ? 'set' : 'rareté'} \`${c.code}\` — ${c.n} carte(s)`),
    ];
}

async function writeReport(summary) {
    const md = buildReport(summary);
    await writeFileAtomic(CONFIG.reportPath, md);

    if (process.env.GITHUB_STEP_SUMMARY) {
        // le résumé GitHub est limité à 1 Mo
        const limited = md.length > 900_000 ? md.slice(0, 900_000) + '\n\n_(tronqué, voir script/update-report.md)_' : md;
        await fsp.appendFile(process.env.GITHUB_STEP_SUMMARY, limited + '\n');
    }
    if (process.env.GITHUB_OUTPUT) {
        const nErr = issues.filter(i => i.level === 'error').length;
        const nWarn = issues.filter(i => i.level === 'warning').length;
        await fsp.appendFile(process.env.GITHUB_OUTPUT, `errors=${nErr}\nwarnings=${nWarn}\n`);
    }
}

function printIssuesToConsole() {
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    const print = (icon, list) => {
        const byCat = new Map();
        list.forEach(i => byCat.set(i.category, [...(byCat.get(i.category) || []), i]));
        for (const [cat, items] of byCat) {
            console.log(`\n${icon} ${cat} (${items.length})`);
            items.forEach(i => console.log(`   - ${i.id} : ${i.message}`));
        }
    };
    if (errors.length) { console.log(`\n════════ ❌ ${errors.length} ERREUR(S) ════════`); print('❌', errors); }
    if (warnings.length) { console.log(`\n════════ ⚠️  ${warnings.length} AVERTISSEMENT(S) ════════`); print('⚠️ ', warnings); }
    if (!errors.length && !warnings.length) console.log('\n✨ Aucune erreur, aucun avertissement.');
}

// ─────────────────────────────── Main ───────────────────────────────

async function main() {
    const summary = {
        exportedAt: null, sets: [], cardCount: 0, previousCount: 0, added: [], aliasCount: 0, newAliases: [], tokens: null, newCodes: [],
        downloaded: 0, alreadyPresent: 0, withoutImage: 0, fatal: null,
    };

    try {
        const cardsPath = rel(CONFIG.cardsFile);
        const manifestPath = CONFIG.manifestPath;
        const unresolvedPath = CONFIG.unresolvedPath;
        const previousCards = await readJsonIfExists(cardsPath, {});
        // migration : l'ancien manifest était dans images/, il passe dans le dossier du script
        const legacyManifest = rel(CONFIG.legacyManifestFile);
        if (!fs.existsSync(manifestPath) && fs.existsSync(legacyManifest)) {
            await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
            await fsp.rename(legacyManifest, manifestPath);
            console.log(`📦 manifest déplacé : ${CONFIG.legacyManifestFile} → ${path.relative(CONFIG.repoRoot, manifestPath)}`);
        }
        const manifest = await readJsonIfExists(manifestPath, {});
        const pendingOld = await readJsonIfExists(unresolvedPath, {});
        summary.previousCount = Object.values(previousCards).filter(c => !c?.aliasOf).length;

        // les motifs qui ont marché les fois précédentes sont essayés en premier
        for (const m of Object.values(manifest)) if (m?.pattern) patternStats[m.pattern] = (patternStats[m.pattern] || 0) + 1;
        const historicalStats = { ...patternStats };

        const data = await fetchExport();
        summary.exportedAt = data.exportedAt;
        const cards = collectCards(data);
        summary.sets = [...new Set(cards.map(c => c.setCode))];
        if (!cards.length) throw new FatalError('Aucune carte exploitable dans l\'export');

        if (summary.previousCount && cards.length < summary.previousCount * CONFIG.minRatioVsPrevious && process.env.FORCE !== '1') {
            throw new FatalError(`L'export ne contient que ${cards.length} cartes contre ${summary.previousCount} dans le cards.json actuel. ` +
                `Probable problème côté ponyrec. Relancer avec FORCE=1 pour écraser quand même.`);
        }

        // ── Images manquantes ──
        // images d'un run précédent nommées avec ※ → renommées sans le symbole (pas de re-téléchargement)
        let renamed = 0;
        for (const c of cards) {
            if (c.legacyLocalPath !== c.localPath && !fs.existsSync(c.localPath) && fs.existsSync(c.legacyLocalPath)) {
                await fsp.rename(c.legacyLocalPath, c.localPath);
                if (manifest[c.id]) manifest[c.id].file = c.relImagePath;
                renamed++;
            }
        }
        if (renamed) console.log(`\n🔤 ${renamed} image(s) renommée(s) sans le ※`);

        summary.tokens = analyzeTokens(cards);
        if (summary.tokens) {
            const nStruct = summary.tokens.perToken.reduce((n, x) => n + x.structural.length, 0);
            console.log(`\n🪙 ${summary.tokens.perToken.length} token(s) · lien structurel carte→token : ${nStruct ? `OUI (${nStruct})` : 'aucun'} · ` +
                `${summary.tokens.mentions.length} texte(s) mentionnant "token" — détail dans le rapport`);
        }

        const missing = cards.filter(c => !fs.existsSync(c.localPath));
        summary.alreadyPresent = cards.length - missing.length;
        console.log(`\n🖼️  ${summary.alreadyPresent} image(s) déjà présente(s), ${missing.length} à télécharger\n`);
        await runPool(missing, CONFIG.concurrency, card => downloadImage(card, manifest, summary));

        // ── cards.json ──
        const out = {};
        for (const card of cards) {
            const isStory = card.subtype === 'story';
            let image = card.imageUrl;
            let isHorizontal = isStory || manifest[card.id]?.rotated === true;

            if (!fs.existsSync(card.localPath)) {
                summary.withoutImage++;
                // repli : l'ancienne image du précédent cards.json, si elle existe encore dans le repo
                const prev = previousCards[card.id];
                const prevImage = prev?.face?.front?.image;
                const prevLocal = localPathFromPagesUrl(prevImage);
                if (prevLocal && prevLocal !== card.localPath && fs.existsSync(prevLocal)) {
                    image = prevImage;
                    isHorizontal = isStory || prev.isHorizontal === true;
                    report('warning', 'Ancienne image réutilisée faute de nouvelle', card.id, prevImage.slice(CONFIG.pagesBaseUrl.length));
                } else if (!CONFIG.includeCardsWithoutImage) {
                    report('warning', 'Cartes retirées de cards.json faute d\'image', card.id, 'includeCardsWithoutImage=false');
                    continue;
                }
            }
            out[card.id] = buildCardEntry(card, image, isHorizontal);
        }

        // ── Codes de set / rareté absents du cards.json précédent → à ajouter dans translations.json ──
        //    translations.json n'a qu'un niveau de clés : un code déjà vu comme set OU comme rareté est connu,
        //    et un code présent dans les deux (ex: PR, TK) n'est proposé qu'une fois
        const setNames = new Map(cards.map(c => [c.setCode, c.setName]));
        const known = new Set(Object.values(previousCards).flatMap(c => [c?.set, c?.rarity]).filter(Boolean));
        for (const field of ['set', 'rarity']) {
            const now = new Map();
            for (const c of Object.values(out)) now.set(c[field], (now.get(c[field]) || 0) + 1);
            for (const [code, n] of now) {
                if (!code || known.has(code)) continue;
                known.add(code);
                // nom pré-rempli pour les sets (nom officiel de l'export), vide pour les raretés
                const suggestion = field === 'set' && setNames.get(code) !== '?' ? setNames.get(code) : '';
                summary.newCodes.push({ field, code, n, suggestion });
            }
        }

        // ── Alias : les anciens IDs disparus pointent vers la nouvelle carte ──
        const realIds = Object.keys(out);
        summary.added = realIds.filter(id => !(id in previousCards)).sort();
        const { aliases, unresolved } = computeAliases(previousCards, out, pendingOld);
        for (const [oldId, a] of Object.entries(aliases)) out[oldId] = { id: oldId, aliasOf: a.target };
        summary.aliasCount = Object.keys(aliases).length;
        summary.newAliases = Object.entries(aliases).filter(([, a]) => !a.carried).map(([oldId, a]) => ({ oldId, ...a }));

        // ── Écriture ──
        const sorted = Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]]));
        await writeFileAtomic(cardsPath, JSON.stringify(sorted, null, 2) + '\n');
        const sortedManifest = Object.fromEntries(Object.keys(manifest).sort().map(k => [k, manifest[k]]));
        await writeFileAtomic(manifestPath, JSON.stringify(sortedManifest, null, 2) + '\n');
        if (Object.keys(unresolved).length) {
            const sortedUnresolved = Object.fromEntries(Object.keys(unresolved).sort().map(k => [k, unresolved[k]]));
            await writeFileAtomic(unresolvedPath, JSON.stringify(sortedUnresolved, null, 2) + '\n');
        } else {
            await fsp.rm(unresolvedPath, { force: true });
        }
        summary.cardCount = realIds.length;

        // stats du rapport = uniquement ce run
        for (const k of Object.keys(patternStats)) {
            patternStats[k] -= historicalStats[k] || 0;
            if (patternStats[k] <= 0) delete patternStats[k];
        }

        console.log(`\n💾 ${CONFIG.cardsFile} écrit : ${summary.cardCount} cartes (${summary.added.length} nouvelles) + ${summary.aliasCount} alias (${summary.newAliases.length} nouveaux), ${summary.downloaded} image(s) téléchargée(s)`);
    } catch (e) {
        summary.fatal = e instanceof FatalError ? e.message : `Erreur inattendue : ${e.stack || e.message}`;
        console.error(`\n💥 ${summary.fatal}`);
    }

    printIssuesToConsole();
    if (summary.newCodes.length) {
        console.log(`\n🌐 ${summary.newCodes.length} nouveau(x) code(s) à traduire — à coller au début de "en" dans translations.json :\n`);
        console.log(translationSnippet(summary.newCodes));
    }
    await writeReport(summary).catch(e => console.error('Impossible d\'écrire le rapport :', e.message));
    console.log(`\n📄 Rapport : ${path.relative(CONFIG.repoRoot, CONFIG.reportPath)}`);
    if (summary.fatal) process.exitCode = 1;
}

main();
