const fs = require('fs');

// Configuration
const inputFile = 'db.json';
const outputFile = 'cards.json';
const baseUrl = 'https://valcur.github.io/TCG-Arena-MLP/images/cardsFinal/';

// Lecture du fichier source
fs.readFile(inputFile, 'utf8', (err, data) => {
    if (err) {
        console.error("Erreur lors de la lecture du fichier :", err);
        return;
    }

    try {
        const originalCards = JSON.parse(data);
        const mlpCards = {};

        const setNames = {
            "SD01": "Friendship Begin",
            "BP01": "Fantasy Wonderland",
        };

        function getSetName(setCode) {
            const key = Object.keys(setNames).find(k => setCode.startsWith(k));

            return key ? setNames[key] : "Unknown Set";
        }

        originalCards.forEach(card => {
            const id = card.id;
            const costValue = card.cost || 0;
            let type = card.type
            let isHorizontal = false
            if (type == "Story") {
                type += " " + card.story_stage
                isHorizontal = true
            }
            let name = card.name + " " + card.id.replace('※', '')

            mlpCards[id] = {
                "id": id,
                "face": {
                    "front": {
                        "name": name,
                        "type": card.type,
                        "cost": costValue,
                        "image": baseUrl + id + ".webp",
                        "isHorizontal": isHorizontal
                    }
                },
                "name": name,
                "type": type,
                "cost": costValue,
                "set": getSetName(card.deck),
                "isHorizontal": isHorizontal
            };
        });

        // Écriture du nouveau fichier
        fs.writeFile(outputFile, JSON.stringify(mlpCards, null, 2), 'utf8', (err) => {
            if (err) {
                console.error("Erreur lors de l'écriture du fichier :", err);
            } else {
                console.log(`Fichier ${outputFile} créé avec succès ! (${originalCards.length} cartes)`);
            }
        });

    } catch (parseErr) {
        console.error("Erreur lors du parsing JSON :", parseErr);
    }
});