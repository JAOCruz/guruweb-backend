const fs = require('fs');
const path = require('path');

const DEFAULT_MOUNT_PATH = '/data/guru-files';

function getStorageRoot() {
  return process.env.RAILWAY_VOLUME_MOUNT_PATH || DEFAULT_MOUNT_PATH;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getDir(subdir) {
  const root = getStorageRoot();
  const dir = path.join(root, subdir.replace(/^\/+|\/+$/, ''));
  return ensureDir(dir);
}

function getFilePath(subdir, filename) {
  const safeFilename = path.basename(filename).replace(/^\/+/, '');
  return path.join(getDir(subdir), safeFilename);
}

function saveBuffer(buffer, subdir, filename) {
  const filePath = getFilePath(subdir, filename);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function saveLocalFile(localPath, subdir, filename) {
  const buffer = fs.readFileSync(localPath);
  return saveBuffer(buffer, subdir, filename);
}

function fileExists(subdir, filename) {
  try {
    return fs.existsSync(getFilePath(subdir, filename));
  } catch {
    return false;
  }
}

function getRelativePath(subdir, filename) {
  return path.join(subdir, path.basename(filename));
}

module.exports = {
  getStorageRoot,
  getDir,
  getFilePath,
  saveBuffer,
  saveLocalFile,
  fileExists,
  getRelativePath,
};
