import { readFile } from "node:fs/promises";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { RunnerEnv } from "./config.js";

/**
 * Artifact store (doc 01 §2: S3-compatible; MinIO locally). Keys follow
 * runs/<runId>/<flowId>/<target>/<name> so the api can render presigned links.
 */
export interface ArtifactStore {
  putFile(key: string, filePath: string, contentType?: string): Promise<string>;
  putBuffer(key: string, data: Buffer | string, contentType?: string): Promise<string>;
  getBuffer(key: string): Promise<Buffer>;
}

export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3Client;
  constructor(private readonly env: RunnerEnv) {
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async putFile(key: string, filePath: string, contentType?: string): Promise<string> {
    const body = await readFile(filePath);
    return this.putBuffer(key, body, contentType);
  }

  async putBuffer(key: string, data: Buffer | string, contentType?: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: key,
        Body: typeof data === "string" ? Buffer.from(data) : data,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
    return key;
  }

  async getBuffer(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }),
    );
    return Buffer.from(await res.Body!.transformToByteArray());
  }
}

/** For --no-upload CLI runs and unit tests. */
export class NullArtifactStore implements ArtifactStore {
  uploads: string[] = [];
  objects = new Map<string, Buffer>();
  async putFile(key: string, filePath: string): Promise<string> {
    this.uploads.push(key);
    this.objects.set(key, await readFile(filePath).catch(() => Buffer.alloc(0)));
    return key;
  }
  async putBuffer(key: string, data: Buffer | string): Promise<string> {
    this.uploads.push(key);
    this.objects.set(key, typeof data === "string" ? Buffer.from(data) : data);
    return key;
  }
  async getBuffer(key: string): Promise<Buffer> {
    const v = this.objects.get(key);
    if (!v) throw new Error(`no such object: ${key}`);
    return v;
  }
}

export function artifactKey(
  job: { runId: string; flowId: string; target: { kind: string } },
  name: string,
): string {
  return `runs/${job.runId}/${job.flowId}/${job.target.kind}/${name}`;
}
