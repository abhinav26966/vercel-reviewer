"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Project {
  id: string;
  name: string;
  githubRepo: string;
  baseBranches: string[];
}

export default function HomePage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Project[]>("/api/projects").then(setProjects).catch((e) => setError(String(e)));
  }, []);

  return (
    <main>
      <h1>Projects</h1>
      {error ? <p className="error">API unreachable: {error}</p> : null}
      {projects === null ? (
        <p className="muted">loading…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Repo</th>
              <th>Base branches</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link href={`/projects/${p.id}`}>{p.name}</Link>
                </td>
                <td>{p.githubRepo}</td>
                <td>{p.baseBranches.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
