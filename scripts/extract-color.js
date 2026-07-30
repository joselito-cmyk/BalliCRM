const sharp = require('sharp');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'brand', 'balli.jpg');

sharp(file)
  .resize(1, 1)
  .raw()
  .toBuffer()
  .then((data) => {
    const [r, g, b] = data;
    const hex = ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
    console.log('#' + hex.toUpperCase());
  })
  .catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
