const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function isS3Configured() {
  return !!(
    process.env.S3_BUCKET &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY
  );
}

const s3Client = isS3Configured()
  ? new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: !!process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    })
  : null;

function getS3Key(prefix, filename) {
  const safePrefix = prefix.replace(/(^\/+|\/+$)/g, '');
  const safeFilename = filename.replace(/^\/+/, '');
  return `${safePrefix}/${safeFilename}`;
}

async function uploadFile(bufferOrStream, key, contentType = 'application/octet-stream') {
  if (!s3Client) throw new Error('S3 is not configured');

  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: bufferOrStream,
    ContentType: contentType,
  });

  await s3Client.send(command);

  const endpoint = process.env.S3_ENDPOINT || `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com`;
  return {
    key,
    url: `${endpoint}/${key}`,
  };
}

async function uploadLocalFile(localPath, key, contentType = 'application/octet-stream') {
  const fs = require('fs');
  const buffer = fs.readFileSync(localPath);
  return uploadFile(buffer, key, contentType);
}

async function getSignedDownloadUrl(key, expiresInSeconds = 3600) {
  if (!s3Client) throw new Error('S3 is not configured');
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
  });
  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

module.exports = {
  isS3Configured,
  s3Client,
  getS3Key,
  uploadFile,
  uploadLocalFile,
  getSignedDownloadUrl,
};
