import type { MessagePort } from "node:worker_threads";
export interface FrontendHubSettings {
    port: number;
    host?: string;
    base_url: string;
    auth_token?: string;
    ssl_key?: string;
    ssl_cert?: string;
    /** Public URL of the combined frontend, used for Home Assistant `configuration_url`. */
    url?: string;
}
export interface FrontendHubInstance {
    name: string;
    dataPath: string;
}
export interface FrontendHubLogger {
    info: (message: string) => void;
    warning: (message: string) => void;
    error: (message: string) => void;
}
export declare const FRONTEND_HUB_DEFAULTS: FrontendHubSettings;
/**
 * Combined frontend for multi-coordinator mode: serves a single `zigbee2mqtt-windfront` UI showing all coordinators,
 * and proxies its per-coordinator WebSocket connections (`<base_url>/<instance>/api`) to the `Frontend` extension of
 * the matching instance over a `MessagePort`.
 */
export declare class FrontendHub {
    private readonly settings;
    private readonly instances;
    private readonly logger;
    private server;
    private wss;
    private readonly ports;
    private readonly sockets;
    private nextSocketId;
    constructor(settings: Partial<FrontendHubSettings>, instances: readonly FrontendHubInstance[], logger: FrontendHubLogger);
    start(): Promise<void>;
    stop(): Promise<void>;
    /** Connects the `Frontend` extension of `instance` (other end of `port`) to the browsers targeting that instance. */
    attach(instance: string, port: MessagePort): void;
    /** Disconnects `instance` (stopped/crashed), the frontend will reconnect on its own once it is attached again. */
    detach(instance: string): void;
    /**
     * `zigbee2mqtt-windfront` reads `Z2M_API_URLS`/`Z2M_API_NAMES` from a tiny module where they are left as `${...}`
     * placeholders (replaced with `envsubst` in the standalone image, falling back to `<host>/<path>/api` when untouched).
     * Replace them with the instances of this hub, computing the API URLs in the browser relative to the page so this
     * works whatever host name, port or reverse proxy is used to reach the hub.
     */
    private buildEnvsModule;
    /** Device icons are per instance (`<data_dir>/device_icons`), the first instance having the file serves it. */
    private findDeviceIconInstance;
    private onUpgrade;
    private onConnection;
    private onInstanceMessage;
    private closeSockets;
}
//# sourceMappingURL=frontendHub.d.ts.map