import assert from "node:assert";
import {existsSync, readFileSync} from "node:fs";
import type {IncomingMessage, Server, ServerResponse} from "node:http";
import {createServer} from "node:http";
import {createServer as createSecureServer} from "node:https";
import type {Socket} from "node:net";
import {posix} from "node:path";
import type {MessagePort} from "node:worker_threads";
import bind from "bind-decorator";
import WebSocket from "ws";
import data from "../util/data";
import {getInstanceContext, type HubToInstanceMessage, type InstanceToHubMessage} from "../util/instanceContext";
import logger from "../util/logger";
import * as settings from "../util/settings";
import {createStaticFileServer, sendNotFound} from "../util/staticFileServer";
import {stringify} from "../util/stringify";
import utils from "../util/utils";
import Extension from "./extension";

/**
 * This extension servers the frontend.
 *
 * In multi-coordinator mode the UI is served by the supervisor (combined frontend for all coordinators), and this
 * extension only bridges the browser connections handed over through a `MessagePort` to the MQTT layer of this instance.
 */
export class Frontend extends Extension {
    private mqttBaseTopic: string;
    private server: Server | undefined;
    private wss: WebSocket.Server | undefined;
    private baseUrl: string;
    /** Channel to the combined frontend, only set in multi-coordinator mode. */
    private hubPort: MessagePort | undefined;
    /** Browser connections currently open through the combined frontend. */
    private hubClients = new Set<number>();

    constructor(
        zigbee: Zigbee,
        mqtt: Mqtt,
        state: State,
        publishEntityState: PublishEntityState,
        eventBus: EventBus,
        enableDisableExtension: (enable: boolean, name: string) => Promise<void>,
        restartCallback: () => Promise<void>,
        addExtension: (extension: Extension) => Promise<void>,
    ) {
        super(zigbee, mqtt, state, publishEntityState, eventBus, enableDisableExtension, restartCallback, addExtension);

        const frontendSettings = settings.get().frontend;
        this.hubPort = getInstanceContext()?.frontendPort;
        assert(this.hubPort || frontendSettings.enabled, `Frontend extension created with setting 'enabled: false'`);
        this.baseUrl = frontendSettings.base_url;
        this.mqttBaseTopic = settings.get().mqtt.base_topic;
    }

    override async start(): Promise<void> {
        if (this.hubPort) {
            this.hubPort.on("message", this.onHubMessage);
            logger.info("Frontend attached to the combined frontend of the supervisor");
        } else if (settings.get().frontend.disable_ui_serving) {
            const {host, port} = settings.get().frontend;
            this.wss = new WebSocket.Server({port, host, path: posix.join(this.baseUrl, "api")});

            logger.info(
                /* v8 ignore next */
                `Frontend UI serving is disabled. WebSocket at: ${this.wss.options.host ?? "0.0.0.0"}:${this.wss.options.port}${this.wss.options.path}`,
            );
        } else {
            const {host, port, ssl_key: sslKey, ssl_cert: sslCert} = settings.get().frontend;
            const hasSSL = (val: string | undefined, key: string): val is string => {
                if (val) {
                    if (existsSync(val)) {
                        return true;
                    }

                    logger.error(`Defined ${key} '${val}' file path does not exists, server won't be secured.`);
                }

                return false;
            };
            const frontend = (await import(settings.get().frontend.package)) as typeof import("zigbee2mqtt-frontend");
            const logError = logger.error.bind(logger);
            const fileServer = createStaticFileServer(frontend.default.getPath(), logError);
            const deviceIconsFileServer = createStaticFileServer(data.joinPath("device_icons"), logError);
            const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
                // biome-ignore lint/style/noNonNullAssertion: `Only valid for request obtained from Server`
                const url = request.url!;
                const newUrl = posix.relative(this.baseUrl, url);

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

                request.url = `/${newUrl}`;

                if (newUrl.startsWith("device_icons/")) {
                    request.url = request.url.replace("/device_icons", "");

                    deviceIconsFileServer(request, response);
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
                logger.info(`Started frontend on port ${port}`);
            } else if (host.startsWith("/")) {
                this.server.listen(host);
                logger.info(`Started frontend on socket ${host}`);
            } else {
                this.server.listen(port, host);
                logger.info(`Started frontend on port ${host}:${port}`);
            }

            this.wss = new WebSocket.Server({noServer: true, path: posix.join(this.baseUrl, "api")});
        }

        this.wss?.on("connection", this.onWebSocketConnection);

        this.eventBus.onMQTTMessagePublished(this, this.onMQTTPublishMessageOrEntityState);
        this.eventBus.onPublishEntityState(this, this.onMQTTPublishMessageOrEntityState);
    }

