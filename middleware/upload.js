const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

// Video storage configuration
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    let dest;
    if (file.fieldname === 'thumbnail') {
      dest = path.join(__dirname, '..', 'uploads', 'thumbnails');
    } else if (file.fieldname === 'chunk') {
      dest = path.join(__dirname, '..', 'uploads', 'chunks');
    } else {
      dest = path.join(__dirname, '..', 'uploads', 'videos');
    }
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${uuidv4()}${ext}`;
    cb(null, uniqueName);
  },
});

// File filter - allow video and image files
const fileFilter = (req, file, cb) => {
  const videoTypes = /mp4|mkv|avi|mov|webm|flv|wmv|m4v|3gp/;
  const imageTypes = /jpeg|jpg|png|gif|webp|bmp/;
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');

  if (file.fieldname === 'thumbnail') {
    if (imageTypes.test(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed for thumbnails'), false);
    }
  } else if (file.fieldname === 'video') {
    if (videoTypes.test(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported video format'), false);
    }
  } else {
    // Allow chunks (binary data)
    cb(null, true);
  }
};

const upload = multer({
  storage: videoStorage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024, // 5GB max per file
  },
});

module.exports = upload;
