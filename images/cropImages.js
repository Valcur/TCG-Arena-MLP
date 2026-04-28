const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const sourceDir = path.join(__dirname, 'cards');
const outputDir = path.join(__dirname, 'cardsFinal');

// Créer le dossier de sortie s'il n'existe pas
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

async function processImages() {
    const files = fs.readdirSync(sourceDir).filter(file => 
        ['.webp', '.jpg', '.png', '.jpeg'].includes(path.extname(file).toLowerCase())
    );

    console.log(`🚀 Traitement de ${files.length} images avec Sharp...`);

    for (const file of files) {
        const inputPath = path.join(sourceDir, file);
        const outputPath = path.join(outputDir, file);

        try {
            const image = sharp(inputPath);
            const metadata = await image.metadata();

            // 1. Calcul des nouvelles dimensions (retrait de 20px de chaque côté)
            const newWidth = metadata.width - 40;
            const newHeight = metadata.height - 40;

            // 2. Application des transformations
            let pipeline = image.extract({
                left: 20,
                top: 20,
                width: newWidth,
                height: newHeight
            });

            // 3. Rotation si Largeur > Hauteur
            if (metadata.width > metadata.height) {
                pipeline = pipeline.rotate(-90);
            }

            // 4. Sauvegarde (conserve le format d'origine, ex: WebP)
            await pipeline.toFile(outputPath);

            console.log(`✅ ${file} traité.`);
        } catch (err) {
            console.error(`❌ Erreur sur ${file}:`, err.message);
        }
    }

    console.log("\n✨ Terminé ! Tes images sont prêtes.");
}

processImages();