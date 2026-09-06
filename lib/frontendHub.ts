import {existsSync, readdirSync, readFileSync} from "node:fs";
import type {IncomingMessage, Server, ServerResponse} from "node:http";
import {createServer} from "node:http";
import {createServer as createSecureServer} from "node:https";
import type {Socket} from "node:net";
import path, {posix} from "node:path";
import type {MessagePort} from "node:worker_threads";
import bind from "bind-decorator";
import WebSocket from "ws";
import type {HubToInstanceMessage, InstanceToHubMessage} from "./util/instanceContext";
import {createStaticFileServer, type StaticFileServer, sendNotFound} from "./util/staticFileServer";

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

export const FRONTEND_HUB_DEFAULTS: FrontendHubSettings = {port: 8080, base_url: "/"};

/** WebSocket close code sent to browsers when the instance they are connected to is (re)starting. */
const CLOSE_SERVICE_RESTART = 1012;
/** WebSocket close code sent to browsers when the auth token is missing/invalid, the frontend asks for a token on this code. */
const CLOSE_UNAUTHORIZED = 4401;
/** `zigbee2mqtt-windfront` reads its runtime configuration from this module (placeholders meant for `envsubst`). */
const ENVS_ASSET_REGEX = /^assets\/envs-[\w-]+\.js$/;
const ENVS_FILE_REGEX = /^envs-[\w-]+\.js$/;

/**
 * Combined frontend for multi-coordinator mode: serves a single `zigbee2mqtt-windfront` UI showing all coordinators,
 * and proxies its per-coordinator WebSocket connections (`<base_url>/<instance>/api`) to the `Frontend` extension of
 * the matching instance over a `MessagePort`.
 */
export class FrontendHub {
    private readonly settings: FrontendHubSettings;
    private readonly instances: readonly FrontendHubInstance[];
    private readonly logger: FrontendHubLogger;
    private server: Server | undefined;
    private wss: WebSocket.Server | undefined;
    private readonly ports = new Map<string, MessagePort>();
    private readonly sockets = new Map<string, Map<number, WebSocket>>();
    private nextSocketId = 1;

    constructor(settings: Partial<FrontendHubSettings>, instances: readonly FrontendHubInstance[], logger: FrontendHubLogger) {
        this.settings = {...FRONTEND_HUB_DEFAULTS, ...settings};
        this.instances = instances;
        this.logger = logger;

        for (const instance of instances) {
            this.sockets.set(instance.name, new Map());
        }
    }

    async start(): Promise<void> {
        const {host, port, ssl_key: sslKey, ssl_cert: sslCert} = this.settings;
        const hasSSL = (val: string | undefined, key: string): val is string => {
            if (val) {
                if (existsSync(val)) {
                    return true;
                }

                this.logger.error(`Defined ${key} '${val}' file path does not exists, server won't be secured.`);
            }

            return false;
        };
        const frontend = await import("zigbee2mqtt-windfront");
        const frontendPath = frontend.default.getPath();
        const logError = this.logger.error;
        const fileServer = createStaticFileServer(frontendPath, logError);
        const deviceIconsServers = new Map<string, StaticFileServer>();

        for (const instance of this.instances) {
            deviceIconsServers.set(instance.name, createStaticFileServer(path.join(instance.dataPath, "device_icons"), logError));
        }

        const envsModule = this.buildEnvsModule(frontendPath);
        const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
            // biome-ignore lint/style/noNonNullAssertion: `Only valid for request obtained from Server`
            const url = request.url!;
            const newUrl = posix.relative(this.settings.base_url, url);

            // The request url is not within the frontend base url, so the relative path starts with '..'
            if (newUrl.startsWith(".")) {
                sendNotFound(request, response);

                return;
            }

            // The base url itself is a directory, redirect to its trailing slash form so the browser resolves the
            // relative asset paths in `index.html` against the frontend root instead of against its parent.
            if (newUrl === "" && !url.endsWith("/")) {
                response.writeHead(301, {Location: `${url}/`});
                response.end();

                return;
            }

            if (ENVS_ASSET_REGEX.test(newUrl)) {
                response.writeHead(200, {
                    "Content-Type": "text/javascript; charset=utf-8",
                    "Content-Length": Buffer.byteLength(envsModule),
                    "Cache-Control": "no-store",
                });
                response.end(envsModule);

                return;
            }

            request.url = `/${newUrl}`;

            if (newUrl.startsWith("device_icons/")) {
                request.url = request.url.replace("/device_icons", "");

                const instance = this.findDeviceIconInstance(request.url);

                if (instance) {
                    // biome-ignore lint/style/noNonNullAssertion: created for every instance in `start`
                    deviceIconsServers.get(instance.name)!(request, response);
                } else {
                    sendNotFound(request, response);
                }
            } else {
                fileServer(request, response);
            }
        };

        if (hasSSL(sslKey, "ssl_key") && hasSSL(sslCert, "ssl_cert")) {
            const serverOptions = {key: readFileSync(sslKey), cert: readFileSync(sslCert)};
            this.server = createSecureServer(serverOptions, onRequest);
        } else {
            this.server = createServer(onRequest);
        }

        this.server.on("upgrade", this.onUpgrade);

        if (!host) {
            this.server.listen(port);
            this.logger.info(`Started combined frontend on port ${port}`);
        } else if (host.startsWith("/")) {
            this.server.listen(host);
            this.logger.info(`Started combined frontend on socket ${host}`);
        } else {
            this.server.listen(port, host);
            this.logger.info(`Started combined frontend on port ${host}:${port}`);
        }