    override async stop(): Promise<void> {
        await super.stop();

        const offline = stringify({topic: "bridge/state", payload: {state: "offline"}});

        if (this.hubPort) {
            this.hubPort.off("message", this.onHubMessage);
            this.postToHub({type: "closeAll", data: offline});
            this.hubClients.clear();
        }

        if (this.wss) {
            for (const client of this.wss.clients) {
                client.send(offline);
                client.terminate();
            }

            this.wss.close();
        }

        await new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve(undefined)));
    }

    private postToHub(message: InstanceToHubMessage): void {
        // biome-ignore lint/style/noNonNullAssertion: only called when attached to the hub
        this.hubPort!.postMessage(message);
    }

    @bind private onHubMessage(message: HubToInstanceMessage): void {
        switch (message.type) {
            case "open": {
                this.hubClients.add(message.id);
                this.sendInitialState((data) => this.postToHub({type: "send", id: message.id, data}));
                break;
            }
            case "message": {
                if (this.hubClients.has(message.id)) {
                    this.onClientMessage(message.data);
                }
                break;
            }
            case "close": {
                this.hubClients.delete(message.id);
                break;
            }
        }
    }

    /** Message received from a browser: `{topic, payload}` relative to the base topic, injected as MQTT message. */
    private onClientMessage(message: string): void {
        const {topic, payload} = JSON.parse(message);
        this.mqtt.onMessage(`${this.mqttBaseTopic}/${topic}`, Buffer.from(stringify(payload)));
    }

    /** Sends retained messages and the current state of all devices to a newly connected browser. */
    private sendInitialState(send: (data: string) => void): void {
        for (const [topic, payload] of Object.entries(this.mqtt.retainedMessages)) {
            if (topic.startsWith(`${this.mqttBaseTopic}/`)) {
                send(
                    stringify({
                        // Send topic without base_topic
                        topic: topic.substring(this.mqttBaseTopic.length + 1),
                        payload: utils.parseJSON(payload.payload, payload.payload),
                    }),
                );
            }
        }

        for (const device of this.zigbee.devicesIterator(utils.deviceNotCoordinator)) {
            const payload = this.state.get(device);
            const lastSeen = settings.get().advanced.last_seen;

            if (lastSeen !== "disable") {
                payload.last_seen = utils.formatDate(device.zh.lastSeen ?? /* v8 ignore next */ 0, lastSeen);
            }

            if (device.zh.linkquality !== undefined) {
                payload.linkquality = device.zh.linkquality;
            }

            send(stringify({topic: device.name, payload}));
        }
    }

    @bind private onUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
        // biome-ignore lint/style/noNonNullAssertion: only registered when serving the UI, `wss` is always created then
        const wss = this.wss!;

        wss.handleUpgrade(request, socket, head, (ws) => {
            // biome-ignore lint/style/noNonNullAssertion: `Only valid for request obtained from Server`
            const {searchParams} = new URL(request.url!, "http://localhost"); // dummy base, may not be absolute
            const authToken = settings.get().frontend.auth_token;

            if (!authToken || authToken === searchParams.get("token")) {
                wss.emit("connection", ws, request);
            } else {
                ws.close(4401, "Unauthorized");
            }
        });
    }

    @bind private onWebSocketConnection(ws: WebSocket): void {
        ws.on("error", (msg) => logger.error(`WebSocket error: ${msg.message}`));
        ws.on("message", (data: Buffer, isBinary: boolean) => {
            if (!isBinary && data) {
                this.onClientMessage(data.toString());
            }
        });

        this.sendInitialState((data) => ws.send(data));
    }

    @bind private onMQTTPublishMessageOrEntityState(data: eventdata.MQTTMessagePublished | eventdata.PublishEntityState): void {
        let topic: string;
        let payload: KeyValue | string;

        if ("topic" in data) {
            // MQTTMessagePublished
            if (data.options.meta.isEntityState || !data.topic.startsWith(`${this.mqttBaseTopic}/`)) {
                // Don't send entity state to frontend on `MQTTMessagePublished` event, this is handled by
                // `PublishEntityState` instead. Reason for this is to skip attribute messages when `output` is
                // set to `attribute` or `attribute_and_json`, we only want to send JSON entity states to the
                // frontend.
                return;
            }
            // Send topic without base_topic
            topic = data.topic.substring(this.mqttBaseTopic.length + 1);
            payload = utils.parseJSON(data.payload, data.payload);
        } else {
            // PublishEntityState
            topic = data.entity.name;
            payload = data.message;
        }

        const message = stringify({topic, payload});

        if (this.hubPort && this.hubClients.size > 0) {
            this.postToHub({type: "broadcast", data: message});
        }

        if (this.wss) {
            for (const client of this.wss.clients) {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(message);
                }
            }
        }
    }
}

export default Frontend;
