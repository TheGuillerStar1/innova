const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs').promises;

class CloudflareStorageService {
  constructor() {
    // Extraer Account ID del endpoint
    const accountId = process.env.CLOUDFLARE_R2_ENDPOINT.split('//')[1].split('.')[0];
    const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
        secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true
    });

    this.bucket = process.env.CLOUDFLARE_PROYECTOS_BUCKET;
    this.publicUrl = process.env.CLOUDFLARE_PROYECTOS_PUBLIC_URL;
  }

  async saveFile(file, type = 'property') {
    try {
      // Soporte para multer (path o buffer)
      const fileBuffer = file.path ? await fs.readFile(file.path) : file.buffer;
      
      // Definir "subcarpeta" en el bucket
      const folder = type === 'proyecto-variacion' ? 'variaciones' : 'principales';
      const key = `${folder}/${file.originalname}`;

      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fileBuffer,
        ContentType: file.mimetype
      });

      await this.s3Client.send(command);

      // Limpiar temporal si existe
      if (file.path) {
        await fs.unlink(file.path).catch(err => console.warn('Error cleanup:', err));
      }

      return {
        success: true,
        filename: file.originalname,
        publicUrl: `${this.publicUrl}/${key}`
      };
    } catch (error) {
      console.error('Error R2 Save:', error);
      throw error;
    }
  }

  async deleteFile(filename, type = 'property') {
    try {
      const folder = type === 'proyecto-variacion' ? 'variaciones' : 'principales';
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: `${folder}/${filename}`
      });
      await this.s3Client.send(command);
      return { success: true };
    } catch (error) {
      console.error('Error R2 Delete:', error);
      throw error;
    }
  }
}

module.exports = new CloudflareStorageService();