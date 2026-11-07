/**
 * Checks the S3 storage driver against any S3-compatible endpoint (MinIO, moto, AWS):
 *   STORAGE=s3 S3_ENDPOINT=http://localhost:5001 S3_BUCKET=opensheet \
 *   S3_ACCESS_KEY_ID=x S3_SECRET_ACCESS_KEY=y npx tsx loadtest/s3-check.ts
 */
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../src/config';
import { storage } from '../src/services/storage';

async function main() {
  const client = new S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  });
  await client.send(new CreateBucketCommand({ Bucket: config.s3.bucket })).catch(() => undefined);
  const data = Buffer.from(`uji s3 ${Date.now()}`);
  const key = await storage!.put(data);
  const back = await storage!.get(key);
  console.log(`stored ${key}; round trip ${Buffer.compare(back, data) === 0 ? 'OK' : 'MISMATCH'}`);
}
main();
