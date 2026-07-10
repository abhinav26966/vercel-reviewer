import { Queue } from "bullmq";
const q = new Queue("orchestrate", { connection: { host: "localhost", port: 6379, maxRetriesPerRequest: null } });
await q.add("control", { kind: "validate", versionId: process.argv[2] }, { removeOnComplete: true });
await q.close();
console.log("validation enqueued for", process.argv[2]);
