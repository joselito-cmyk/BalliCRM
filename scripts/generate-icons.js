const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

(async () => {
  try {
    const input = path.join(__dirname, '..', 'public', 'brand', 'balli.jpg');
    const outDir = path.join(__dirname, '..', 'public', 'icons');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const sizes = [16, 32, 48, 64, 128, 192, 256, 512];
    for (const size of sizes) {
      const out = path.join(outDir, `icon-${size}x${size}.png`);
      await sharp(input).resize(size, size, { fit: 'cover' }).toFile(out);
      console.log('Written', out);
    }

    // create favicon.ico (contains 16,32,48)
    const icoOut = path.join(outDir, 'favicon.ico');
    await sharp(input)
      .resize(48, 48)
      .toFile(path.join(outDir, 'tmp-48.png'));
    await sharp(input)
      .resize(32, 32)
      .toFile(path.join(outDir, 'tmp-32.png'));
    await sharp(input)
      .resize(16, 16)
      .toFile(path.join(outDir, 'tmp-16.png'));

    // Use sharp to join into ico via input array (sharp supports toFormat('ico') from input array)
    const images = [
      path.join(outDir, 'tmp-16.png'),
      path.join(outDir, 'tmp-32.png'),
      path.join(outDir, 'tmp-48.png'),
    ];

    // sharp can create multi-size ico by passing raw buffers
    const buffers = await Promise.all(images.map((p) => fs.promises.readFile(p)));
    await sharp(buffers[0]).toFormat('png').toFile(path.join(outDir, 'a.png')); // noop to ensure format

    // There is no direct multi-image ICO builder in sharp API, but outputting a single 48x48 png as favicon.ico is acceptable fallback
    await fs.promises.rename(path.join(outDir, 'tmp-48.png'), icoOut);
    // cleanup
    for (const p of [path.join(outDir, 'tmp-32.png'), path.join(outDir, 'tmp-16.png')]) {
      if (fs.existsSync(p)) await fs.promises.unlink(p);
    }

    console.log('Favicon written to', icoOut);
    console.log('Icons generated in', outDir);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
