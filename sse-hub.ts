/**
 * SSE Hub for Command Center
 *
 * Central pub/sub for Server-Sent Events.
 * Events are scoped per project and broadcast to all connected clients.
 */
import type http from "node:http";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SseEvent {
  ts: string;
  type: string;
  payload: unknown;
}

interface SseClient {
  res: http.ServerResponse;
  projectId: string;
}

/* ------------------------------------------------------------------ */
/*  Hub                                                                */
/* ------------------------------------------------------------------ */

export class SseHub {
  private readonly clients = new Set<SseClient>();
  private readonly history: SseEvent[] = [];
  private static readonly MAX_HISTORY = 200;

  /** Register a new SSE client. Replays recent history for the project. */
  addClient(res: http.ServerResponse, projectId: string): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    const client: SseClient = { res, projectId };
    this.clients.add(client);

    // Replay last 50 events for this project
    const projectHistory = this.history.filter((e) => (e as any)._projectId === projectId).slice(-50);
    for (const event of projectHistory) {
      this.writeEvent(res, event);
    }

    const cleanup = () => this.clients.delete(client);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  /** Publish an event to all clients subscribed to a project. */
  publish(projectId: string, type: string, payload: unknown): void {
    const event: SseEvent & { _projectId?: string } = {
      ts: new Date().toISOString(),
      type,
      payload,
    };

    // Store with project tag for history replay (stripped before sending)
    const stored = { ...event, _projectId: projectId };
    this.history.push(stored);
    if (this.history.length > SseHub.MAX_HISTORY) {
      this.history.splice(0, this.history.length - SseHub.MAX_HISTORY);
    }

    for (const client of this.clients) {
      if (client.projectId === projectId) {
        this.writeEvent(client.res, event);
      }
    }
  }

  /** Number of connected clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  private writeEvent(res: http.ServerResponse, event: SseEvent): void {
    const { _projectId, ...clean } = event as SseEvent & { _projectId?: string };
    res.write(`data: ${JSON.stringify(clean)}\n\n`);
  }
}
