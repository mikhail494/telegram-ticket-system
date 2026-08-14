import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type OperationalRuntimeState = "STARTING" | "READY" | "SHUTTING_DOWN" | "STOPPED";

export interface OperationalServerOptions {
  host: string;
  port: number;
  getState(): OperationalRuntimeState;
  checkDatabase(): boolean;
}

export class OperationalServer {
  private server: Server | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly options: OperationalServerOptions) {}

  get port(): number | null {
    const address = this.server?.address();
    return address && typeof address !== "string" ? address.port : null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => this.handleRequest(request, response));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.options.port, this.options.host);
      });
    } catch (error) {
      this.server = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.stopPromise = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }).finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    request.resume();
    if (request.method !== "GET" && request.method !== "HEAD") {
      this.respond(response, request.method, 405, "text/plain; charset=utf-8", "Method Not Allowed");
      return;
    }

    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/healthz") {
      this.respond(response, request.method, 200, "application/json; charset=utf-8", '{"status":"ok"}');
      return;
    }
    if (pathname === "/readyz") {
      const ready = this.isReady();
      this.respond(response, request.method, ready ? 200 : 503, "application/json; charset=utf-8", ready ? '{"status":"ready"}' : '{"status":"not_ready"}');
      return;
    }
    if (pathname === "/metrics") {
      this.respond(response, request.method, 200, "text/plain; version=0.0.4; charset=utf-8", this.metrics());
      return;
    }

    this.respond(response, request.method, 404, "text/plain; charset=utf-8", "Not Found");
  }

  private isReady(): boolean {
    return this.options.getState() === "READY" && this.databaseReady();
  }

  private databaseReady(): boolean {
    try {
      return this.options.checkDatabase();
    } catch {
      return false;
    }
  }

  private metrics(): string {
    const databaseReady = this.databaseReady();
    const ready = this.options.getState() === "READY" && databaseReady;
    const memory = process.memoryUsage();
    return [
      "# HELP telegram_support_up Whether the operational HTTP server is running.",
      "# TYPE telegram_support_up gauge",
      "telegram_support_up 1",
      "# HELP telegram_support_ready Whether Telegram support runtime is ready to serve work.",
      "# TYPE telegram_support_ready gauge",
      `telegram_support_ready ${ready ? 1 : 0}`,
      "# HELP telegram_support_process_uptime_seconds Process uptime in seconds.",
      "# TYPE telegram_support_process_uptime_seconds gauge",
      `telegram_support_process_uptime_seconds ${process.uptime()}`,
      "# HELP telegram_support_process_resident_memory_bytes Process resident memory in bytes.",
      "# TYPE telegram_support_process_resident_memory_bytes gauge",
      `telegram_support_process_resident_memory_bytes ${memory.rss}`,
      "# HELP telegram_support_process_heap_used_bytes Process heap used in bytes.",
      "# TYPE telegram_support_process_heap_used_bytes gauge",
      `telegram_support_process_heap_used_bytes ${memory.heapUsed}`,
      "# HELP telegram_support_process_heap_total_bytes Process heap total in bytes.",
      "# TYPE telegram_support_process_heap_total_bytes gauge",
      `telegram_support_process_heap_total_bytes ${memory.heapTotal}`,
      "# HELP telegram_support_database_ready Whether the local SQLite probe succeeds.",
      "# TYPE telegram_support_database_ready gauge",
      `telegram_support_database_ready ${databaseReady ? 1 : 0}`,
      ""
    ].join("\n");
  }

  private respond(response: ServerResponse, method: string | undefined, status: number, contentType: string, body: string): void {
    response.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
    response.end(method === "HEAD" ? undefined : body);
  }
}