        this.wss = new WebSocket.Server({noServer: true});
    }

    async stop(): Promise<void> {
        for (const name of this.ports.keys()) {
            this.detach(name);
        }

        this.wss?.close();
        this.wss = undefined;

        await new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve(undefined)));

        this.server = undefined;
    }

    /** Connects the `Frontend` extension of `instance` (other end of `port`) to the browsers targeting that instance. */
    attach(instance: string, port: MessagePort): void {
        this.detach(instance);
        this.ports.set(instance, port);
        port.on("message", (message: InstanceToHubMessage) => this.onInstanceMessage(instance, message));
    }

    /** Disconnects `instance` (stopped/crashed), the frontend will reconnect on its own once it is attached again. */
    detach(instance: string): void {
        const port = this.ports.get(instance);

        if (port) {
            port.close();
            this.ports.delete(instance);
        }

        this.closeSockets(instance, CLOSE_SERVICE_RESTART, "Instance not running");
    }

    /**
     * `zigbee2mqtt-windfront` reads `Z2M_API_URLS`/`Z2M_API_NAMES` from a tiny module where they are left as `${...}`
     * placeholders (replaced with `envsubst` in the standalone image, falling back to `<host>/<path>/api` when untouched).
     * Replace them with the instances of this hub, computing the API URLs in the browser relative to the page so this
     * works whatever host name, port or reverse proxy is used to reach the hub.
     */
    private buildEnvsModule(frontendPath: string): string {
        const assetsPath = path.join(frontendPath, "assets");
        const envsFile = existsSync(assetsPath) ? readdirSync(assetsPath).find((file) => ENVS_FILE_REGEX.test(file)) : undefined;

        if (!envsFile) {
            throw new Error(
                `Frontend package at '${frontendPath}' has no runtime configuration module, combined frontend requires 'zigbee2mqtt-windfront'`,
            );
        }

        const names = this.instances.map((instance) => instance.name);
        const apiUrls = `${JSON.stringify(names)}.map((n)=>\`\${window.location.host}\${window.location.pathname.replace(/\\/+$/,"")}/\${n}/api\`).join(",")`;

        const placeholder = (name: string): string => `"$\{${name}}"`;

        return readFileSync(path.join(assetsPath, envsFile), "utf8")
            .replace(placeholder("Z2M_API_URLS"), apiUrls)
            .replace(placeholder("Z2M_API_NAMES"), JSON.stringify(names.join(",")))
            .replace(placeholder("USE_PROXY"), '"false"');
    }

    /** Device icons are per instance (`<data_dir>/device_icons`), the first instance having the file serves it. */
    private findDeviceIconInstance(url: string): FrontendHubInstance | undefined {
        const relative = posix.normalize(decodeURIComponent(url.split("?")[0]));

        if (relative.startsWith("/..") || relative === "/") {
            return undefined;
        }

        return this.instances.find((instance) => existsSync(path.join(instance.dataPath, "device_icons", relative)));
    }

    @bind private onUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
        // biome-ignore lint/style/noNonNullAssertion: `Only valid for request obtained from Server`
        const {pathname, searchParams} = new URL(request.url!, "http://localhost"); // dummy base, may not be absolute
        const match = /^([\w-]+)\/api$/.exec(posix.relative(this.settings.base_url, pathname));
        const instance = match?.[1];

        if (!instance || !this.sockets.has(instance)) {
            socket.destroy();

            return;
        }

        // biome-ignore lint/style/noNonNullAssertion: only registered in `start` after `wss` is created
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
            const authToken = this.settings.auth_token;

            if (!authToken || authToken === searchParams.get("token")) {
                this.onConnection(instance, ws);
            } else {
                ws.close(CLOSE_UNAUTHORIZED, "Unauthorized");
            }
        });
    }

    private onConnection(instance: string, ws: WebSocket): void {
        const port = this.ports.get(instance);

        if (!port) {
            ws.close(CLOSE_SERVICE_RESTART, "Instance not running");

            return;
        }

        const id = this.nextSocketId++;
        // biome-ignore lint/style/noNonNullAssertion: validated in `onUpgrade`
        const sockets = this.sockets.get(instance)!;
        const post = (message: HubToInstanceMessage): void => {
            if (this.ports.get(instance) === port) {
                port.postMessage(message);
            }
        };

        sockets.set(id, ws);
        ws.on("error", (error) => this.logger.error(`WebSocket error (${instance}): ${error.message}`));
        ws.on("message", (data: Buffer, isBinary: boolean) => {
            if (!isBinary && data) {
                post({type: "message", id, data: data.toString()});
            }
        });
        ws.on("close", () => {
            if (sockets.delete(id)) {
                post({type: "close", id});
            }
        });
        post({type: "open", id});
    }

    private onInstanceMessage(instance: string, message: InstanceToHubMessage): void {
        // biome-ignore lint/style/noNonNullAssertion: only attached for known instances
        const sockets = this.sockets.get(instance)!;

        switch (message.type) {
            case "send": {
                const ws = sockets.get(message.id);

                if (ws?.readyState === WebSocket.OPEN) {
                    ws.send(message.data);
                }
                break;
            }
            case "broadcast": {
                for (const ws of sockets.values()) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(message.data);
                    }
                }
                break;
            }
            case "closeAll": {
                for (const ws of sockets.values()) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(message.data);
                    }
                }

                this.closeSockets(instance, CLOSE_SERVICE_RESTART, "Instance stopping");
                break;
            }
        }
    }

    private closeSockets(instance: string, code: number, reason: string): void {
        const sockets = this.sockets.get(instance);

        if (sockets) {
            const open = [...sockets.values()];

            // clear first so the `close` handlers don't post to the instance
            sockets.clear();

            for (const ws of open) {
                ws.close(code, reason);
            }
        }
    }
}
