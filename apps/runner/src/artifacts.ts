import { readFile } from "node:fs/promises";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { RunnerEnv } from "./config.js";

/**
 * Artifact store (doc 01 §2: S3-compatible; MinIO locally). Keys follow
 * runs/<runId>/<flowId>/<target>/<name> so the api can render presigned links.
 */
export interface ArtifactStore {
  putFile(key: string, filePath: string, contentType?: string): Promise<string>;
  putBuffer(key: string, data: Buffer | string, contentType?: string): Promise<string>;
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
}

/** For --no-upload CLI runs and unit tests. */
export class NullArtifactStore implements ArtifactStore {
  uploads: string[] = [];
  async putFile(key: string): Promise<string> {
    this.uploads.push(key);
    return key;
  }
  async putBuffer(key: string): Promise<string> {
    this.uploads.push(key);
    return key;
  }
}

export function artifactKey(
  job: { runId: string; flowId: string; target: { kind: string } },
  name: string,
): string {
  return `runs/${job.runId}/${job.flowId}/${job.target.kind}/${name}`;
}
