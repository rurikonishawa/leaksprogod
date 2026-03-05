const multer = require('multer');
const path = require('path');
const os = require('os');

// Use OS temp directory — files are uploaded to Cloudinary then deleted
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, os.tmpdir());
  },
  filename: (req, file, cb) => {
    const uniqueName = `leakspro_${Date.now()}_${file.originalname}`;
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
    cb(null, true);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024, // 5GB max per file
  },
});

module.exports = upload;
